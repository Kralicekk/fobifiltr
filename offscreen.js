// AI engine. Model CLIP porovná obrázek s textovými popisy („a photo of a spider“, „a person
// talking…“) a řekne, jak moc se obrázek ke kterému popisu hodí. Běží celý tady v prohlížeči.
import {
  env,
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
} from './vendor/transformers.min.js';

const MODEL_ID = 'Xenova/clip-vit-base-patch32';
// Text (jednou za změnu slov) běží na procesoru. Obraz na grafice: 4bitové váhy, ~35 ms na čtverec
// místo ~190 ms na procesoru, přesnost na testovací sadě stejná. Bez WebGPU obraz q8 na procesoru.
const TEXT_MB = 64; // text_model_quantized + tokenizer
const VISION_MB = { q4f16: 51, q4: 61, q8: 85 };
const CROP = 224;
const { CATEGORIES, NEUTRAL } = self.FOBI;

env.allowLocalModels = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.mjs'),
  wasm: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.wasm'),
};

// ---------- stav pro popup a content script ----------

let status = { state: 'loading', progress: 0 };
function report(patch) {
  status = { ...status, ...patch, at: Date.now() };
  chrome.runtime.sendMessage({ to: 'bg', type: 'engine-status', status }).catch(() => {});
}

const downloads = new Map();
let lastProgressReport = 0;
let expectedMB = TEXT_MB + VISION_MB.q8;
function onProgress(p) {
  if (p.status !== 'progress' || !p.total) return;
  downloads.set(p.file, { loaded: p.loaded, total: p.total });
  const now = Date.now();
  if (now - lastProgressReport < 500) return;
  lastProgressReport = now;
  let loaded = 0;
  let total = 0;
  for (const f of downloads.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  report({
    state: 'loading',
    progress: Math.min(99, Math.round((loaded / Math.max(total, expectedMB * 1e6)) * 100)),
    loadedMB: Math.round(loaded / 1e6),
    totalMB: expectedMB,
  });
}

// ---------- načtení modelu ----------

async function gpuDtype() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    return adapter.features.has('shader-f16') ? 'q4f16' : 'q4';
  } catch {
    return null;
  }
}

function loadVision(device, dtype) {
  return CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { device, dtype, progress_callback: onProgress });
}

// Na grafice se při prvním běhu kompilují shadery (1 až 2 s), ať to nečeká první živý snímek.
// Široký snímek z videa jsou 2 čtverce.
async function warmUp(model, processor) {
  cropCtx.fillStyle = '#777';
  cropCtx.fillRect(0, 0, CROP, CROP);
  const img = RawImage.fromCanvas(cropCanvas);
  await model(await processor([img, img]));
}

let vision = null; // { model, device }
const ready = (async () => {
  report({ state: 'loading', progress: 0 });
  const gpu = await gpuDtype();
  expectedMB = TEXT_MB + VISION_MB[gpu || 'q8'];
  const [tokenizer, processor, textModel] = await Promise.all([
    AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback: onProgress }),
    AutoProcessor.from_pretrained(MODEL_ID, { progress_callback: onProgress }),
    CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { device: 'wasm', dtype: 'q8', progress_callback: onProgress }),
    (async () => {
      if (gpu) {
        try {
          const model = await loadVision('webgpu', gpu);
          vision = { model, device: 'GPU' };
          return;
        } catch (e) {
          console.warn('WebGPU nejde, jedu na procesoru:', e);
        }
      }
      vision = { model: await loadVision('wasm', 'q8'), device: 'CPU' };
    })(),
  ]);
  try {
    await warmUp(vision.model, processor);
  } catch (e) {
    if (vision.device !== 'GPU') throw e;
    console.warn('WebGPU spadlo při zahřátí, jedu na procesoru:', e);
    vision = { model: await loadVision('wasm', 'q8'), device: 'CPU' };
  }
  report({ state: 'ready', progress: 100, device: vision.device, loadedMB: undefined });
  return { tokenizer, processor, textModel };
})();
ready.catch((e) => report({ state: 'error', message: String(e?.message || e) }));

// Grafika může za běhu vypadnout (ovladač, uspání). Pak jednou přejít na procesor a pokračovat.
let fallingBack = null;
async function runVision(inputs) {
  const v = vision;
  try {
    return await v.model(inputs);
  } catch (e) {
    if (v.device !== 'GPU') throw e;
    console.warn('WebGPU selhalo, přecházím na procesor:', e);
    fallingBack ??= loadVision('wasm', 'q8').then((model) => {
      vision = { model, device: 'CPU' };
      report({ device: 'CPU' });
    });
    await fallingBack;
    return vision.model(inputs);
  }
}

