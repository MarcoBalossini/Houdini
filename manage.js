const send = (msg) => browser.runtime.sendMessage(msg);
const out = document.getElementById('result');

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
