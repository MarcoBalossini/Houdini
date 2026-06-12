const send = (msg) => browser.runtime.sendMessage(msg);
const out = document.getElementById('result');

// --- Glossary scrollspy: highlight the nav link of the section in view ----
(() => {
  const links = [...document.querySelectorAll('nav.toc a')];
  const byId = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const targets = [...byId.keys()].map(id => document.getElementById(id)).filter(Boolean);
  if (!targets.length) return;

  let activeId = null;
  const setActive = (id) => {
    if (id === activeId) return;
    activeId = id;
    links.forEach(a => a.classList.remove('active'));
    byId.get(id)?.classList.add('active');
  };

  const spy = new IntersectionObserver((entries) => {
    // Pick the heading nearest the top among those currently crossing the line.
    const hit = entries.filter(e => e.isIntersecting)
                       .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (hit) setActive(hit.target.id);
  }, { rootMargin: '0px 0px -78% 0px', threshold: 0 });

  targets.forEach(t => spy.observe(t));
  setActive(targets[0].id);
})();

function showResult(res) {
  if (res && res.ok) {
    out.className = 'ok';
    let txt = `Replaced with ${res.panelsCreated} panel(s); tagged ${res.tabsMatched} tab(s).`;
    if (res.tabUrlsInBackup === 0)
      txt += ' (No tab data in this file — use a full storage dump to tag tabs.)';
    out.textContent = txt;
  } else {
    out.className = 'err';
    out.textContent = (res && res.error) || 'Import failed.';
  }
}

async function doImport(text) {
  if (!confirm('Import will REPLACE all current panels and tab assignments. Continue?')) return;
  let backup;
  try { backup = JSON.parse(text); }
  catch (e) { out.className = 'err'; out.textContent = 'Not valid JSON: ' + e.message; return; }
  showResult(await send({ cmd: 'migrate', backup }));
}

document.getElementById('fileBtn').addEventListener('click', async () => {
  const file = document.getElementById('backupFile').files[0];
  if (!file) { out.className = 'err'; out.textContent = 'Choose a file first.'; return; }
  doImport(await file.text());
});

document.getElementById('textBtn').addEventListener('click', () => {
  const text = document.getElementById('backupText').value.trim();
  if (!text) { out.className = 'err'; out.textContent = 'Paste the dump JSON first.'; return; }
  doImport(text);
});

document.getElementById('resetBtn').addEventListener('click', async () => {
  if (!confirm('Reset to a single default panel and move ALL tabs into it?')) return;
  await send({ cmd: 'reset' });
  out.className = 'ok';
  out.textContent = 'Reset done.';
});

// --- Native backup -------------------------------------------------------

const backupOut = document.getElementById('backupResult');

