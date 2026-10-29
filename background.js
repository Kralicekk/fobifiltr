// Service worker: jen zakládá offscreen dokument s AI modelem a ukládá jeho stav.
// Samotný model běží v offscreen.html, protože service worker neumí dynamický import.

const OFFSCREEN_URL = 'offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length) return;
  if (!creating) {
    await chrome.storage.local.set({ engineStatus: { state: 'loading', progress: 0, at: Date.now() } });
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Spouští lokální AI model, který ve videu hledá věci, kterých se uživatel bojí.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to !== 'bg') return;
  if (msg.type === 'ensure-engine') {
    ensureOffscreen().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
    );
    return true;
  }
  if (msg.type === 'engine-status') {
    chrome.storage.local.set({ engineStatus: msg.status });
  }
});

// Po instalaci rovnou začne stahovat model, ať je připravený, než si pustíš video.
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreen();
});

// Po restartu prohlížeče offscreen dokument neběží, uložený stav „připraveno“ by lhal.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ engineStatus: { state: 'idle', at: Date.now() } });
});
