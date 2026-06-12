const send = (msg) => browser.runtime.sendMessage(msg);

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

// One shared popover, written into whichever .icon input was clicked.
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
  const r = input.getBoundingClientRect();
  palette.style.display = 'flex';
  palette.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 240)) + 'px';
  palette.style.top = (r.bottom + 4) + 'px';
}
function hidePalette() { palette.style.display = 'none'; activeIconInput = null; }
document.addEventListener('mousedown', (e) => {
  if (!palette.contains(e.target) && !e.target.classList.contains('icon')) hidePalette();
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

    const commit = () => send({ cmd: 'update', id: p.id, name: name.value, icon: icon.value });
    icon.addEventListener('change', commit);
    name.addEventListener('change', commit);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });

    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = counts[p.id] || 0;

    const up = mkBtn('↑', '', i === 0, () => move(panels, i, -1));
    const down = mkBtn('↓', '', i === panels.length - 1, () => move(panels, i, +1));

    const open = mkBtn(p.id === activePanel ? '●' : 'Open', 'open', p.id === activePanel,
      () => { send({ cmd: 'switch', panelId: p.id }); window.close(); });

    const del = mkBtn('✕', 'del', panels.length <= 1, () => {
      if (confirm(`Remove "${p.name}"? Its tabs move to another panel.`))
        send({ cmd: 'remove', id: p.id });
    });

    row.append(icon, name, count, up, down, open, del);
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

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'houdini:changed') render();
});

render();