// ---------- textové popisy ----------

function normalizeRows(data, dim) {
  const out = new Float32Array(data.length);
  for (let r = 0; r < data.length / dim; r++) {
    let n = 0;
    for (let k = 0; k < dim; k++) n += data[r * dim + k] ** 2;
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < dim; k++) out[r * dim + k] = data[r * dim + k] / n;
  }
  return out;
}

function buildLabels(custom) {
  const labels = [];
  for (const c of CATEGORIES) for (const text of c.prompts) labels.push({ text, cat: c.id });
  for (const w of custom) {
    const cat = 'custom:' + w;
    labels.push({ text: `a photo of ${w}`, cat }, { text: w, cat });
  }
  for (const text of NEUTRAL) labels.push({ text, cat: null });
  return labels;
}

// Popisy jedné kategorie se zprůměrují do jednoho vektoru, takže každá kategorie i každá
// neutrální scéna má stejnou výchozí šanci. Při sčítání by pavouk se 4 popisy přebil kraba s jedním.
let textCache = { key: null };
async function textEmbeddings(custom) {
  const key = JSON.stringify(custom);
  if (textCache.key === key) return textCache;
  const m = await ready;
  const labels = buildLabels(custom);
  const inputs = m.tokenizer(
    labels.map((l) => l.text),
    { padding: true, truncation: true },
  );
  const { text_embeds } = await m.textModel(inputs);
  const dim = text_embeds.dims[1];
  const rows = normalizeRows(text_embeds.data, dim);
  const groups = new Map();
  labels.forEach((l, j) => {
    const g = l.cat ? l.cat : 'neutral:' + j;
    if (!groups.has(g)) groups.set(g, { cat: l.cat, sum: new Float32Array(dim) });
    const sum = groups.get(g).sum;
    for (let k = 0; k < dim; k++) sum[k] += rows[j * dim + k];
  });
  const classes = [...groups.values()];
  const flat = new Float32Array(classes.length * dim);
  classes.forEach((c, i) => flat.set(c.sum, i * dim));
  textCache = { key, classes: classes.map((c) => c.cat), dim, emb: normalizeRows(flat, dim) };
  return textCache;
}

// ---------- obrázky ----------

const cropCanvas = new OffscreenCanvas(CROP, CROP);
const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

// CLIP vidí jen čtverec. Široký snímek proto rozdělíme na několik čtverců, které ho celý pokryjí,
// jinak by pavouk u kraje obrazu zůstal mimo.
function squareCrops(src, sx, sy, sw, sh) {
  const side = Math.min(sw, sh);
  const n = Math.max(1, Math.ceil(Math.max(sw, sh) / side - 0.05));
  const crops = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0.5 : i / (n - 1);
    cropCtx.drawImage(src, sx + (sw - side) * f, sy + (sh - side) * f, side, side, 0, 0, CROP, CROP);
    crops.push(RawImage.fromCanvas(cropCanvas));
  }
  return crops;
}

async function scoreImages(images, custom) {
  const m = await ready;
  const T = await textEmbeddings(custom);
  const inputs = await m.processor(images);
  const { image_embeds } = await runVision(inputs);
  const dim = image_embeds.dims[1];
  const I = normalizeRows(image_embeds.data, dim);
  const L = T.classes.length;
  const results = [];
  for (let b = 0; b < images.length; b++) {
    const logits = new Float32Array(L);
    let max = -Infinity;
    for (let j = 0; j < L; j++) {
      let s = 0;
      for (let k = 0; k < dim; k++) s += I[b * dim + k] * T.emb[j * dim + k];
      logits[j] = 100 * s; // logit_scale CLIPu
      if (logits[j] > max) max = logits[j];
    }
    let sum = 0;
    for (let j = 0; j < L; j++) {
      logits[j] = Math.exp(logits[j] - max);
      sum += logits[j];
    }
    const scores = {};
    for (let j = 0; j < L; j++) {
      if (T.classes[j]) scores[T.classes[j]] = logits[j] / sum;
    }
    results.push(scores);
  }
  return results;
}

function mergeMax(list) {
  const out = {};
  for (const s of list) for (const k in s) out[k] = Math.max(out[k] || 0, s[k]);
  for (const k in out) out[k] = Math.round(out[k] * 1000) / 1000;
  return out;
}

