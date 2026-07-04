const send = (msg) => browser.runtime.sendMessage(msg);

// ---------- color helpers (accent + swatches) -------------------------------

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relLuminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function textOn(hex) {
  const rgb = hexToRgb(hex);
  return rgb && relLuminance(rgb) > 0.4 ? '#15141a' : '#fbfbfe';
}

// The UI accent follows the active panel's color; CSS defaults apply otherwise.
function setAccent(color) {
  const st = document.documentElement.style;
  if (color && hexToRgb(color)) {
    st.setProperty('--accent', color);
    st.setProperty('--on-accent', textOn(color));
  } else {
    st.removeProperty('--accent');
    st.removeProperty('--on-accent');
  }
}

// ---------- header: theme cycle + settings ----------------------------------

const THEME_ORDER = ['auto', 'dark', 'light'];
const THEME_LABELS = { auto: 'Auto (follows system)', dark: 'Dark', light: 'Light' };
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
};

const themeBtn = document.getElementById('themeBtn');

function paintThemeBtn() {
  const mode = document.documentElement.dataset.themeMode || 'auto';
  themeBtn.innerHTML = THEME_ICONS[mode] || THEME_ICONS.auto;
  themeBtn.title = 'Theme: ' + (THEME_LABELS[mode] || mode);
}

themeBtn.addEventListener('click', () => {
  const mode = document.documentElement.dataset.themeMode || 'auto';
  const next = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
  window.uiTheme.set(next);
});

new MutationObserver(paintThemeBtn)
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-mode'] });
paintThemeBtn();

document.getElementById('settingsBtn').addEventListener('click', () => {
  browser.runtime.openOptionsPage();
  window.close();
});

// ---------- confirm dialog (native confirm renders cut in popups) ------------

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

// ---------- icon palette ------------------------------------------------------

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

const paletteOverlay = document.getElementById('paletteOverlay');
const palette = document.getElementById('palette');
let iconPickCb = null;

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
      if (iconPickCb) iconPickCb(emoji);
      hidePalette();
    });
    palette.appendChild(b);
  }
}

function openIconPicker(cb) {
  iconPickCb = cb;
  paletteOverlay.classList.add('open');
  palette.scrollTop = 0;
}
function hidePalette() {
  paletteOverlay.classList.remove('open');
  iconPickCb = null;
}
paletteOverlay.addEventListener('mousedown', (e) => {
  if (e.target === paletteOverlay) hidePalette();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && paletteOverlay.classList.contains('open')) hidePalette();
});

// ---------- panel color picker -----------------------------------------------

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

// ---------- panel list ---------------------------------------------------------

const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>';

const list = document.getElementById('list');
const ghostAdd = document.getElementById('ghostAdd');
const newEditor = document.getElementById('newEditor');

let editingId = null;      // '__new__' while the ghost editor is open
let suppressClick = false; // eat the click that follows a drag-reorder

// Editor strip for the "+ New panel" ghost row.
function buildEditor() {
  const ed = document.createElement('div');
  ed.className = 'editor';
  let icon = '📄';
  let color = null;

  const iconBtn = document.createElement('button');
  iconBtn.className = 'icon-pick';
  iconBtn.textContent = icon;
  iconBtn.title = 'Change icon';

  const name = document.createElement('input');
  name.className = 'name';
  name.placeholder = 'Panel name';
  name.maxLength = 40;

  const swatch = document.createElement('button');
  const paintSwatch = () => {
    swatch.className = 'swatch' + (color ? '' : ' none');
    swatch.style.background = color || '';
  };
  paintSwatch();
  swatch.title = 'Panel color — tints the browser while this panel is active';

  iconBtn.addEventListener('click', () => openIconPicker((e) => {
    icon = e;
    iconBtn.textContent = e;
  }));
  swatch.addEventListener('click', () => openColorPicker(color, (c) => {
    color = c;
    paintSwatch();
  }));

  const addBtn = document.createElement('button');
  addBtn.className = 'primary add';
  addBtn.textContent = 'Add';
  const doAdd = () => {
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    editingId = null;
    send({ cmd: 'add', name: n, icon, color: color || '' });
  };
  addBtn.addEventListener('click', doAdd);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doAdd();
    if (e.key === 'Escape') { editingId = null; render(); }
  });

  ed.append(iconBtn, name, swatch, addBtn);
  return ed;
}

