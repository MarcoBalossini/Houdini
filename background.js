// Houdini background: owns panel state + the show/hide tab logic.
// UIs (popup, sidebar, manage page) talk to it via runtime messages.

const DEFAULT_PANELS = [
  { id: 'default', name: 'General', icon: '📁' }
];

function uid() {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

async function getPanels() {
  const data = await browser.storage.local.get(['panels', 'activePanel']);
  let panels = data.panels;
  if (!Array.isArray(panels) || panels.length === 0) {
    panels = DEFAULT_PANELS.slice();
    await browser.storage.local.set({ panels });
  }
  let activePanel = data.activePanel;
  if (!activePanel || !panels.some(p => p.id === activePanel)) {
    activePanel = panels[0].id;
    await browser.storage.local.set({ activePanel });
  }
  return { panels, activePanel };
}

async function savePanels(panels) {
  await browser.storage.local.set({ panels });
}

// Count how many tabs are tagged to each panel (current window).
async function panelTabCounts() {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const counts = {};
  for (const tab of tabs) {
    const p = (await browser.sessions.getTabValue(tab.id, 'panel')) || null;
    if (p) counts[p] = (counts[p] || 0) + 1;
  }
  return counts;
}

// Switch the visible panel: show tabs tagged for it, hide the rest.
async function switchPanel(targetPanel) {
  const { panels } = await getPanels();
  if (!panels.some(p => p.id === targetPanel)) return;

  await browser.storage.local.set({ activePanel: targetPanel });

  const allTabs = await browser.tabs.query({ currentWindow: true });
  const tabsToShow = [];
  const tabsToHide = [];

  for (const tab of allTabs) {
    let p = await browser.sessions.getTabValue(tab.id, 'panel');
    if (!p || !panels.some(x => x.id === p)) {
      // Untagged or orphaned tab -> adopt into the panel being opened.
      p = targetPanel;
      await browser.sessions.setTabValue(tab.id, 'panel', targetPanel);
    }
    if (p === targetPanel) tabsToShow.push(tab.id);
    else tabsToHide.push(tab.id);
  }

  // Firefox refuses to hide the active tab; move focus first.
  const activeTab = allTabs.find(t => t.active);
  if (activeTab && tabsToHide.includes(activeTab.id)) {
    if (tabsToShow.length === 0) {
      const newTab = await browser.tabs.create({ active: true });
      await browser.sessions.setTabValue(newTab.id, 'panel', targetPanel);
      tabsToShow.push(newTab.id);
    } else {
      await browser.tabs.update(tabsToShow[0], { active: true });
    }
  }

  if (tabsToShow.length > 0) await browser.tabs.show(tabsToShow);
  if (tabsToHide.length > 0) await browser.tabs.hide(tabsToHide);

  notifyChanged();
}

async function addPanel(name, icon) {
  const { panels } = await getPanels();
  const panel = { id: uid(), name: name || 'Panel', icon: icon || '📄' };
  panels.push(panel);
  await savePanels(panels);
  notifyChanged();
  return panel;
}

async function updatePanel(id, name, icon) {
  const { panels } = await getPanels();
  const panel = panels.find(p => p.id === id);
  if (!panel) return;
  if (name != null) panel.name = name;
  if (icon != null) panel.icon = icon;
  await savePanels(panels);
  notifyChanged();
}

// Remove a panel; its tabs are reassigned to a fallback panel (not lost).
async function removePanel(id) {
  let { panels, activePanel } = await getPanels();
  if (panels.length <= 1) return; // never delete the last panel
  const fallback = panels.find(p => p.id !== id).id;

  const tabs = await browser.tabs.query({ currentWindow: true });
  for (const tab of tabs) {
    const p = await browser.sessions.getTabValue(tab.id, 'panel');
    if (p === id) await browser.sessions.setTabValue(tab.id, 'panel', fallback);
  }

  panels = panels.filter(p => p.id !== id);
  await savePanels(panels);
  if (activePanel === id) await switchPanel(fallback);
  else { await savePanels(panels); notifyChanged(); }
}

// Reorder panels to match a list of ids.
async function reorderPanels(orderedIds) {
  const { panels } = await getPanels();
  const byId = Object.fromEntries(panels.map(p => [p.id, p]));
  const next = orderedIds.map(id => byId[id]).filter(Boolean);
  for (const p of panels) if (!next.includes(p)) next.push(p);
  await savePanels(next);
  notifyChanged();
}

// --- Sidebery migration ---------------------------------------------------
// Accepts a parsed Sidebery backup JSON. Recreates its panels in Houdini and,
// when the backup carries saved tab URLs, tags matching open tabs.
// Import a Sidebery dump, REPLACING the current panels and tab tags entirely.
async function migrateFromSidebery(backup) {
  const sideberyPanels = extractSideberyPanels(backup);
  if (sideberyPanels.length === 0) {
    return { ok: false, error: 'No panels found in this Sidebery backup.' };
  }

  // Build the replacement panel list from scratch.
  const newPanels = [];
  const sbToHoudini = {}; // Sidebery panelId -> new Houdini panel id
  for (const sp of sideberyPanels) {
    const panel = { id: uid(), name: sp.name || 'Panel', icon: sp.icon || '📄' };
    newPanels.push(panel);
    if (sp.sideberyId) sbToHoudini[sp.sideberyId] = panel.id;
  }
  const fallback = newPanels[0].id;

  await savePanels(newPanels);
  await browser.storage.local.set({ activePanel: fallback });

  // Re-tag EVERY tab: matched URL -> its panel, everything else -> first panel.
  const urlToSb = buildUrlMap(backup);
  const tabs = await browser.tabs.query({});
  let matched = 0;
  for (const tab of tabs) {
    const sbId = urlToSb.get(normalizeUrl(tab.url));
    const hId = (sbId && sbToHoudini[sbId]) || fallback;
    if (sbId && sbToHoudini[sbId]) matched++;
    await browser.sessions.setTabValue(tab.id, 'panel', hId);
  }

  await switchPanel(fallback); // apply show/hide in the current window
  return {
    ok: true,
    panelsCreated: newPanels.length,
    tabsMatched: matched,
    tabUrlsInBackup: urlToSb.size
  };
}

// Wipe panels back to a single default and move all tabs into it.
async function resetAll() {
  const panels = DEFAULT_PANELS.slice();
  await savePanels(panels);
  await browser.storage.local.set({ activePanel: panels[0].id });
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) await browser.sessions.setTabValue(tab.id, 'panel', panels[0].id);
  await switchPanel(panels[0].id);
}

