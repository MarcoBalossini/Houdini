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

document.getElementById('snippet').textContent =
`(async () => {
  const d = await browser.storage.local.get(['sidebar','tabsDataCache','snapshots','ver']);
  copy(JSON.stringify(d));
  console.log('Copied to clipboard — paste into Houdini.');
})();`;
