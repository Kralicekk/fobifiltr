// Content script na YouTube. Hlídá přehrávané video dvěma způsoby:
// 1) storyboard: projde náhledy celého videa dopředu, takže ví o pavoukovi dřív, než přijde,
// 2) živá kontrola: několikrát za sekundu pošle AI aktuální snímek jako pojistku mezi náhledy.
(() => {
  'use strict';
  const F = self.FOBI;
  // Na grafice trvá snímek ~50 ms, na procesoru ~400 ms. Mezi kontrolami vždy aspoň dvojnásobek,
  // ať AI nevytíží počítač a zbude čas na storyboard a náhledy.
  const LIVE_MIN_MS = 250;
  // Na procesoru po jednom náhledu, ať živý snímek nečeká ve frontě za dlouhou dávkou.
  const batchSize = () => (engine.device === 'GPU' ? 4 : 1);
  const NEAR_S = 30; // tolik s před přehrávanou pozicí má přednost před náhledy na stránce
  const CAPTURE_LONG_SIDE = 384;
  const HIT_BEFORE = 1; // s před zachyceným snímkem
  const HIT_AFTER = 3; // s po něm
  const REVEAL_MS = 10000;

  let settings = { ...F.DEFAULTS };
  let engine = { state: 'idle' };
  let vs = null; // stav aktuálního videa
  let liveBusy = false;
  let scanBusy = false;
  let lastLiveAt = 0;
  let engineAskedAt = 0;
  let badge = null;
  let lastDebug = 0;

  const capCanvas = new OffscreenCanvas(1, 1);
  const capCtx = capCanvas.getContext('2d');
  const reader = (blob) =>
    new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });

  chrome.storage.sync.get(F.DEFAULTS, (s) => {
    settings = { ...F.DEFAULTS, ...s };
  });
  chrome.storage.local.get({ engineStatus: null }, (s) => {
    if (s.engineStatus) engine = s.engineStatus;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') for (const k in changes) settings[k] = changes[k].newValue ?? F.DEFAULTS[k];
    if (area === 'local' && changes.engineStatus) engine = changes.engineStatus.newValue || { state: 'idle' };
  });

  // ---------- pomocné ----------

  function ensureEngine() {
    if (Date.now() - engineAskedAt < 5000) return;
    engineAskedAt = Date.now();
    chrome.runtime.sendMessage({ to: 'bg', type: 'ensure-engine' }).catch(() => {});
  }

  function onEngineError(e) {
    const text = String(e?.message || e);
    // Offscreen dokument zmizel (restart prohlížeče, pád): nechat ho založit znovu.
    if (/Receiving end|message port closed|Extension context/i.test(text)) {
      engine = { state: 'idle' };
      ensureEngine();
    }
  }

  function findVideo() {
    if (location.pathname.startsWith('/shorts/')) {
      const v = document.querySelector('#shorts-player video');
      if (v) return v;
    }
    // Největší viditelné video: na stránce videa hlavní přehrávač, na hlavní stránce náhled po najetí myší.
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (w > 0 && h > 0 && w * h > bestArea) {
        bestArea = w * h;
        best = v;
      }
    }
    return best || document.querySelector('#movie_player video.html5-main-video');
  }

  function videoKey() {
    const u = new URL(location.href);
    if (u.pathname === '/watch' && u.searchParams.get('v')) return 'v:' + u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
    if (m) return 'v:' + m[2];
    return 'p:' + u.pathname;
  }

  function threshold() {
    return F.SENSITIVITY[settings.sensitivity] ?? F.SENSITIVITY.medium;
  }

  // Vrátí id kategorie, kvůli které je potřeba snímek skrýt, nebo null.
  function matchLabel(scores) {
    if (!scores) return null;
    let best = null;
    let bestScore = threshold();
    const ids = [...settings.categories, ...settings.custom.map((w) => 'custom:' + w)];
    for (const id of ids) {
      const s = scores[id] || 0;
      if (s >= bestScore) {
        bestScore = s;
        best = id;
      }
    }
    return best;
  }

  function labelName(id) {
    if (id.startsWith('custom:')) return id.slice(7);
    return F.CATEGORIES.find((c) => c.id === id)?.label || id;
  }

  // ---------- storyboard ----------

  // Formát specu: base_url|šířka#výška#počet#sloupce#řádky#interval#jméno#podpis|... (jedna část za úroveň)
  function parseSpec(spec, duration) {
    const parts = spec.split('|');
    const base = parts[0];
    let best = null;
    for (let i = 1; i < parts.length; i++) {
      const a = parts[i].split('#');
      if (a.length < 8) continue;
      const [w, h, count, cols, rows] = a.slice(0, 5).map(Number);
      if (!(w && h && count && cols && rows)) continue;
      if (!best || w > best.w) best = { level: i - 1, w, h, count, cols, rows, name: a[6], sigh: a[7] };
    }
    if (!best || best.w < 100 || !duration) return null;
    const template = base.replace('$L', String(best.level)).replace('$N', best.name) + '&sigh=' + best.sigh;
    return { ...best, dt: duration / best.count, url: (sheet) => template.replace('$M', String(sheet)) };
  }

  function requestStoryboard() {
    if (vs?.id) window.postMessage({ __fobi: 'get-storyboard', videoId: vs.id }, '*');
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__fobi !== 'storyboard') return;
    if (!vs || e.data.want !== vs.id || vs.sbState !== 'pending') return;
    if (e.data.videoId !== vs.id) {
      // Přehrávač ještě drží data předchozího videa, zkusit za chvíli znovu.
      if (++vs.sbTries < 20) setTimeout(requestStoryboard, 1000);
      else vs.sbState = 'none';
      return;
    }
    const duration = e.data.lengthSeconds || vs.video?.duration || 0;
    const sb = e.data.spec && !e.data.isLive ? parseSpec(e.data.spec, duration) : null;
    vs.sb = sb;
    vs.thumbs = sb ? new Array(sb.count) : null;
    vs.sbState = sb ? 'ok' : 'none';
  });

  async function scanStep() {
    const st = vs;
    const sb = st.sb;
    const perSheet = sb.cols * sb.rows;
    // Během reklamy běží čas reklamy, skenovat od místa, kde video skončilo (nebo začne).
    const start = Math.max(0, Math.floor(st.contentT / sb.dt) - 1);
    let first = -1;
    for (let i = 0; i < sb.count; i++) {
      const k = (start + i) % sb.count;
      if (!st.thumbs[k]) {
        first = k;
        break;
      }
    }
    if (first < 0) {
      st.scanDone = true;
      return;
    }
    const sheet = Math.floor(first / perSheet);
    const ks = [];
    for (let k = first; k < sb.count && ks.length < batchSize() && Math.floor(k / perSheet) === sheet; k++) {
      if (!st.thumbs[k]) ks.push(k);
    }
    const cells = ks.map((k) => {
      const idx = k % perSheet;
      return { x: (idx % sb.cols) * sb.w, y: Math.floor(idx / sb.cols) * sb.h, w: sb.w, h: sb.h };
    });
    scanBusy = true;
    try {
      const r = await chrome.runtime.sendMessage({
        to: 'engine',
        type: 'classify-cells',
        sheetUrl: sb.url(sheet),
        cells,
        custom: settings.custom,
        near: first * sb.dt - st.contentT < NEAR_S,
      });
      if (st !== vs || st.sb !== sb) return;
      if (!r?.ok) throw new Error(r?.error || 'Engine neodpověděl');
      ks.forEach((k, i) => {
        st.thumbs[k] = r.results[i];
      });
      st.scanMs = r.ms;
    } catch (e) {
      if (st === vs && ++st.scanErrors > 3) {
        // Náhledy nejdou stáhnout: dál jen živá kontrola.
        st.sb = null;
        st.thumbs = null;
        st.sbState = 'failed';
      }
      onEngineError(e);
    } finally {
      scanBusy = false;
    }
  }

  // ---------- živá kontrola ----------

  async function liveCheck(video, t, isAd) {
    const st = vs;
    liveBusy = true;
    lastLiveAt = Date.now();
    try {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const scale = CAPTURE_LONG_SIDE / Math.max(vw, vh);
      const w = Math.round(vw * scale);
      const h = Math.round(vh * scale);
      // Asynchronně: zmenšení snímku a JPEG neblokují stránku, video se nezasekne.
      const bmp = await createImageBitmap(video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
      if (capCanvas.width !== w || capCanvas.height !== h) {
        capCanvas.width = w;
        capCanvas.height = h;
      }
      capCtx.drawImage(bmp, 0, 0);
      bmp.close();
      const image = await reader(await capCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }));
      const r = await chrome.runtime.sendMessage({ to: 'engine', type: 'classify-frame', image, custom: settings.custom });
      if (st !== vs) return;
      if (!r?.ok) throw new Error(r?.error || 'Engine neodpověděl');
      st.liveChecked = true;
      st.lastLiveAd = isAd;
      st.lastLiveT = t;
      st.lastScores = r.scores;
      st.liveMs = r.ms;
      if (matchLabel(r.scores)) {
        // Reklama má vlastní časovou osu, její nálezy nesmí skrývat stejný čas ve videu.
        st.hits.push({ t, scores: r.scores, ad: isAd });
        if (st.hits.length > 500) st.hits.shift();
      }
    } catch (e) {
      onEngineError(e);
    } finally {
      liveBusy = false;
    }
  }

  // ---------- rozhodnutí: skrýt, nebo ne ----------

  function hideReason(t, isAd) {
    if (Date.now() < vs.revealUntil) return null;
    for (const h of vs.hits) {
      if (h.ad === isAd && t >= h.t - HIT_BEFORE && t <= h.t + HIT_AFTER) {
        const label = matchLabel(h.scores);
        if (label) return { kind: 'hit', label };
      }
    }
    const useSb = !isAd && vs.sb && vs.thumbs;
    if (useSb) {
      // Náhled j zachycuje čas j·dt, pavouk tam může být i chvíli před ním a po něm.
      const x = t / vs.sb.dt;
      for (let j = Math.max(0, Math.ceil(x - 1)); j <= Math.min(vs.sb.count - 1, Math.floor(x + 1)); j++) {
        const label = matchLabel(vs.thumbs[j]);
        if (label) return { kind: 'hit', label };
      }
    }
    if (!settings.strict || engine.state === 'error') return null;
    if (engine.state !== 'ready') return { kind: 'loading' };
    if (useSb) {
      const k = Math.floor(t / vs.sb.dt);
      if (!vs.thumbs[k] || (k + 1 < vs.sb.count && !vs.thumbs[k + 1])) return { kind: 'checking' };
      return null;
    }
    if (!isAd && vs.sbState === 'pending') return { kind: 'checking' };
    if (!vs.liveChecked || vs.lastLiveAd !== isAd) return { kind: 'checking' };
    return null;
  }

  function badgeText(reason) {
    if (reason.kind === 'hit') return 'Skryto: ' + labelName(reason.label);
    if (reason.kind === 'loading') {
      if (engine.loadedMB) return `Fobifiltr stahuje AI model (${engine.loadedMB} ze ~${engine.totalMB || 150} MB)…`;
      return 'Fobifiltr spouští AI model…';
    }
    return 'Fobifiltr prověřuje tenhle úsek…';
  }

  function hide(video, reason) {
    video.classList.add('fobi-blur');
    const host = video.closest('.html5-video-player') || video.parentElement;
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'fobi-badge';
      const text = document.createElement('span');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Ukázat';
      btn.title = 'Ukázat video na 10 sekund';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (vs) vs.revealUntil = Date.now() + REVEAL_MS;
      });
      badge.append(text, btn);
    }
    if (host && badge.parentElement !== host) host.appendChild(badge);
    badge.firstChild.textContent = badgeText(reason);
    if (settings.mute && !video.muted) {
      video.muted = true;
      vs.weMuted = true;
    }
    vs.hidden = reason;
  }

  function unhide() {
    if (!vs) return;
    const v = vs.video;
    if (v) {
      v.classList.remove('fobi-blur');
      if (vs.weMuted) {
        v.muted = false;
        vs.weMuted = false;
      }
    }
    badge?.remove();
    vs.hidden = null;
  }

  function resetVideo(key, video) {
    unhide();
    vs = {
      key,
      id: key.startsWith('v:') ? key.slice(2) : null,
      video,
      sb: null,
      sbState: 'none',
      sbTries: 0,
      thumbs: null,
      scanDone: false,
      scanErrors: 0,
      hits: [],
      liveChecked: false,
      lastLiveAd: false,
      lastLiveT: null,
      contentT: 0,
      revealUntil: 0,
      customKey: JSON.stringify(settings.custom),
      hidden: null,
      weMuted: false,
    };
    if (vs.id && !location.pathname.startsWith('/shorts/')) {
      vs.sbState = 'pending';
      setTimeout(requestStoryboard, 600);
    }
  }

  // Stav pro ladění: <div id="movie_player" data-fobi="{...}">
  function writeDebug(video, reason) {
    if (Date.now() - lastDebug < 1000) return;
    lastDebug = Date.now();
    const host = video.closest('.html5-video-player');
    if (!host) return;
    const thumbs = vs.thumbs || [];
    const scanned = thumbs.filter(Boolean).length;
    const flagged = [];
    thumbs.forEach((s, k) => {
      if (matchLabel(s)) flagged.push(Math.round(k * vs.sb.dt));
    });
    host.dataset.fobi = JSON.stringify({
      engine: engine.state,
      storyboard: vs.sbState,
      thumbs: thumbs.length,
      scanned,
      flaggedAt: flagged.slice(0, 40),
      hits: vs.hits.length,
      hidden: reason ? reason.kind + (reason.label ? ':' + reason.label : '') : null,
      t: Math.round(video.currentTime * 10) / 10,
      liveMs: vs.liveMs,
      scanMs: vs.scanMs,
      last: vs.lastScores,
    });
  }

  // ---------- náhledy videí na stránce ----------
  // Doporučená videa, vyhledávání, hlavní stránka: pavouk na náhledu bývá větší než ve videu samotném.

  const THUMB_RE = /^https:\/\/i\.ytimg\.com\/(?:vi|vi_webp|an_webp)\/([\w-]{11})\//;
  // V přehrávači (konec videa, náhled před spuštěním) jsou náhledy jako obrázek na pozadí.
  const BG_THUMBS =
    '.ytp-cued-thumbnail-overlay-image, .ytp-videowall-still-image, .ytp-modern-videowall-still-image, ' +
    '.ytp-ce-covering-image, .ytp-autonav-endscreen-upnext-thumbnail';
  const THUMB_EVERY_MS = 500;
  let thumbScores = new Map(); // id videa -> skóre (null = náhled nešel načíst)
  let thumbCustomKey = '';
  let thumbBusy = false;
  let lastThumbScan = 0;

  function setThumbClass(img, cls) {
    for (const c of ['fobi-thumb-hit', 'fobi-thumb-wait']) {
      if (c !== cls && img.classList.contains(c)) img.classList.remove(c);
    }
    if (cls && !img.classList.contains(cls)) img.classList.add(cls);
  }

  function clearThumbs() {
    for (const el of document.querySelectorAll('.fobi-thumb-hit, .fobi-thumb-wait')) setThumbClass(el, null);
  }

  function thumbUrl(el) {
    if (el.tagName === 'IMG') return el.currentSrc || el.src;
    return /url\(["']?([^"')]+)/.exec(el.style.backgroundImage)?.[1] || '';
  }

  function scanThumbs() {
    const customKey = JSON.stringify(settings.custom);
    if (customKey !== thumbCustomKey || thumbScores.size > 3000) {
      thumbCustomKey = customKey;
      thumbScores = new Map();
    }
    const todo = [];
    const queued = new Set();
    for (const img of [...document.images, ...document.querySelectorAll(BG_THUMBS)]) {
      const url = thumbUrl(img);
      const m = THUMB_RE.exec(url);
      if (!m) {
        setThumbClass(img, null);
        continue;
      }
      const id = m[1];
      if (thumbScores.has(id)) {
        setThumbClass(img, matchLabel(thumbScores.get(id)) ? 'fobi-thumb-hit' : null);
        continue;
      }
      setThumbClass(img, settings.strict ? 'fobi-thumb-wait' : null);
      if (queued.has(id)) continue;
      // Napřed to, co je vidět, pak obrazovku pod tím.
      const r = img.getBoundingClientRect();
      if (r.width < 40 || r.bottom < -200 || r.top > innerHeight * 2) continue;
      queued.add(id);
      todo.push({ id, url, top: r.top < 0 ? 1e6 : r.top });
    }
    if (thumbBusy || !todo.length || engine.state !== 'ready') return;
    todo.sort((a, b) => a.top - b.top);
    classifyThumbs(todo.slice(0, batchSize()));
  }

  async function classifyThumbs(batch) {
    const key = thumbCustomKey;
    thumbBusy = true;
    try {
      const r = await chrome.runtime.sendMessage({
        to: 'engine',
        type: 'classify-urls',
        urls: batch.map((b) => b.url),
        custom: settings.custom,
      });
      if (!r?.ok) throw new Error(r?.error || 'Engine neodpověděl');
      if (key !== thumbCustomKey) return;
      batch.forEach((b, i) => thumbScores.set(b.id, r.results[i]));
    } catch (e) {
      onEngineError(e);
    } finally {
      thumbBusy = false;
    }
  }

  // ---------- hlavní smyčka ----------

  function tick() {
    const root = document.documentElement;
    if (!settings.enabled) {
      root.classList.remove('fobi-on', 'fobi-strict');
      unhide();
      clearThumbs();
      return;
    }
    root.classList.add('fobi-on');
    root.classList.toggle('fobi-strict', !!settings.strict);
    if (engine.state !== 'ready') ensureEngine();
    if (!document.hidden && Date.now() - lastThumbScan > THUMB_EVERY_MS) {
      lastThumbScan = Date.now();
      scanThumbs();
    }

    const video = findVideo();
    if (!video) return;
    // Na stránkách bez id videa (hlavní stránka) se přehrávač náhledů používá pro různá videa.
    let key = videoKey();
    if (!key.startsWith('v:')) key += '|' + (video.currentSrc || '');
    if (!vs || vs.key !== key || vs.video !== video) resetVideo(key, video);

    const customKey = JSON.stringify(settings.custom);
    if (vs.customKey !== customKey) {
      // Nová vlastní slova: staré skóre je neznají, prověřit znovu.
      vs.customKey = customKey;
      vs.hits = [];
      vs.liveChecked = false;
      vs.scanDone = false;
      if (vs.sb) vs.thumbs = new Array(vs.sb.count);
    }

    const isAd = !!video.closest('.html5-video-player')?.classList.contains('ad-showing');
    const t = video.currentTime || 0;
    if (!isAd) vs.contentT = t;
    const reason = hideReason(t, isAd);
    if (reason) hide(video, reason);
    else unhide();
    writeDebug(video, reason);

    if (document.hidden || engine.state !== 'ready') return;
    const now = Date.now();
    const liveEvery = Math.max(LIVE_MIN_MS, 2 * (vs.liveMs || 350));
    const due = video.paused ? Math.abs(t - (vs.lastLiveT ?? -99)) > 0.25 : now - lastLiveAt > liveEvery;
    if (!liveBusy && video.readyState >= 2 && due) liveCheck(video, t, isAd);
    if (!scanBusy && vs.sb && vs.thumbs && !vs.scanDone) scanStep();
  }

  setInterval(tick, 150);
})();