// Build normalizedURL -> Sidebery panelId from a full storage.local dump.
// Primary source: tabsDataCache (live open tabs, exact panelId per tab).
function buildUrlMap(backup) {
  const root = backup && backup.sidebery ? backup.sidebery : backup;
  const map = new Map();

  // tabsDataCache: array (per window) of arrays of {url, panelId, ...}.
  const cache = root && root.tabsDataCache;
  if (Array.isArray(cache)) {
    for (const win of cache) {
      if (!Array.isArray(win)) continue;
      for (const t of win) {
        if (t && t.url && t.panelId) map.set(normalizeUrl(t.url), t.panelId);
      }
    }
  }

  // Fallback: snapshots store {url, panelId} objects nested in arrays.
  const snaps = root && root.snapshots;
  if (Array.isArray(snaps) && snaps.length) {
    const snap = snaps[snaps.length - 1];
    walkForTabs(snap, (t) => {
      if (t.url && t.panelId && !map.has(normalizeUrl(t.url)))
        map.set(normalizeUrl(t.url), t.panelId);
    });
  }
  return map;
}

// Recursively find {url, panelId} objects anywhere in a nested structure.
function walkForTabs(node, cb) {
  if (Array.isArray(node)) {
    for (const x of node) if (x !== -1 && x != null) walkForTabs(x, cb);
  } else if (node && typeof node === 'object') {
    if (node.url) cb(node);
    else for (const v of Object.values(node)) walkForTabs(v, cb);
  }
}