// Storyboard = mřížka malých náhledů, které YouTube ukazuje nad posuvníkem.
const sheets = new Map();
async function getSheet(url) {
  if (sheets.has(url)) return sheets.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`storyboard HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  sheets.set(url, bmp);
  if (sheets.size > 6) {
    const [oldUrl, oldBmp] = sheets.entries().next().value;
    oldBmp.close();
    sheets.delete(oldUrl);
  }
  return bmp;
}

async function getImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`obrázek HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

// ---------- fronta ----------
// Živý snímek > nejbližších ~30 s videa > náhledy na stránce > zbytek videa.

const queue = { live: [], near: [], thumbs: [], far: [] };
const ORDER = Object.keys(queue);
let busy = false;
function enqueue(priority, fn) {
  return new Promise((resolve, reject) => {
    queue[priority].push({ fn, resolve, reject });
    pump();
  });
}
async function pump() {
  if (busy) return;
  const level = ORDER.find((p) => queue[p].length);
  const job = level && queue[level].shift();
  if (!job) return;
  busy = true;
  try {
    job.resolve(await job.fn());
  } catch (e) {
    job.reject(e);
  } finally {
    busy = false;
    pump();
  }
}

async function handle(msg) {
  if (msg.type === 'status') return { status };

  if (msg.type === 'classify-frame') {
    return enqueue('live', async () => {
      const t0 = performance.now();
      const bmp = await createImageBitmap(await (await fetch(msg.image)).blob());
      const crops = squareCrops(bmp, 0, 0, bmp.width, bmp.height);
      bmp.close();
      const scores = mergeMax(await scoreImages(crops, msg.custom || []));
      return { scores, ms: Math.round(performance.now() - t0) };
    });
  }

  if (msg.type === 'classify-cells') {
    return enqueue(msg.near ? 'near' : 'far', async () => {
      const t0 = performance.now();
      const sheet = await getSheet(msg.sheetUrl);
      const groups = msg.cells.map((c) => squareCrops(sheet, c.x, c.y, c.w, c.h));
      const flat = await scoreImages(groups.flat(), msg.custom || []);
      let i = 0;
      const results = groups.map((g) => {
        const part = flat.slice(i, i + g.length);
        i += g.length;
        return mergeMax(part);
      });
      return { results, ms: Math.round(performance.now() - t0) };
    });
  }

  // Náhledy videí na stránce (doporučená videa, vyhledávání). Nenačtený náhled vrátí null.
  if (msg.type === 'classify-urls') {
    return enqueue('thumbs', async () => {
      const t0 = performance.now();
      const bmps = await Promise.all(msg.urls.map((u) => getImage(u).catch(() => null)));
      const groups = bmps.map((b) => (b ? squareCrops(b, 0, 0, b.width, b.height) : []));
      bmps.forEach((b) => b?.close());
      const flat = groups.flat().length ? await scoreImages(groups.flat(), msg.custom || []) : [];
      let i = 0;
      const results = groups.map((g) => {
        if (!g.length) return null;
        const part = flat.slice(i, i + g.length);
        i += g.length;
        return mergeMax(part);
      });
      return { results, ms: Math.round(performance.now() - t0) };
    });
  }

  // Jen pro ladění a ladění prahů: surové podobnosti snímku se všemi popisy.
  if (msg.type === 'debug-frame') {
    return enqueue('live', async () => {
      const m = await ready;
      const bmp = await createImageBitmap(await (await fetch(msg.image)).blob());
      const crops = squareCrops(bmp, 0, 0, bmp.width, bmp.height);
      bmp.close();
      const labels = buildLabels(msg.custom || []);
      const t = m.tokenizer(labels.map((l) => l.text), { padding: true, truncation: true });
      const { text_embeds } = await m.textModel(t);
      const dim = text_embeds.dims[1];
      const T = normalizeRows(text_embeds.data, dim);
      const { image_embeds } = await runVision(await m.processor(crops));
      const I = normalizeRows(image_embeds.data, dim);
      const sims = crops.map((_, b) =>
        labels.map((_, j) => {
          let s = 0;
          for (let k = 0; k < dim; k++) s += I[b * dim + k] * T[j * dim + k];
          return Math.round(s * 1e4) / 1e4;
        }),
      );
      return { labels, sims, emb: msg.withEmb ? Array.from(T) : undefined, dim };
    });
  }

  throw new Error('Neznámá zpráva: ' + msg.type);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to !== 'engine') return;
  handle(msg).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true;
});
