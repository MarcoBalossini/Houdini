const send = (msg) => browser.runtime.sendMessage(msg);

// In-popup confirm — native confirm() renders cut/ugly in extension popups.
const modal = document.getElementById('modal');
const modalMsg = document.getElementById('modalMsg');
const modalOk = document.getElementById('modalOk');
const modalCancel = document.getElementById('modalCancel');
let modalResolve = null;

function confirmDialog(message, okLabel = 'Remove') {
  modalMsg.textContent = message;
  modalOk.textContent = okLabel;
  modal.classList.add('open');
  modalOk.focus();
  return new Promise((resolve) => { modalResolve = resolve; });
}
function closeModal(result) {
  modal.classList.remove('open');
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}
modalOk.addEventListener('click', () => closeModal(true));
modalCancel.addEventListener('click', () => closeModal(false));
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(false); });
document.addEventListener('keydown', (e) => {
  if (!modal.classList.contains('open')) return;
  if (e.key === 'Escape') closeModal(false);
  if (e.key === 'Enter') closeModal(true);
});

// Built-in icon catalogue for the picker, grouped into labelled sections.
const ICON_GROUPS = [
  { label: 'Files & docs',
    icons: ['📄','📃','📑','📋','📁','📂','🗂️','🗃️','🗄️','📚','📖','📕','📗','📘','📙','📓','📔','📒','🔖','🏷️','📝','✏️','🖊️','📐','📌','📎'] },
  { label: 'Work & study',
    icons: ['🎓','🧪','🔬','🧬','⚗️','🔭','💼','🏢','🏦','🧮','📊','📈','📉','🗒️','🗓️','📅','⏰','⌛','🔍','🔎'] },
  { label: 'Tech & dev',
    icons: ['💻','🖥️','⌨️','🖱️','💾','💿','🌐','🛜','📡','🔌','🔋','🤖','🐛','⚙️','🔧','🔨','🛠️','🧰','🗜️','📟'] },
  { label: 'Media & creative',
    icons: ['🎨','🖌️','🖍️','🎭','🎬','📷','📸','🎥','📺','🎵','🎶','🎸','🎹','🎤','🎧','🔊','📻','🕹️','🎮','🎲'] },
  { label: 'Web & social',
    icons: ['✉️','📧','💬','🗨️','📢','📣','🔔','👤','👥','🧑‍💻','🛒','🛍️','💳','💰','💲','🎁','📦','🚚','🔗','📍'] },
  { label: 'Life & places',
    icons: ['🏠','🏡','🏗️','🌍','🌎','🌳','🌲','🌿','🍀','🌸','🍔','🍕','☕','🍵','🍺','🐾','🐱','🐶','✈️','🚀'] },
  { label: 'Symbols & status',
    icons: ['⭐','🌟','✨','🔥','💡','🧠','❤️','💜','💙','💚','✅','❌','⚠️','🚧','🔒','🔓','🔑','🚩','🏁','🧩'] },
  { label: 'Brand & misc',
    icons: ['🎩','🪄','👻','🃏','♠️','♥️','♦️','♣️','🧨','🎯','🏆','🥇','🔮','💎','🧭','🗺️','📜','🗝️','⚡','🌀'] }
];

// One shared picker modal, written into whichever .icon input was clicked.
const paletteOverlay = document.getElementById('paletteOverlay');
const palette = document.getElementById('palette');
let activeIconInput = null;
for (const group of ICON_GROUPS) {
  const head = document.createElement('div');
  head.className = 'pal-head';
  head.textContent = group.label;
  palette.appendChild(head);
  for (const emoji of group.icons) {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus state predictable
      if (activeIconInput) {
        activeIconInput.value = emoji;
        activeIconInput.dispatchEvent(new Event('change'));
      }
      hidePalette();
    });
    palette.appendChild(b);
  }
}
function openPalette(input) {
  activeIconInput = input;
  paletteOverlay.classList.add('open');
  palette.scrollTop = 0;
}
function hidePalette() {
  paletteOverlay.classList.remove('open');
  activeIconInput = null;
}
// Click the backdrop (outside the box) to dismiss.
paletteOverlay.addEventListener('mousedown', (e) => {
  if (e.target === paletteOverlay) hidePalette();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && paletteOverlay.classList.contains('open')) hidePalette();
});

// --- Panel color picker ----------------------------------------------------
// Preset swatches + a native custom picker. Picking a color re-themes the
// whole browser while that panel is active; "none" keeps the user's theme.

// Muted mid-tones: saturated enough to read as a color across the whole
// chrome, soft enough not to shout. Custom picker covers the vivid end.
const PANEL_COLORS = [
  '#b05a5a', '#bd7550', '#c39a55', '#a5a05c', '#6f9e63', '#57a08c',
  '#5b96ad', '#5c7fb5', '#6f6cb0', '#9069b0', '#b069a1', '#c1738a',
  '#a07a5f', '#75839b', '#87878f', '#5c5f6a', '#404a5c'
];

const colorOverlay = document.getElementById('colorOverlay');
const colorGrid = document.getElementById('colorGrid');
const customColor = document.getElementById('customColor');
let colorPickCb = null; // receives hex string, or null for "no color"

{
  const none = document.createElement('button');
  none.className = 'none';
  none.dataset.color = '';
  none.title = 'No color — keep your browser theme';
  colorGrid.appendChild(none);
  for (const c of PANEL_COLORS) {
    const b = document.createElement('button');
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    colorGrid.appendChild(b);
  }
}

colorGrid.addEventListener('mousedown', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  e.preventDefault();
  if (colorPickCb) colorPickCb(btn.dataset.color || null);
  hideColorPicker();
});