async function render() {
  const { panels, activePanel, counts } = await send({ cmd: 'getState' });
  const active = panels.find(p => p.id === activePanel);
  setAccent(active && active.color);

  // Background tab events re-render mid-typing; carry the draft across.
  const ae = document.activeElement;
  let keepEdit = null;
  if (ae && ae.matches?.('.prow .pname')) {
    keepEdit = { type: 'row', id: ae.closest('.prow')?.dataset.id, text: ae.textContent };
  } else if (ae && ae.matches?.('.editor input.name')) {
    keepEdit = { type: 'new', value: ae.value, start: ae.selectionStart, end: ae.selectionEnd };
  }

  list.innerHTML = '';
  for (const p of panels) {
    const row = document.createElement('div');
    row.className = 'prow' + (p.id === activePanel ? ' active' : '');
    row.dataset.id = p.id;

    const iconBtn = document.createElement('button');
    iconBtn.className = 'picon';
    iconBtn.textContent = p.icon || '📄';
    iconBtn.title = 'Change icon';
    iconBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openIconPicker((emoji) => send({ cmd: 'update', id: p.id, icon: emoji }));
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'pname';
    nameEl.contentEditable = 'true';
    nameEl.spellcheck = false;
    nameEl.textContent = p.name;
    nameEl.title = 'Click to rename';
    nameEl.addEventListener('click', (e) => e.stopPropagation());
    nameEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.textContent = p.name; nameEl.blur(); }
    });
    nameEl.addEventListener('blur', () => {
      const v = nameEl.textContent.replace(/\n/g, ' ').trim();
      if (!v) { nameEl.textContent = p.name; return; }
      if (v !== p.name) send({ cmd: 'update', id: p.id, name: v });
    });

    const spacer = document.createElement('span');
    spacer.className = 'pspace';

    const count = document.createElement('span');
    count.className = 'pcount';
    count.textContent = counts[p.id] || 0;
    count.title = 'Tabs in this panel';

    const swatch = document.createElement('button');
    swatch.className = 'swatch mini' + (p.color ? '' : ' none');
    if (p.color) swatch.style.background = p.color;
    swatch.title = 'Panel color — tints the browser while this panel is active';
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPicker(p.color || null, (c) => send({ cmd: 'update', id: p.id, color: c || '' }));
    });

    const trash = document.createElement('button');
    trash.className = 'icon-btn rowtrash';
    trash.innerHTML = SVG_TRASH;
    trash.title = 'Remove panel';
    trash.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await confirmDialog(`Remove "${p.name}"? Its tabs move to another panel.`))
        send({ cmd: 'remove', id: p.id });
    });

    row.append(iconBtn, nameEl, spacer, count, swatch, trash);

    row.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      if (p.id === activePanel) return;
      send({ cmd: 'switch', panelId: p.id });
      window.close();
    });

    list.appendChild(row);
  }

  newEditor.innerHTML = '';
  if (editingId === '__new__') {
    ghostAdd.style.display = 'none';
    newEditor.appendChild(buildEditor());
    if (!keepEdit) newEditor.querySelector('input.name').focus();
  } else {
    ghostAdd.style.display = '';
  }

  if (keepEdit && keepEdit.type === 'row') {
    const el = list.querySelector(`.prow[data-id="${keepEdit.id}"] .pname`);
    if (el) {
      el.textContent = keepEdit.text;
      el.focus();
      const sel = window.getSelection();
      sel.selectAllChildren(el);
      sel.collapseToEnd();
    }
  } else if (keepEdit && keepEdit.type === 'new') {
    const input = newEditor.querySelector('.editor input.name');
    if (input) {
      input.value = keepEdit.value;
      input.focus();
      input.setSelectionRange(keepEdit.start, keepEdit.end);
    }
  }
}

ghostAdd.addEventListener('click', async () => {
  editingId = '__new__';
  await render();
});

// ---------- drag to reorder -----------------------------------------------------
// Pointer-based (HTML5 DnD is unreliable inside browser-action popups):
// mousedown arms it, >5px of vertical travel starts it, rows re-slot live,
// mouseup commits the DOM order.

let drag = null;

list.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const row = e.target.closest('.prow');
  if (!row || e.target.closest('button, [contenteditable]')) return;
  drag = { row, startY: e.clientY, active: false };
});

document.addEventListener('mousemove', (e) => {
  if (!drag) return;
  if (!drag.active) {
    if (Math.abs(e.clientY - drag.startY) < 5) return;
    drag.active = true;
    drag.row.classList.add('dragging');
    list.classList.add('reordering');
  }
  e.preventDefault();
  const others = [...list.querySelectorAll('.prow')].filter(r => r !== drag.row);
  let placed = false;
  for (const r of others) {
    const rect = r.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      if (r.previousElementSibling !== drag.row) list.insertBefore(drag.row, r);
      placed = true;
      break;
    }
  }
  if (!placed && list.lastElementChild !== drag.row) list.appendChild(drag.row);
});

document.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.active) {
    drag.row.classList.remove('dragging');
    list.classList.remove('reordering');
    suppressClick = true;                       // the click right after mouseup
    setTimeout(() => { suppressClick = false; }, 0);
    send({ cmd: 'reorder', order: [...list.querySelectorAll('.prow')].map(r => r.dataset.id) });
  }
  drag = null;
});

// ---------- cross-panel tab search ------------------------------------------------

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

// ---------- wiring ------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'houdini:changed') {
    if (drag && drag.active) return; // don't rebuild the list mid-drag
    render();
    if (document.body.classList.contains('searching')) runSearch();
  }
});

render();