function normalizeUrl(u) {
  if (!u) return '';
  return u.replace(/#.*$/, '').replace(/\/$/, '');
}

// Sidebery backup shapes have changed across versions; probe the known spots.
function extractSideberyPanels(backup) {
  const out = [];
  const root = backup && backup.sidebery ? backup.sidebery : backup;
  let rawPanels =
    (root && root.panels) ||
    (root && root.sidebar && root.sidebar.panels) ||
    (root && root.containers) ||
    null;

  // Object map -> array.
  if (rawPanels && !Array.isArray(rawPanels)) rawPanels = Object.values(rawPanels);
  if (!Array.isArray(rawPanels)) return out;

  for (const p of rawPanels) {
    if (!p || typeof p !== 'object') continue;
    // Keep only tabs panels. Sidebery v5: type 2 = tabs (1 = bookmarks, 3 = history).
    // Older string forms also accepted. Unknown/missing type -> include.
    if (!isTabsPanel(p.type)) continue;
    const name = p.name || p.title || p.id;
    const icon = sideberyIcon(p);
    out.push({ sideberyId: p.id, name, icon });
  }
  return out;
}

function isTabsPanel(type) {
  if (type == null) return true;
  if (typeof type === 'number') return type === 2;
  return ['tabs', 'tab', 'TabsPanel'].includes(type);
}

function sideberyIcon(p) {
  // Sidebery stores an iconSVG name (e.g. "icon_books"); map common ones to emoji.
  const map = {
    'icon_tabs': '🗂️', 'icon_book': '📖', 'icon_books': '📚',
    'icon_edu': '🎓', 'icon_flask': '🧪', 'icon_gamepad': '🎮',
    'icon_code': '💻', 'icon_cog': '⚙️', 'icon_settings': '⚙️',
    'icon_star': '⭐', 'icon_circle': '⚪', 'icon_play': '▶️',
    'icon_mail': '✉️', 'icon_person': '👤', 'icon_global': '🌐',
    'icon_clock': '🕒', 'icon_cart': '🛒', 'icon_dollar': '💲',
    'icon_fence': '🚧', 'icon_fingerprint': '🔎', 'icon_food': '🍔',
    'icon_fox': '🦊', 'icon_pet': '🐾', 'icon_tree': '🌳',
    'icon_vacation': '🏖️', 'vacation': '🏖️'
  };
  const key = p.iconSVG || p.icon;
  if (p.iconEmoji) return p.iconEmoji;
  if (key && map[key]) return map[key];
  return '📄';
}

// --- Snapshots ------------------------------------------------------------

const DEFAULT_SNAPSHOT_PERIOD = 1; // hours
const DEFAULT_MAX_SNAPSHOTS = 10;
const ALARM_NAME = 'houdini-snapshot';

async function getSnapshotSettings() {
  const data = await browser.storage.local.get(['snapshotPeriod', 'maxSnapshots']);
  return {
    period: data.snapshotPeriod ?? DEFAULT_SNAPSHOT_PERIOD,
    maxSnapshots: data.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS
  };
}

async function takeSnapshot() {
  const { panels, activePanel } = await getPanels();
  const { maxSnapshots } = await getSnapshotSettings();

  const tabs = await browser.tabs.query({});
  const tabAssignments = [];
  for (const tab of tabs) {
    const panelId = await browser.sessions.getTabValue(tab.id, 'panel');
    if (panelId) tabAssignments.push({ url: normalizeUrl(tab.url), panelId });
  }

  const snapshot = {
    timestamp: Date.now(),
    panels: JSON.parse(JSON.stringify(panels)),
    activePanel,
    tabAssignments
  };

  const data = await browser.storage.local.get('snapshots');
  let snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  snapshots.push(snapshot);
  if (snapshots.length > maxSnapshots) snapshots = snapshots.slice(snapshots.length - maxSnapshots);
  await browser.storage.local.set({ snapshots });
  return { ok: true, snapshot };
}

async function rollbackSnapshot(index) {
  const data = await browser.storage.local.get('snapshots');
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  const snapshot = snapshots[index];
  if (!snapshot) return { ok: false, error: 'Snapshot not found.' };

  await savePanels(snapshot.panels);
  await browser.storage.local.set({ activePanel: snapshot.activePanel });

  const validIds = new Set(snapshot.panels.map(p => p.id));
  const fallback = snapshot.activePanel;

  // Working list of snapshot entries; consumed as current tabs are matched.
  const snapLeft = snapshot.tabAssignments.map(a => ({
    url: a.url,
    panelId: validIds.has(a.panelId) ? a.panelId : fallback
  }));

  const currentTabs = await browser.tabs.query({});
  const toClose = [];
  const toRetag = []; // { tabId, panelId }

  for (const tab of currentTabs) {
    const normalUrl = normalizeUrl(tab.url);
    const matchIdx = snapLeft.findIndex(a => a.url === normalUrl);
    if (matchIdx !== -1) {
      toRetag.push({ tabId: tab.id, panelId: snapLeft[matchIdx].panelId });
      snapLeft.splice(matchIdx, 1);
    } else {
      toClose.push(tab);
    }
  }

  // Remaining snapLeft entries have no current tab -> reopen (http/https only).
  const toOpen = snapLeft.filter(a => /^https?:\/\//.test(a.url));

  for (const { tabId, panelId } of toRetag) {
    await browser.sessions.setTabValue(tabId, 'panel', panelId);
  }

  // Open missing tabs in the background.
  const opened = [];
  for (const { url, panelId } of toOpen) {
    const t = await browser.tabs.create({ url, active: false });
    await browser.sessions.setTabValue(t.id, 'panel', panelId);
    opened.push(t);
  }

  // Guarantee at least one tab stays open before we remove anything.
  if (toClose.length === currentTabs.length && toRetag.length === 0 && opened.length === 0) {
    const t = await browser.tabs.create({ active: true });
    await browser.sessions.setTabValue(t.id, 'panel', fallback);
  }

  // If the active tab is being closed, focus something that will survive.
  const activeTab = currentTabs.find(t => t.active);
  if (activeTab && toClose.some(t => t.id === activeTab.id)) {
    const safeId = toRetag.length ? toRetag[0].tabId : (opened.length ? opened[0].id : null);
    if (safeId) await browser.tabs.update(safeId, { active: true });
  }

  if (toClose.length > 0) await browser.tabs.remove(toClose.map(t => t.id));

  await switchPanel(snapshot.activePanel);
  return { ok: true };
}

async function deleteSnapshot(index) {
  const data = await browser.storage.local.get('snapshots');
  let snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  if (index < 0 || index >= snapshots.length) return { ok: false, error: 'Snapshot not found.' };
  snapshots.splice(index, 1);
  await browser.storage.local.set({ snapshots });
  return { ok: true };
}

async function updateSnapshotSettings(period, maxSnapshots) {
  const updates = {};
  if (period != null) updates.snapshotPeriod = Math.max(1, parseInt(period) || DEFAULT_SNAPSHOT_PERIOD);
  if (maxSnapshots != null) updates.maxSnapshots = Math.max(1, parseInt(maxSnapshots) || DEFAULT_MAX_SNAPSHOTS);
  await browser.storage.local.set(updates);
  await resetSnapshotAlarm();
}

// Only creates the alarm if it doesn't already exist.
// Preserves Firefox's "fire missed alarm on next launch" behavior.
async function initSnapshotAlarm() {
  const existing = await browser.alarms.get(ALARM_NAME);
  if (!existing) {
    const { period } = await getSnapshotSettings();
    browser.alarms.create(ALARM_NAME, { periodInMinutes: period * 60 });
  }
}

// Called when settings change: clears and recreates with new period.
async function resetSnapshotAlarm() {
  await browser.alarms.clear(ALARM_NAME);
  const { period } = await getSnapshotSettings();
  browser.alarms.create(ALARM_NAME, { periodInMinutes: period * 60 });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) takeSnapshot();
});