customColor.addEventListener('change', () => {
  if (colorPickCb) colorPickCb(customColor.value);
  hideColorPicker();
});

function openColorPicker(current, cb) {
  colorPickCb = cb;
  customColor.value = current || '#5c7fb5';
  for (const b of colorGrid.querySelectorAll('button'))
    b.classList.toggle('selected', (b.dataset.color || '') === (current || ''));
  colorOverlay.classList.add('open');
}
function hideColorPicker() {
  colorOverlay.classList.remove('open');
  colorPickCb = null;
}
colorOverlay.addEventListener('mousedown', (e) => {
  if (e.target === colorOverlay) hideColorPicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && colorOverlay.classList.contains('open')) hideColorPicker();
});

async function render() {
  const { panels, activePanel, counts } = await send({ cmd: 'getState' });
  const list = document.getElementById('list');
  list.innerHTML = '';

  panels.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (p.id === activePanel ? ' active' : '');

    const icon = document.createElement('input');
    icon.className = 'icon';
    icon.value = p.icon || '📄';
    icon.maxLength = 4;
    icon.readOnly = true;
    icon.title = 'Click to pick an icon';
    icon.addEventListener('click', () => openPalette(icon));

    const name = document.createElement('input');
    name.className = 'name';
    name.value = p.name;

    // Panel color: closure state, committed as '' when cleared.
    let color = p.color || null;
    const swatch = document.createElement('button');
    swatch.className = 'swatch' + (color ? '' : ' none');
    if (color) swatch.style.background = color;
    swatch.title = 'Panel color — tints the browser while this panel is active';

    const commit = () => send({ cmd: 'update', id: p.id, name: name.value, icon: icon.value, color: color || '' });
    icon.addEventListener('change', commit);
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });

    swatch.addEventListener('click', () => openColorPicker(color, (c) => {
      color = c;
      swatch.classList.toggle('none', !c);
      swatch.style.background = c || '';
      commit();
    }));

    // Colored panel? Its active ring matches the panel color.
    if (p.id === activePanel && p.color) row.style.boxShadow = `inset 0 0 0 2px ${p.color}`;

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = counts[p.id] || 0;

    const up = mkBtn('↑', '', i === 0, () => move(panels, i, -1));
    const down = mkBtn('↓', '', i === panels.length - 1, () => move(panels, i, +1));

    const open = mkBtn(p.id === activePanel ? 'Active' : 'Open', 'open', p.id === activePanel,
      () => { send({ cmd: 'switch', panelId: p.id }); window.close(); });

    const del = mkBtn('✕', 'del', panels.length <= 1, async () => {
      if (await confirmDialog(`Remove "${p.name}"? Its tabs move to another panel.`))
        send({ cmd: 'remove', id: p.id });
    });

    row.append(icon, name, swatch, count, up, down, open, del);
    list.appendChild(row);
  });
}

function mkBtn(label, cls, disabled, fn) {
  const b = document.createElement('button');
  if (cls) b.className = cls;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', fn);
  return b;
}

function move(panels, i, dir) {
  const order = panels.map(p => p.id);
  const j = i + dir;
  [order[i], order[j]] = [order[j], order[i]];
  send({ cmd: 'reorder', order });
}

const newIcon = document.getElementById('newIcon');
newIcon.readOnly = true;
newIcon.addEventListener('click', () => openPalette(newIcon));

document.getElementById('addBtn').addEventListener('click', async () => {
  const name = document.getElementById('newName').value.trim();
  if (!name) return;
  const icon = document.getElementById('newIcon').value.trim() || '📄';
  await send({ cmd: 'add', name, icon });
  document.getElementById('newName').value = '';
  document.getElementById('newIcon').value = '📄';
});

document.getElementById('manageBtn').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

// --- Cross-panel tab search ----------------------------------------------

const searchInput = document.getElementById('search');
const results = document.getElementById('results');

function matches(tab, q) {
  return (tab.title || '').toLowerCase().includes(q) ||
         (tab.url || '').toLowerCase().includes(q);
}

async function runSearch() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) {
    document.body.classList.remove('searching');
    results.innerHTML = '';
    return;
  }
  document.body.classList.add('searching');

  const tabs = await send({ cmd: 'searchTabs' });
  const hits = tabs.filter(t => matches(t, q));
  results.innerHTML = '';

  if (hits.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No matching tabs.';
    results.appendChild(e);
    return;
  }

  for (const tab of hits) {
    const row = document.createElement('div');
    row.className = 'res';

    if (tab.favIconUrl) {
      const img = document.createElement('img');
      img.className = 'fav';
      img.src = tab.favIconUrl;
      img.addEventListener('error', () => {
        const fb = document.createElement('span');
        fb.className = 'fav-fallback';
        fb.textContent = '🌐';
        img.replaceWith(fb);
      });
      row.appendChild(img);
    } else {
      const fb = document.createElement('span');
      fb.className = 'fav-fallback';
      fb.textContent = '🌐';
      row.appendChild(fb);
    }

    const main = document.createElement('div');
    main.className = 'res-main';
    const title = document.createElement('div');
    title.className = 'res-title';
    title.textContent = tab.title || tab.url || 'Untitled';
    const url = document.createElement('div');
    url.className = 'res-url';
    url.textContent = tab.url || '';
    main.append(title, url);

    const panel = document.createElement('span');
    panel.className = 'res-panel';
    panel.textContent = `${tab.panelIcon} ${tab.panelName}`;

    row.append(main, panel);
    row.addEventListener('click', () => {
      send({ cmd: 'focusTab', tabId: tab.id });
      window.close();
    });
    results.appendChild(row);
  }
}

searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; runSearch(); }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'houdini:changed') {
    render();
    if (document.body.classList.contains('searching')) runSearch();
  }
});

render();
