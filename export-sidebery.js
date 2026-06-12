// Houdini — Sidebery full-dump exporter.
// Run in: about:debugging → This Firefox → Sidebery → Inspect → Console.
// Prints the JSON and copies it to the clipboard. Paste into a new file
// named sidebery-full.json, then import it in Houdini → Manage.
(async () => {
  const d = await browser.storage.local.get(['sidebar', 'tabsDataCache', 'snapshots', 'ver']);
  const json = JSON.stringify(d);
  console.log('Houdini: keys', Object.keys(d).join(', '),
    '| tabs:', (d.tabsDataCache?.flat?.().length) ?? 0,
    '| bytes:', json.length);
  try { copy(json); console.log('Copied to clipboard. Paste into sidebery-full.json'); }
  catch (e) { console.log('copy() unavailable — select the string below and copy manually:'); }
  console.log(json);
})();