document.getElementById('exportBtn').addEventListener('click', async () => {
  const data = await send({ cmd: 'exportData' });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `houdini-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  backupOut.className = 'ok';
  backupOut.textContent = `Exported ${data.panels.length} panel(s), ${data.tabAssignments.length} tab(s).`;
});

async function doRestore(text) {
  if (!confirm('Import will REPLACE all current panels and tab assignments. Continue?')) return;
  let data;
  try { data = JSON.parse(text); }
  catch (e) { backupOut.className = 'err'; backupOut.textContent = 'Not valid JSON: ' + e.message; return; }
  const res = await send({ cmd: 'importData', data });
  if (res && res.ok) {
    backupOut.className = 'ok';
    backupOut.textContent = `Restored ${res.panels} panel(s), tagged ${res.tabs} tab(s).`;
  } else {
    backupOut.className = 'err';
    backupOut.textContent = (res && res.error) || 'Import failed.';
  }
}

document.getElementById('restoreFileBtn').addEventListener('click', async () => {
  const file = document.getElementById('restoreFile').files[0];
  if (!file) { backupOut.className = 'err'; backupOut.textContent = 'Choose a file first.'; return; }
  doRestore(await file.text());
});

document.getElementById('restoreTextBtn').addEventListener('click', () => {
  const text = document.getElementById('restoreText').value.trim();
  if (!text) { backupOut.className = 'err'; backupOut.textContent = 'Paste the backup JSON first.'; return; }
  doRestore(text);
});

// --- Tab grouping --------------------------------------------------------

const groupToggle = document.getElementById('groupToggle');

(async () => {
  const res = await send({ cmd: 'getGroupSetting' });
  groupToggle.checked = !!(res && res.enabled);
  if (res && !res.supported) {
    document.getElementById('groupUnsupported').style.display = 'block';
    groupToggle.disabled = true;
  }
})();

groupToggle.addEventListener('change', () => {
  send({ cmd: 'setGroupSetting', enabled: groupToggle.checked });
});

// --- Keyboard shortcuts (editable) ---------------------------------------

const scList = document.getElementById('shortcuts');
const scResult = document.getElementById('shortcutResult');

// Friendly labels; commands.getAll() descriptions for jump commands are generic.
const SC_LABELS = {
  'next-panel': 'Next panel',
  'prev-panel': 'Previous panel',
  '_execute_action': 'Open Houdini popup',
  'switch-panel-1': 'Jump to panel 1', 'switch-panel-2': 'Jump to panel 2',
  'switch-panel-3': 'Jump to panel 3', 'switch-panel-4': 'Jump to panel 4',
  'switch-panel-5': 'Jump to panel 5', 'switch-panel-6': 'Jump to panel 6',
  'switch-panel-7': 'Jump to panel 7', 'switch-panel-8': 'Jump to panel 8'
};

let recording = null; // command name currently capturing keys, or null

// Map a KeyboardEvent's main key to a Firefox-shortcut token, or null.
function keyToken(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(c)) return c;            // F1–F12
  const named = {
    Comma: 'Comma', Period: 'Period', Space: 'Space',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'Insert', Delete: 'Delete',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
  };
  return named[c] || null;
}

// Build a Firefox shortcut string from an event, or an error message.
function buildShortcut(e) {
  const key = keyToken(e);
  if (!key) return { error: 'Unsupported key.' };
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Command');
  if (e.shiftKey) mods.push('Shift');
  const isFn = /^F([1-9]|1[0-2])$/.test(key);
  const hasPrimary = e.ctrlKey || e.altKey || e.metaKey;
  // Firefox requires a primary modifier (Ctrl/Alt/Cmd) for non-function keys.
  if (!isFn && !hasPrimary) return { error: 'Needs Ctrl or Alt.' };
  // Shift alone isn't a valid primary modifier.
  if (!isFn && mods.length === 1 && mods[0] === 'Shift') return { error: 'Needs Ctrl or Alt.' };
  return { shortcut: [...mods, key].join('+') };
}

// Pretty-print a stored shortcut ("Alt+Period") as kbd elements.
function renderKeys(shortcut) {
  if (!shortcut) return '<span class="none">unset</span>';
  const pretty = { Period: '.', Comma: ',', Command: '⌘' };
  return shortcut.split('+').map(k => `<kbd>${pretty[k] || k}</kbd>`).join('+');
}

async function loadShortcuts() {
  if (!browser.commands || !browser.commands.update) {
    scList.innerHTML = '<p style="opacity:.5;font-size:12px;margin:0">Not supported in this browser.</p>';
    return;
  }
  const cmds = await browser.commands.getAll();
  // Keep our known commands in a stable, sensible order.
  const order = Object.keys(SC_LABELS);
  cmds.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  scList.innerHTML = '';
  for (const cmd of cmds) {
    const row = document.createElement('div');
    row.className = 'sc-row';
    row.dataset.name = cmd.name;
    const label = SC_LABELS[cmd.name] || cmd.description || cmd.name;
    row.innerHTML = `
      <span class="sc-label">${label}</span>
      <span class="sc-key">${renderKeys(cmd.shortcut)}</span>
      <button class="sc-set">Set</button>
      <button class="sc-clear" title="Clear">✕</button>
    `;
    row.querySelector('.sc-set').addEventListener('click', () => {
      if (recording === cmd.name) stopRecording();
      else startRecording(cmd.name, row);
    });
    row.querySelector('.sc-clear').addEventListener('click', () => setShortcut(cmd.name, ''));
    scList.appendChild(row);
  }
}

function startRecording(name, row) {
  if (recording) stopRecording();
  recording = name;
  row.classList.add('recording');
  row.querySelector('.sc-key').innerHTML = '<span class="none">press keys…</span>';
  row.querySelector('.sc-set').textContent = 'Cancel';
  scResult.textContent = '';
}

function stopRecording() {
  recording = null;
  document.querySelectorAll('.sc-row.recording').forEach(r => r.classList.remove('recording'));
  loadShortcuts();
}

async function setShortcut(name, shortcut) {
  try {
    await browser.commands.update({ name, shortcut });
    scResult.className = 'ok';
    scResult.textContent = shortcut ? 'Shortcut saved.' : 'Shortcut cleared.';
  } catch (e) {
    scResult.className = 'err';
    scResult.textContent = 'Could not set: ' + e.message;
  }
  recording = null;
  await loadShortcuts();
}

// Global key capture while recording.
document.addEventListener('keydown', (e) => {
  if (!recording) return;
  // Let the "Set" button's own click handler cancel; here handle keys + Esc.
  if (e.key === 'Escape') { e.preventDefault(); stopRecording(); return; }
  // Ignore lone modifier presses; wait for the real key.
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
  e.preventDefault();
  const res = buildShortcut(e);
  if (res.error) {
    scResult.className = 'err';
    scResult.textContent = res.error;
    return;
  }
  setShortcut(recording, res.shortcut);
}, true);

loadShortcuts();

// --- Snapshots -----------------------------------------------------------

const snapResult = document.getElementById('snapResult');

function fmtTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function renderSnapshots(snapshots) {
  const list = document.getElementById('snapList');
  if (!snapshots.length) {
    list.innerHTML = '<p style="opacity:.5;font-size:12px;margin:0">No snapshots yet.</p>';
    return;
  }
  list.innerHTML = '';
  // Newest first
  [...snapshots].reverse().forEach((snap, revIdx) => {
    const idx = snapshots.length - 1 - revIdx;
    const el = document.createElement('div');
    el.className = 'snap-item';
    el.innerHTML = `
      <div class="snap-item-info">
        <div class="snap-item-time">${fmtTime(snap.timestamp)}</div>
        <div class="snap-item-meta">${snap.panels.length} panel(s) · ${snap.tabAssignments.length} tab(s)</div>
      </div>
      <button class="secondary snap-rollback" data-idx="${idx}">Rollback</button>
      <button class="danger snap-delete" data-idx="${idx}">✕</button>
    `;
    list.appendChild(el);
  });

  list.querySelectorAll('.snap-rollback').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      if (!confirm(`Roll back to snapshot from ${fmtTime(snapshots[idx].timestamp)}?\nThis replaces current panels and re-tags all tabs.`)) return;
      const res = await send({ cmd: 'rollbackSnapshot', index: idx });
      snapResult.className = res.ok ? 'ok' : 'err';
      snapResult.textContent = res.ok ? 'Rolled back.' : (res.error || 'Rollback failed.');
      await loadSnapshots();
    });
  });

  list.querySelectorAll('.snap-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.idx);
      const res = await send({ cmd: 'deleteSnapshot', index: idx });
      if (res.ok) await loadSnapshots();
    });
  });
}

async function loadSnapshots() {
  const res = await send({ cmd: 'getSnapshots' });
  document.getElementById('snapPeriod').value = res.period;
  document.getElementById('snapMax').value = res.maxSnapshots;
  renderSnapshots(res.snapshots);
}

document.getElementById('snapSaveBtn').addEventListener('click', async () => {
  const period = document.getElementById('snapPeriod').value;
  const maxSnapshots = document.getElementById('snapMax').value;
  await send({ cmd: 'updateSnapshotSettings', period, maxSnapshots });
  snapResult.className = 'ok';
  snapResult.textContent = 'Settings saved.';
  setTimeout(() => { snapResult.textContent = ''; }, 2000);
});

document.getElementById('snapNowBtn').addEventListener('click', async () => {
  const res = await send({ cmd: 'takeSnapshot' });
  snapResult.className = res.ok ? 'ok' : 'err';
  snapResult.textContent = res.ok ? 'Snapshot saved.' : 'Snapshot failed.';
  if (res.ok) await loadSnapshots();
});

loadSnapshots();

// --- Sidebery import snippet ---------------------------------------------

document.getElementById('snippet').textContent =
`(async () => {
  const d = await browser.storage.local.get(['sidebar','tabsDataCache','snapshots','ver']);
  copy(JSON.stringify(d));
  console.log('Copied to clipboard — paste into Houdini.');
})();`;