// --- wiring ---------------------------------------------------------------

function notifyChanged() {
  browser.runtime.sendMessage({ type: 'houdini:changed' }).catch(() => {});
}

// Tag every new tab with the currently active panel.
browser.tabs.onCreated.addListener(async (tab) => {
  const { activePanel } = await getPanels();
  await browser.sessions.setTabValue(tab.id, 'panel', activePanel);
});

browser.runtime.onMessage.addListener(async (msg) => {
  switch (msg && msg.cmd) {
    case 'getState': {
      const state = await getPanels();
      state.counts = await panelTabCounts();
      return state;
    }
    case 'switch':       return switchPanel(msg.panelId);
    case 'add':          return addPanel(msg.name, msg.icon);
    case 'update':       return updatePanel(msg.id, msg.name, msg.icon);
    case 'remove':       return removePanel(msg.id);
    case 'reorder':      return reorderPanels(msg.order);
    case 'migrate':      return migrateFromSidebery(msg.backup);
    case 'reset':        return resetAll();
    case 'takeSnapshot': return takeSnapshot();
    case 'rollbackSnapshot': return rollbackSnapshot(msg.index);
    case 'deleteSnapshot':   return deleteSnapshot(msg.index);
    case 'getSnapshots': {
      const snapData = await browser.storage.local.get('snapshots');
      const snapSettings = await getSnapshotSettings();
      return { snapshots: snapData.snapshots || [], ...snapSettings };
    }
    case 'updateSnapshotSettings': return updateSnapshotSettings(msg.period, msg.maxSnapshots);
    case 'listPanelTabs': return listPanelTabs(msg.panelId);
    case 'activateTab':  return browser.tabs.update(msg.tabId, { active: true });
    case 'closeTab':     return browser.tabs.remove(msg.tabId);
    case 'newTab':       return browser.tabs.create({ active: true });
  }
});

// Tabs (with title/favicon) belonging to a panel, for the sidebar list.
async function listPanelTabs(panelId) {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const out = [];
  for (const tab of tabs) {
    const p = await browser.sessions.getTabValue(tab.id, 'panel');
    if (p === panelId) {
      out.push({ id: tab.id, title: tab.title, url: tab.url,
                 favIconUrl: tab.favIconUrl, active: tab.active });
    }
  }
  return out;
}

// Keep the sidebar tab list fresh on tab changes.
for (const ev of ['onActivated', 'onUpdated', 'onRemoved', 'onMoved']) {
  if (browser.tabs[ev]) browser.tabs[ev].addListener(() => notifyChanged());
}

getPanels(); // ensure defaults exist on load
initSnapshotAlarm();
