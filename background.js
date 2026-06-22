// Houdini background: owns panel state + the show/hide tab logic.
// UIs (popup, sidebar, manage page) talk to it via runtime messages.

const DEFAULT_PANELS = [
  { id: 'default', name: 'General', icon: '📁' }
];

// In-memory cache so onCreated can tag new tabs without waiting for storage,
// preventing the race where switchPanel adopts an untagged mid-flight tab.
let activePanelCache = null;

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
  activePanelCache = activePanel;
  return { panels, activePanel };
}

async function savePanels(panels) {
  await browser.storage.local.set({ panels });
  rebuildTabMenu(); // panel list changed -> refresh the right-click menu
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

// Per-panel memory of the last-focused tab, keyed by panel id.
async function getLastActive() {
  const d = await browser.storage.local.get('lastActiveTab');
  return (d.lastActiveTab && typeof d.lastActiveTab === 'object') ? d.lastActiveTab : {};
}
async function setLastActiveForPanel(panelId, tabId) {
  const map = await getLastActive();
  map[panelId] = tabId;
  await browser.storage.local.set({ lastActiveTab: map });
}

// Switch the visible panel: show tabs tagged for it, hide the rest.
async function switchPanel(targetPanel) {
  const { panels, activePanel: prevPanel } = await getPanels();
  if (!panels.some(p => p.id === targetPanel)) return;

  // Update cache immediately so any onCreated firing during this async
  // function tags new tabs to the right panel rather than appearing orphaned.
  activePanelCache = targetPanel;

  const allTabs = await browser.tabs.query({ currentWindow: true });

  // Remember the tab we're leaving on, so returning here restores it.
  const leavingTab = allTabs.find(t => t.active);
  if (leavingTab && prevPanel && prevPanel !== targetPanel) {
    await setLastActiveForPanel(prevPanel, leavingTab.id);
  }

  await browser.storage.local.set({ activePanel: targetPanel });

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

  // Show the panel's tabs first — a hidden tab can't be made active, so we must
  // un-hide before focusing the one we want.
  if (tabsToShow.length === 0) {
    const newTab = await browser.tabs.create({ active: true });
    await browser.sessions.setTabValue(newTab.id, 'panel', targetPanel);
    tabsToShow.push(newTab.id);
  } else {
    await browser.tabs.show(tabsToShow);
    await restoreGroups(tabsToShow);
  }

  // If the tab we're leaving is about to be hidden, move focus onto the tab we
  // last had open in this panel (or the first one). Firefox won't hide the
  // active tab, so this must happen before the hide call.
  const activeTab = allTabs.find(t => t.active);
  if (activeTab && tabsToHide.includes(activeTab.id)) {
    const remembered = (await getLastActive())[targetPanel];
    const focusId = (remembered && tabsToShow.includes(remembered)) ? remembered : tabsToShow[0];
    await browser.tabs.update(focusId, { active: true });
  }

  // Dissolve groups whose tabs are all leaving — tabs.hide() can't hide grouped tabs.
  if (tabsToHide.length > 0) {
    await saveAndUngroup(tabsToHide, allTabs);
    await browser.tabs.hide(tabsToHide);
  }

  notifyChanged();
}

async function addPanel(name, icon) {
  const { panels } = await getPanels();
  const panel = { id: uid(), name: name || 'Panel', icon: icon || '📄' };
  panels.push(panel);
  await savePanels(panels);
  await switchPanel(panel.id); // switches + auto-creates new tab in empty panel
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

// Serialize current panels + per-tab assignments (URL-keyed). Shared by
// snapshots and the native backup export.
async function captureState() {
  const { panels, activePanel } = await getPanels();
  const tabs = await browser.tabs.query({});
  const tabAssignments = [];
  for (const tab of tabs) {
    const panelId = await browser.sessions.getTabValue(tab.id, 'panel');
    if (panelId) tabAssignments.push({ url: normalizeUrl(tab.url), panelId, title: tab.title || '' });
  }
  return {
    timestamp: Date.now(),
    panels: JSON.parse(JSON.stringify(panels)),
    activePanel,
    tabAssignments
  };
}

async function takeSnapshot() {
  const { maxSnapshots } = await getSnapshotSettings();
  const snapshot = await captureState();

  const data = await browser.storage.local.get('snapshots');
  let snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  snapshots.push(snapshot);
  if (snapshots.length > maxSnapshots) snapshots = snapshots.slice(snapshots.length - maxSnapshots);
  await browser.storage.local.set({ snapshots });
  return { ok: true, snapshot };
}

// Restore a captured state: replace panels, re-tag tabs to match (reopen tabs
// closed since, close tabs opened since). Shared by rollback and import.
async function applySnapshot(snapshot) {
  await savePanels(snapshot.panels);
  // Last-active-tab memory is per-session tab ids; stale after a restore.
  await browser.storage.local.set({ activePanel: snapshot.activePanel, lastActiveTab: {} });

  const validIds = new Set(snapshot.panels.map(p => p.id));
  const fallback = snapshot.activePanel;

  // Working list of snapshot entries; consumed as current tabs are matched.
  const snapLeft = snapshot.tabAssignments.map(a => ({
    url: a.url,
    title: a.title || '',
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

  // Open missing tabs.
  // they load lazily on first focus to avoid OOM.
  const opened = [];
  for (const { url, panelId, title } of toOpen) {
    let t;
    try {
      // title must be non-empty or older Firefox silently drops the discarded
      // flag and loads the page; fall back to the URL as the label.
      t = await browser.tabs.create({ url, active: false, discarded: true, title: title || url });
    } catch {
      // Some URLs can't be created discarded (e.g. title mismatch); fall back.
      t = await browser.tabs.create({ url, active: false });
    }
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

async function rollbackSnapshot(index) {
  const data = await browser.storage.local.get('snapshots');
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  const snapshot = snapshots[index];
  if (!snapshot) return { ok: false, error: 'Snapshot not found.' };
  return applySnapshot(snapshot);
}

async function deleteSnapshot(index) {
  const data = await browser.storage.local.get('snapshots');
  let snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  if (index < 0 || index >= snapshots.length) return { ok: false, error: 'Snapshot not found.' };
  snapshots.splice(index, 1);
  await browser.storage.local.set({ snapshots });
  return { ok: true };
}

// --- Native backup --------------------------------------------------------

// Houdini's own export: same shape as a snapshot, marked so import can tell it
// apart from a Sidebery dump.
async function exportData() {
  return { houdiniBackup: 1, ...(await captureState()) };
}

// Restore a Houdini backup file (replaces panels, re-tags tabs).
async function importData(data) {
  if (!data || !Array.isArray(data.panels) || !Array.isArray(data.tabAssignments)) {
    return { ok: false, error: 'Not a Houdini backup file.' };
  }
  if (data.panels.length === 0) return { ok: false, error: 'Backup has no panels.' };
  await applySnapshot({
    panels: data.panels,
    activePanel: data.activePanel || data.panels[0].id,
    tabAssignments: data.tabAssignments
  });
  return { ok: true, panels: data.panels.length, tabs: data.tabAssignments.length };
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

// --- Keyboard shortcuts ---------------------------------------------------

// Switch to the panel `dir` steps from the active one (wraps around).
async function cyclePanel(dir) {
  const { panels, activePanel } = await getPanels();
  if (panels.length < 2) return;
  const i = panels.findIndex(p => p.id === activePanel);
  const next = panels[(i + dir + panels.length) % panels.length];
  if (next) await switchPanel(next.id);
}

async function switchPanelByIndex(idx) {
  const { panels } = await getPanels();
  if (panels[idx]) await switchPanel(panels[idx].id);
}

if (browser.commands) {
  browser.commands.onCommand.addListener((cmd) => {
    if (cmd === 'next-panel') return cyclePanel(1);
    if (cmd === 'prev-panel') return cyclePanel(-1);
    const m = /^switch-panel-(\d+)$/.exec(cmd);
    if (m) return switchPanelByIndex(parseInt(m[1], 10) - 1);
  });
}

// --- Move tab to panel (right-click menu) ---------------------------------

// Re-tag one tab into another panel, then fix visibility in its window.
async function moveTabsToPanel(tabIds, panelId) {
  const { panels, activePanel } = await getPanels();
  if (!panels.some(p => p.id === panelId)) return;

  const winTabs = await browser.tabs.query({ currentWindow: true });

  // Expand selection: if any selected tab is in a native tab group,
  // include all other members of that group.
  const tabIdSet = new Set(tabIds);
  const groupIds = new Set();
  for (const t of winTabs) {
    if (tabIdSet.has(t.id) && t.groupId != null && t.groupId !== -1) {
      groupIds.add(t.groupId);
    }
  }
  for (const t of winTabs) {
    if (t.groupId != null && groupIds.has(t.groupId)) tabIdSet.add(t.id);
  }
  const expandedIds = [...tabIdSet];

  await Promise.all(expandedIds.map(id => browser.sessions.setTabValue(id, 'panel', panelId)));

  if (panelId === activePanel) {
    await browser.tabs.show(expandedIds);
    await restoreGroups(expandedIds);
  } else {
    // If the active tab is being moved, focus a tab staying in current panel.
    const activeMoved = winTabs.find(t => t.active && tabIdSet.has(t.id));
    if (activeMoved) {
      let target = null;
      for (const t of winTabs) {
        if (tabIdSet.has(t.id)) continue;
        const p = await browser.sessions.getTabValue(t.id, 'panel');
        if (p === activePanel) { target = t.id; break; }
      }
      if (target == null) {
        const newTab = await browser.tabs.create({ active: true });
        await browser.sessions.setTabValue(newTab.id, 'panel', activePanel);
      } else {
        await browser.tabs.update(target, { active: true });
      }
    }
    // Dissolve groups before hiding — tabs.hide() cannot hide grouped tabs.
    await saveAndUngroup(expandedIds, winTabs);
    await browser.tabs.hide(expandedIds);
  }

  notifyChanged();
}

const TAB_MENU_PARENT = 'houdini-move-parent';

// Rebuild the tab context menu's panel submenu from the current panel list.
async function rebuildTabMenu() {
  if (!browser.menus) return;
  await browser.menus.removeAll();

  browser.menus.create({
    id: TAB_MENU_PARENT,
    title: 'Move to panel',
    contexts: ['tab']
  });

  const { panels } = await getPanels();
  for (const p of panels) {
    browser.menus.create({
      id: 'houdini-move:' + p.id,
      parentId: TAB_MENU_PARENT,
      title: `${p.icon || '📄'}  ${p.name}`,
      contexts: ['tab']
    });
  }
}

if (browser.menus) {
  browser.menus.onClicked.addListener((info, tab) => {
    if (!tab || typeof info.menuItemId !== 'string') return;
    if (!info.menuItemId.startsWith('houdini-move:')) return;
    const panelId = info.menuItemId.slice('houdini-move:'.length);
    // info.selectedTabIds contains all highlighted tabs (Firefox 63+); fall back to single tab.
    const tabIds = (Array.isArray(info.selectedTabIds) && info.selectedTabIds.length > 0)
      ? info.selectedTabIds
      : [tab.id];
    moveTabsToPanel(tabIds, panelId);
  });
}

// --- wiring ---------------------------------------------------------------

function notifyChanged() {
  browser.runtime.sendMessage({ type: 'houdini:changed' }).catch(() => {});
}

// --- Tab grouping ---------------------------------------------------------

// True only if this Firefox exposes the WebExtension tab-groups API.
function tabGroupsSupported() {
  return !!(browser.tabs && browser.tabs.group && browser.tabGroups);
}

// browser.tabs.hide() silently skips tabs that are inside a native tab group.
// Before hiding, dissolve groups whose every member is being hidden; persist
// group metadata in session storage so they can be reconstructed on show.
async function saveAndUngroup(tabIdArray, allWinTabs) {
  if (!tabGroupsSupported()) return;
  const hideSet = new Set(tabIdArray);
  const meta = new Map(); // groupId -> { title, color, memberIds[] }
  for (const t of allWinTabs) {
    if (hideSet.has(t.id) && t.groupId != null && t.groupId !== -1) {
      if (!meta.has(t.groupId)) meta.set(t.groupId, { title: '', color: '', memberIds: [] });
      meta.get(t.groupId).memberIds.push(t.id);
    }
  }
  for (const [gid, info] of meta) {
    // Skip groups that straddle panels — don't dissolve groups with visible members.
    const allMembers = allWinTabs.filter(t => t.groupId === gid).map(t => t.id);
    if (!allMembers.every(id => hideSet.has(id))) continue;
    try {
      const g = await browser.tabGroups.get(gid);
      info.title = g.title || '';
      info.color = g.color || '';
    } catch {}
    for (const tid of info.memberIds) {
      await browser.sessions.setTabValue(tid, 'savedGroup', { groupId: gid, title: info.title, color: info.color });
    }
    try { await browser.tabs.ungroup(info.memberIds); } catch {}
  }
}

// After showing tabs, rebuild any groups that were dissolved by saveAndUngroup.
async function restoreGroups(tabIdArray) {
  if (!tabGroupsSupported()) return;
  const byOriginGroup = new Map(); // original groupId -> { title, color, tabIds[] }
  for (const tid of tabIdArray) {
    const saved = await browser.sessions.getTabValue(tid, 'savedGroup');
    if (!saved) continue;
    await browser.sessions.removeTabValue(tid, 'savedGroup');
    if (!byOriginGroup.has(saved.groupId))
      byOriginGroup.set(saved.groupId, { title: saved.title, color: saved.color, tabIds: [] });
    byOriginGroup.get(saved.groupId).tabIds.push(tid);
  }
  for (const [, info] of byOriginGroup) {
    try {
      const newGid = await browser.tabs.group({ tabIds: info.tabIds });
      if (info.title || info.color) await browser.tabGroups.update(newGid, { title: info.title, color: info.color });
    } catch {}
  }
}

async function getGroupSubtabs() {
  const d = await browser.storage.local.get('groupSubtabs');
  return d.groupSubtabs === true;
}

// Put a freshly opened sub-tab into its opener's group (one level, flattened).
// If the opener isn't grouped yet, start a group from [opener, child].
async function groupSubtab(tab) {
  if (!tabGroupsSupported()) return;
  if (tab.openerTabId == null) return;
  let opener;
  try { opener = await browser.tabs.get(tab.openerTabId); }
  catch { return; } // opener already gone
  if (opener.windowId !== tab.windowId) return;

  // Stay within one panel: skip if opener belongs to a different panel.
  const childPanel = await browser.sessions.getTabValue(tab.id, 'panel');
  const openerPanel = await browser.sessions.getTabValue(opener.id, 'panel');
  if (childPanel && openerPanel && childPanel !== openerPanel) return;

  try {
    if (opener.groupId != null && opener.groupId !== -1) {
      await browser.tabs.group({ groupId: opener.groupId, tabIds: tab.id });
    } else if (opener.pinned) {
      // Pinned tabs can't join groups; keep opener pinned, group only the child.
      // Reuse the same child-group if this pinned opener already spawned children.
      const storedGid = await browser.sessions.getTabValue(opener.id, 'childGroupId');
      let gid = storedGid;
      if (gid == null) {
        gid = await browser.tabs.group({ tabIds: [tab.id] });
        const title = (opener.title || '').slice(0, 20);
        if (title) await browser.tabGroups.update(gid, { title });
        await browser.sessions.setTabValue(opener.id, 'childGroupId', gid);
      } else {
        await browser.tabs.group({ groupId: gid, tabIds: tab.id });
      }
    } else {
      const gid = await browser.tabs.group({ tabIds: [opener.id, tab.id] });
      const title = (opener.title || '').slice(0, 20);
      if (title) await browser.tabGroups.update(gid, { title });
    }
  } catch { /* grouping is best-effort; ignore failures */ }
}

// Tag every new tab with the currently active panel; group sub-tabs if enabled.
browser.tabs.onCreated.addListener(async (tab) => {
  const panelId = activePanelCache || (await getPanels()).activePanel;
  await browser.sessions.setTabValue(tab.id, 'panel', panelId);
  if (await getGroupSubtabs()) await groupSubtab(tab);
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
    case 'getGroupSetting': return { enabled: await getGroupSubtabs(), supported: tabGroupsSupported() };
    case 'setGroupSetting': return browser.storage.local.set({ groupSubtabs: msg.enabled === true });
    case 'exportData':   return exportData();
    case 'importData':   return importData(msg.data);
    case 'listPanelTabs': return listPanelTabs(msg.panelId);
    case 'searchTabs':   return searchAllTabs();
    case 'focusTab':     return focusTab(msg.tabId);
    case 'activateTab':  return browser.tabs.update(msg.tabId, { active: true });
    case 'closeTab':     return browser.tabs.remove(msg.tabId);
    case 'newTab':       return browser.tabs.create({ active: true });
  }
});

// Every tab in the window, tagged with its panel — for cross-panel search.
async function searchAllTabs() {
  const { panels } = await getPanels();
  const byId = Object.fromEntries(panels.map(p => [p.id, p]));
  const tabs = await browser.tabs.query({ currentWindow: true });
  const out = [];
  for (const tab of tabs) {
    const pid = await browser.sessions.getTabValue(tab.id, 'panel');
    const panel = byId[pid];
    out.push({
      id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl,
      active: tab.active, panelId: pid,
      panelName: panel ? panel.name : 'Unassigned',
      panelIcon: panel ? (panel.icon || '📄') : '❔'
    });
  }
  return out;
}

// Jump to a tab anywhere: switch to its panel (if hidden) then focus it.
async function focusTab(tabId) {
  const panelId = await browser.sessions.getTabValue(tabId, 'panel');
  const { panels, activePanel } = await getPanels();
  if (panelId && panelId !== activePanel && panels.some(p => p.id === panelId)) {
    await switchPanel(panelId);
  }
  await browser.tabs.update(tabId, { active: true });
}

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
rebuildTabMenu();
