const F = self.FOBI;
const $ = (id) => document.getElementById(id);
let settings = { ...F.DEFAULTS };

function save(patch) {
  settings = { ...settings, ...patch };
  chrome.storage.sync.set(patch);
  render();
}

function render() {
  $('enabled').checked = settings.enabled;
  $('strict').checked = settings.strict;
  $('mute').checked = settings.mute;
  document.body.style.opacity = settings.enabled ? '1' : '0.6';

  for (const input of document.querySelectorAll('#cats input')) {
    input.checked = settings.categories.includes(input.value);
  }
  for (const b of document.querySelectorAll('#sensitivity button')) {
    b.classList.toggle('on', b.dataset.v === settings.sensitivity);
  }

  const chips = $('chips');
  chips.replaceChildren();
  for (const w of settings.custom) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(w);
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Odebrat';
    x.addEventListener('click', () => save({ custom: settings.custom.filter((c) => c !== w) }));
    chip.append(x);
    chips.append(chip);
  }
}

function renderStatus(s) {
  const st = s?.state || 'idle';
  $('status').dataset.state = st;
  let text = 'AI model se připravuje…';
  if (st === 'ready') {
    text = s.device === 'GPU'
      ? 'AI model je připravený a běží v počítači na grafice.'
      : 'AI model je připravený a běží v počítači na procesoru (pomaleji).';
  }
  if (st === 'loading' && s.loadedMB) text = `Stahuji AI model: ${s.loadedMB} ze ~${s.totalMB || 150} MB (jen poprvé)`;
  if (st === 'error') text = 'AI model se nepodařilo spustit: ' + (s.message || 'neznámá chyba');
  $('status-text').textContent = text;
  const showBar = st === 'loading' && s.progress > 0;
  $('bar').hidden = !showBar;
  $('bar-fill').style.width = (s?.progress || 0) + '%';
}

function buildCategories() {
  const wrap = $('cats');
  for (const c of F.CATEGORIES) {
    const label = document.createElement('label');
    label.className = 'cat';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = c.id;
    input.addEventListener('change', () => {
      const set = new Set(settings.categories);
      input.checked ? set.add(c.id) : set.delete(c.id);
      save({ categories: F.CATEGORIES.map((x) => x.id).filter((id) => set.has(id)) });
    });
    label.append(input, c.label);
    wrap.append(label);
  }
}

buildCategories();

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('strict').addEventListener('change', (e) => save({ strict: e.target.checked }));
$('mute').addEventListener('change', (e) => save({ mute: e.target.checked }));
for (const b of document.querySelectorAll('#sensitivity button')) {
  b.addEventListener('click', () => save({ sensitivity: b.dataset.v }));
}
$('custom-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const w = $('custom-input').value.trim().toLowerCase();
  if (!w || settings.custom.includes(w) || settings.custom.length >= 10) return;
  $('custom-input').value = '';
  save({ custom: [...settings.custom, w] });
});

chrome.storage.sync.get(F.DEFAULTS, (s) => {
  settings = { ...F.DEFAULTS, ...s };
  render();
});
chrome.storage.local.get({ engineStatus: null }, (s) => renderStatus(s.engineStatus));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.engineStatus) renderStatus(changes.engineStatus.newValue);
});

// Otevřením okénka se model začne stahovat, kdyby ještě neběžel.
chrome.runtime.sendMessage({ to: 'bg', type: 'ensure-engine' }).catch(() => {});
