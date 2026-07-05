// Houdini background: owns panel state + the show/hide tab logic.
// UIs (popup, sidebar, manage page) talk to it via runtime messages.

const DEFAULT_PANELS = [
  { id: 'default', name: 'General', icon: '📁' }
];

// In-memory cache so onCreated can tag new tabs without waiting for storage,
// preventing the race where switchPanel adopts an untagged mid-flight tab.
let activePanelCache = null;

// In-memory cache of the panel list, kept alongside activePanelCache so
// container lookups (containerForPanel, called on every tab creation) don't
// need a storage round-trip that would also re-read (and so re-clobber)
// activePanelCache mid-transition.
let panelsCache = null;

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
  panelsCache = panels;
  return { panels, activePanel };
}

async function savePanels(panels) {
  await browser.storage.local.set({ panels });
  panelsCache = panels;
  rebuildTabMenu(); // panel list changed -> refresh the right-click menu
}

// --- Panel color theming ----------------------------------------------------
// A panel may carry an optional `color` (hex string). While that panel is
// active the whole browser chrome (tab bar, toolbar, URL bar, sidebar, popups,
// new tab page) is tinted with shades derived from it via browser.theme.update.
// Panels without a color restore the user's own theme.

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

// Blend rgb toward target by t (0..1).
function mixRgb(rgb, target, t) {
  return rgb.map((v, i) => v + (target[i] - v) * t);
}

// WCAG relative luminance, for picking readable text.
function relLuminance([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function textOn(rgb) {
  return relLuminance(rgb) > 0.4 ? '#15141a' : '#fbfbfe';
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

// Derive a full Firefox theme from one base color.
function buildTheme(baseHex) {
  const base = hexToRgb(baseHex);
  if (!base) return null;
  const frame = mixRgb(base, BLACK, 0.30);   // tab strip
  const toolbar = base;                       // nav bar + selected tab
  const field = mixRgb(base, BLACK, 0.45);   // URL/search bar
  const fieldFocus = mixRgb(base, BLACK, 0.55);
  const sidebar = mixRgb(base, BLACK, 0.15);
  const popup = mixRgb(base, BLACK, 0.35);   // menus, dropdowns
  const highlight = mixRgb(base, WHITE, 0.22);
  const ntp = mixRgb(base, BLACK, 0.55);     // new tab page
  return {
    colors: {
      frame: rgbToHex(frame),
      frame_inactive: rgbToHex(mixRgb(frame, BLACK, 0.2)),
      tab_background_text: textOn(frame),
      tab_selected: rgbToHex(toolbar),
      tab_text: textOn(toolbar),
      tab_line: rgbToHex(highlight),
      toolbar: rgbToHex(toolbar),
      toolbar_text: textOn(toolbar),
      bookmark_text: textOn(toolbar),
      icons: textOn(toolbar),
      toolbar_field: rgbToHex(field),
      toolbar_field_text: textOn(field),
      toolbar_field_border: 'transparent',
      toolbar_field_focus: rgbToHex(fieldFocus),
      toolbar_field_text_focus: textOn(fieldFocus),
      toolbar_field_highlight: rgbToHex(highlight),
      toolbar_field_highlight_text: textOn(highlight),
      sidebar: rgbToHex(sidebar),
      sidebar_text: textOn(sidebar),
      sidebar_border: rgbToHex(mixRgb(sidebar, BLACK, 0.3)),
      sidebar_highlight: rgbToHex(highlight),
      sidebar_highlight_text: textOn(highlight),
      popup: rgbToHex(popup),
      popup_text: textOn(popup),
      popup_border: rgbToHex(mixRgb(popup, WHITE, 0.15)),
      popup_highlight: rgbToHex(highlight),
      popup_highlight_text: textOn(highlight),
      ntp_background: rgbToHex(ntp),
      ntp_text: textOn(ntp)
    }
  };
}

// Apply (or clear) the browser theme for a panel. Applied to every window:
// the active panel is global, so the chrome color follows it everywhere.
async function applyPanelTheme(panelId) {
  if (!browser.theme || !browser.theme.update) return;
  const { panels } = await getPanels();
  const panel = panels.find(p => p.id === panelId);
  const theme = panel && panel.color ? buildTheme(panel.color) : null;
  try {
    if (theme) await browser.theme.update(theme);
    else await browser.theme.reset(); // back to the user's own theme
  } catch {}
}

// --- Containers (Firefox contextual identities) -----------------------------
// A panel may carry an optional `containerId` (a cookieStoreId). New tabs
// opened while that panel is active are steered into that container: explicit
// tabs.create() calls below pass it directly, and onCreated (further down)
// catches organically-opened tabs (Ctrl+T, links, ...) and reopens them in
// the right container when they didn't land there on their own.

function containersSupported() {
  return !!browser.contextualIdentities;
}

async function listContainers() {
  if (!containersSupported()) return [];
  try { return await browser.contextualIdentities.query({}); }
  catch { return []; }
}

// The cookieStoreId a new tab should open in for this panel, or undefined
// (meaning: use whatever container Firefox would pick by default). Verified
// against the live container list so a deleted-in-Firefox container can't
// make tabs.create() throw everywhere this is used.
async function containerForPanel(panelId) {
  if (!containersSupported()) return undefined;
  // Prefer the in-memory list: this runs on every tab creation, and a full
  // getPanels() call would re-read storage and re-clobber activePanelCache
  // (see the comment above it) during switchPanel's brief write-then-cache
  // window. Falls back to a real read only if nothing's cached yet (startup).
  const panels = panelsCache || (await getPanels()).panels;
  const panel = panels.find(p => p.id === panelId);
  const id = panel && panel.containerId;
  if (!id) return undefined;
  const live = await listContainers();
  return live.some(c => c.cookieStoreId === id) ? id : undefined;
}

// Skip container reassignment for the first few seconds after the background
// page loads: Firefox's own session restore fires onCreated for every
// restored tab, and thrashing all of them through close+reopen on every
// browser start (before the user has even looked at anything) isn't worth it.
const STARTUP_GRACE_MS = 4000;
const startupDeadline = Date.now() + STARTUP_GRACE_MS;
function isStartupSettling() { return Date.now() < startupDeadline; }

// Tabs Houdini itself just created for a specific (possibly non-active)
// panel — via createTabForPanel below, or moveTabToContainer's bulk re-link.
// The generic onCreated listener must not re-tag these to whatever panel
// happens to be active right now; the creator already tagged them correctly.
const selfTaggedTabs = new Set();
function markSelfTagged(tabId) {
  selfTaggedTabs.add(tabId);
  setTimeout(() => selfTaggedTabs.delete(tabId), 15000); // onCreated fires almost immediately; just don't leak
}

// Create a tab explicitly for `panelId`, which may not be the active panel
// (e.g. a snapshot restore or "move to panel" reopening tabs in the
// background). Steers it into that panel's container and tags it, without
// racing onCreated's generic active-panel tagging.
async function createTabForPanel(panelId, opts) {
  const cookieStoreId = await containerForPanel(panelId);
  const t = await browser.tabs.create({ ...opts, ...(cookieStoreId ? { cookieStoreId } : {}) });
  markSelfTagged(t.id);
  await browser.sessions.setTabValue(t.id, 'panel', panelId);
  return t;
}

// Only reopen tabs whose URL can safely move containers. Privileged pages
// (about:, moz-extension:, etc.) can't carry a container swap, aside from a
// bare new-tab page.
function isReassignableUrl(url) {
  if (!url || url === 'about:blank' || url === 'about:newtab') return true;
  return /^(https?|ftp):\/\//i.test(url);
}

// Firefox tabs.Tab has no Chrome-style `pendingUrl` — a tab opened via a link
// or window.open() commonly starts as about:blank and only gets its real
// destination a beat later via onUpdated. Wait briefly for that so a
// container-swap doesn't strand the navigation on a blank tab.
function awaitRealUrl(tabId, currentUrl) {
  if (currentUrl && currentUrl !== 'about:blank') return Promise.resolve(currentUrl);
  return new Promise((resolve) => {
    let done = false;
    const finish = (url) => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(url);
    };
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.url) finish(changeInfo.url);
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(currentUrl), 800);
  });
}

// A freshly (organically) created tab didn't land in its panel's linked
// container: close it and recreate it there, preserving URL/position/active
// state. Returns the replacement tab, or null if reassignment wasn't
// possible. The replacement deliberately isn't self-tagged — it re-fires
// onCreated, which tags + groups it via the normal active-panel path below.
async function reassignContainer(tab, cookieStoreId) {
  const url = await awaitRealUrl(tab.id, tab.url);
  if (!isReassignableUrl(url)) return null;

  // The wait above can take up to 800ms; re-check the tab still exists and
  // grab its current index/active state rather than the stale event-time one.
  let fresh;
  try { fresh = await browser.tabs.get(tab.id); } catch { return null; }
  if (fresh.cookieStoreId === cookieStoreId) return null; // already fixed or moved on

  const opts = { cookieStoreId, active: fresh.active, index: fresh.index, windowId: fresh.windowId };
  if (fresh.openerTabId != null) opts.openerTabId = fresh.openerTabId;
  if (url && url !== 'about:blank' && url !== 'about:newtab') opts.url = url;

  let created;
  try { created = await browser.tabs.create(opts); }
  catch {
    delete opts.openerTabId; // opener may be gone or in another window
    try { created = await browser.tabs.create(opts); } catch { return null; }
  }
  try { await browser.tabs.remove(tab.id); } catch {}
  return created;
}

// Recreate one existing tab inside a different container, carrying over the
// state reassignContainer doesn't need to (it only ever runs on brand-new
// tabs): pinned/per-panel-pin, native group membership, saved-group metadata
// for tabs currently hidden, and the panel tag itself (a new tab id needs it
// re-set). Returns the replacement tab, or null if the move wasn't possible.
async function moveTabToContainer(tab, cookieStoreId) {
  // Private-browsing tabs are always cookieStoreId 'firefox-private' and
  // can't be moved into an arbitrary container; tabs.create() would just throw.
  if (tab.incognito) return null;
  const url = tab.url; // an existing tab always has its real url, unlike a brand-new one
  if (!isReassignableUrl(url)) return null;

  const [panelId, panelPinnedRaw, savedGroup] = await Promise.all([
    browser.sessions.getTabValue(tab.id, 'panel'),
    browser.sessions.getTabValue(tab.id, 'panelPinned'),
    browser.sessions.getTabValue(tab.id, 'savedGroup')
  ]);
  const panelPinned = panelPinnedRaw === true;
  const groupId = (tab.groupId != null && tab.groupId !== -1) ? tab.groupId : null;

  // Create unpinned first: a pinned tab can't take an arbitrary index or join
  // a group, so pin (and let Firefox reposition it) after those are set.
  const opts = { cookieStoreId, active: tab.active, index: tab.index, windowId: tab.windowId };
  if (tab.openerTabId != null) opts.openerTabId = tab.openerTabId;
  if (url && url !== 'about:blank' && url !== 'about:newtab') opts.url = url;

  // A different container means a different content process, so recreating a
  // tab here is a full page load, not a cheap metadata copy — for every tab
  // in the panel at once, that's what was stalling the browser for several
  // seconds. Load lazily (like applySnapshot's reopen does) for every tab
  // except the one actually on screen right now, which Firefox won't let
  // stay discarded anyway.
  let created = null;
  if (!tab.active && opts.url) {
    const discardedOpts = { ...opts, discarded: true, title: tab.title || url };
    try { created = await browser.tabs.create(discardedOpts); }
    catch {
      delete discardedOpts.openerTabId;
      try { created = await browser.tabs.create(discardedOpts); } catch { created = null; }
    }
  }
  if (!created) {
    try { created = await browser.tabs.create(opts); }
    catch {
      delete opts.openerTabId;
      try { created = await browser.tabs.create(opts); } catch { return null; }
    }
  }

  markSelfTagged(created.id); // this panel may not be the active one — don't let onCreated re-tag it
  if (panelId) await browser.sessions.setTabValue(created.id, 'panel', panelId);
  if (savedGroup) await browser.sessions.setTabValue(created.id, 'savedGroup', savedGroup);
  if (groupId != null) {
    try { await browser.tabs.group({ groupId, tabIds: created.id }); } catch {}
  }
  if (tab.pinned) {
    try { await browser.tabs.update(created.id, { pinned: true }); } catch {}
    if (panelPinned) await browser.sessions.setTabValue(created.id, 'panelPinned', true);
  }
  if (tab.hidden) {
    try { await browser.tabs.hide(created.id); } catch {}
  }

  try { await browser.tabs.remove(tab.id); } catch {}
  return created;
}

// Move every tab currently tagged to a panel into a container (or back to
// 'firefox-default' when the panel's link is cleared). Runs across all
// windows since the panel tag isn't window-scoped. Tabs already in the
// target container are left alone. Every matching tab is migrated
// concurrently rather than one at a time — sequential processing meant each
// tab's close+reopen (several round-trips apiece) queued up behind the last,
// so a visible panel with a handful of tabs would visibly flicker tabs
// closed-and-reopened for several seconds. Running them in parallel cuts
// that down to roughly the time for one tab's worth of round-trips, at the
// cost of scrambling tab order (concurrent creates/removes don't land in
// their original slots) — fixed up below by replaying each replacement back
// to its original index, ascending, once every migration has landed.
async function reassignPanelTabsToContainer(panelId, cookieStoreId) {
  if (!containersSupported()) return;
  const allTabs = await browser.tabs.query({});
  const isTarget = await Promise.all(allTabs.map(async (tab) => {
    if (tab.cookieStoreId === cookieStoreId) return false;
    return (await browser.sessions.getTabValue(tab.id, 'panel')) === panelId;
  }));
  const targets = allTabs.filter((_, i) => isTarget[i]);
  const created = await Promise.all(targets.map(tab => moveTabToContainer(tab, cookieStoreId)));

  // Replay each successfully-migrated tab back to the index its predecessor
  // held, ascending — the standard trick for reconstructing an exact order
  // via single-item moves: once the lower slots are pinned down, placing the
  // next tab at its original index can't disturb them.
  const restores = targets
    .map((tab, i) => ({ id: created[i] && created[i].id, windowId: tab.windowId, index: tab.index }))
    .filter(r => r.id != null)
    .sort((a, b) => a.index - b.index);
  for (const r of restores) {
    try { await browser.tabs.move(r.id, { windowId: r.windowId, index: r.index }); } catch {}
  }
}

// Count how many tabs are tagged to each panel (current window).
async function panelTabCounts() {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const counts = {};
  for (const tab of tabs) {
    const panelPinned = (await browser.sessions.getTabValue(tab.id, 'panelPinned')) === true;
    if (tab.pinned && !panelPinned) continue; // global pin: owned by no panel
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
  applyPanelTheme(targetPanel); // tint the chrome; independent of tab shuffling

  const tabsToShow = [];
  const tabsToHide = [];
  const toPin = [];            // per-panel pins entering their panel -> pin them
  const toUnpinThenHide = [];  // per-panel pins leaving their panel -> unpin first

  for (const tab of allTabs) {
    const panelPinned = (await browser.sessions.getTabValue(tab.id, 'panelPinned')) === true;

    // Global pin: natively pinned but not flagged per-panel. Lives in every
    // panel, so Houdini never hides or re-tags it.
    if (tab.pinned && !panelPinned) continue;

    let p = await browser.sessions.getTabValue(tab.id, 'panel');
    if (!p || !panels.some(x => x.id === p)) {
      // Untagged or orphaned tab -> adopt into the panel being opened.
      p = targetPanel;
      await browser.sessions.setTabValue(tab.id, 'panel', targetPanel);
    }
    if (p === targetPanel) {
      tabsToShow.push(tab.id);
      if (panelPinned && !tab.pinned) toPin.push(tab.id);
    } else {
      if (tab.pinned) toUnpinThenHide.push(tab.id); // per-panel pin leaving
      tabsToHide.push(tab.id);
    }
  }

  // Show the panel's tabs first — a hidden tab can't be made active, so we must
  // un-hide before focusing the one we want.
  if (tabsToShow.length === 0) {
    const newTab = await createTabForPanel(targetPanel, { active: true });
    tabsToShow.push(newTab.id);
  } else {
    await browser.tabs.show(tabsToShow);
    await restoreGroups(tabsToShow);
    // Re-pin this panel's per-panel pins. Firefox appends them after any global
    // pins, giving the [global][global][per-panel] ordering.
    for (const id of toPin) {
      try { await browser.tabs.update(id, { pinned: true }); } catch {}
    }
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
    // A pinned tab can't be hidden; unpin the leaving per-panel pins first.
    for (const id of toUnpinThenHide) {
      try { await browser.tabs.update(id, { pinned: false }); } catch {}
    }
    await saveAndUngroup(tabsToHide, allTabs);
    await browser.tabs.hide(tabsToHide);
  }

  notifyChanged();
}

async function addPanel(name, icon, color, containerId) {
  const { panels } = await getPanels();
  const panel = { id: uid(), name: name || 'Panel', icon: icon || '📄' };
  if (color) panel.color = color;
  if (containerId) panel.containerId = containerId;
  panels.push(panel);
  await savePanels(panels);
  await switchPanel(panel.id); // switches + auto-creates new tab in empty panel
  return panel;
}

// color/containerId: undefined = leave as is, ''/null (when passed) = clear, value = set.
async function updatePanel(id, name, icon, color, containerId) {
  const { panels, activePanel } = await getPanels();
  const panel = panels.find(p => p.id === id);
  if (!panel) return;
  if (name != null) panel.name = name;
  if (icon != null) panel.icon = icon;
  if (color !== undefined) {
    if (color) panel.color = color;
    else delete panel.color;
  }
  let containerChanged = false;
  if (containerId !== undefined) {
    containerChanged = (panel.containerId || '') !== (containerId || '');
    if (containerId) panel.containerId = containerId;
    else delete panel.containerId;
  }
  await savePanels(panels);
  if (color !== undefined && id === activePanel) applyPanelTheme(id);
  // Linking/unlinking a container moves this panel's existing tabs too, not
  // just future ones — otherwise old tabs would sit stranded in the old
  // container while new tabs open in the new one.
  if (containerChanged) await reassignPanelTabsToContainer(id, containerId || 'firefox-default');
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
    if (sp.color) panel.color = sp.color;
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
    out.push({ sideberyId: p.id, name, icon, color: sideberyColor(p) });
  }
  return out;
}

// Sidebery colors panels with Firefox container color names; map to hex.
function sideberyColor(p) {
  const map = {
    blue: '#37adff', turquoise: '#00c79a', green: '#51cd00',
    yellow: '#ffcb00', orange: '#ff9f00', red: '#ff613d',
    pink: '#ff4bda', purple: '#af51f5'
  };
  return (p.color && map[p.color]) || null;
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
  await browser.storage.local.set({ snapshots, lastSnapshotTime: snapshot.timestamp });
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
    const cookieStoreId = await containerForPanel(panelId);
    const containerOpt = cookieStoreId ? { cookieStoreId } : {};
    try {
      // title must be non-empty or older Firefox silently drops the discarded
      // flag and loads the page; fall back to the URL as the label.
      t = await browser.tabs.create({ url, active: false, discarded: true, title: title || url, ...containerOpt });
    } catch {
      // Some URLs can't be created discarded (e.g. title mismatch); fall back.
      t = await browser.tabs.create({ url, active: false, ...containerOpt });
    }
    markSelfTagged(t.id); // panelId here is the snapshot's, not necessarily the active panel
    await browser.sessions.setTabValue(t.id, 'panel', panelId);
    opened.push(t);
  }

  // Guarantee at least one tab stays open before we remove anything.
  if (toClose.length === currentTabs.length && toRetag.length === 0 && opened.length === 0) {
    const t = await createTabForPanel(fallback, { active: true });
    opened.push(t);
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

// A single long alarm is unreliable for periods like 24h: alarms die on
// browser restart and their countdown pauses during OS suspend. Instead a
// short heartbeat alarm ticks and the wall clock decides: snapshot when
// Date.now() - lastSnapshotTime exceeds the period.
const HEARTBEAT_MINUTES = 15;

async function checkSnapshotDue() {
  const { period } = await getSnapshotSettings();
  const { lastSnapshotTime } = await browser.storage.local.get('lastSnapshotTime');
  const elapsed = Date.now() - (lastSnapshotTime ?? 0);
  if (elapsed >= period * 60 * 60 * 1000) await takeSnapshot();
}

function scheduleSnapshotAlarm() {
  // First tick after 1 minute so session restore settles before an
  // overdue snapshot is captured.
  browser.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: HEARTBEAT_MINUTES });
}

// Only creates the alarm if it doesn't already exist: the background page
// restarts whenever an alarm wakes it, and recreating the alarm on every
// wake would reset the tick cycle each time.
async function initSnapshotAlarm() {
  const existing = await browser.alarms.get(ALARM_NAME);
  if (!existing) scheduleSnapshotAlarm();
}

// Called when settings change. The heartbeat itself doesn't depend on the
// period (checkSnapshotDue reads it live), but a fresh tick makes a
// shortened period take effect within a minute instead of a full heartbeat.
async function resetSnapshotAlarm() {
  await browser.alarms.clear(ALARM_NAME);
  scheduleSnapshotAlarm();
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkSnapshotDue();
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
    // Re-pin any per-panel pins that now belong to the visible panel.
    for (const id of expandedIds) {
      const t = winTabs.find(x => x.id === id);
      const panelPinned = (await browser.sessions.getTabValue(id, 'panelPinned')) === true;
      if (panelPinned && t && !t.pinned) {
        try { await browser.tabs.update(id, { pinned: true }); } catch {}
      }
    }
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
        await createTabForPanel(activePanel, { active: true });
      } else {
        await browser.tabs.update(target, { active: true });
      }
    }
    // Global pins live in every panel and can't be hidden; per-panel pins must be
    // unpinned before hiding. Build the hide set accordingly.
    const hideIds = [];
    for (const id of expandedIds) {
      const t = winTabs.find(x => x.id === id);
      const panelPinned = (await browser.sessions.getTabValue(id, 'panelPinned')) === true;
      if (t && t.pinned && !panelPinned) continue; // global pin: keep it visible
      if (t && t.pinned && panelPinned) {
        try { await browser.tabs.update(id, { pinned: false }); } catch {}
      }
      hideIds.push(id);
    }
    // Dissolve groups before hiding — tabs.hide() cannot hide grouped tabs.
    await saveAndUngroup(hideIds, winTabs);
    await browser.tabs.hide(hideIds);
  }

  notifyChanged();
}

// Toggle whether a tab is pinned to the currently active panel. A per-panel pin
// renders as a native pinned tab only while its panel is active; other panels
// unpin + hide it. Native pins without this flag are treated as global.
async function togglePanelPin(tab) {
  if (!tab) return;
  const { activePanel } = await getPanels();
  const panelPinned = (await browser.sessions.getTabValue(tab.id, 'panelPinned')) === true;
  if (panelPinned) {
    // Clear the flag first so the pinned-change listener treats this as our own
    // unpin, not a manual one.
    await browser.sessions.removeTabValue(tab.id, 'panelPinned');
    try { await browser.tabs.update(tab.id, { pinned: false }); } catch {}
  } else {
    // Pin it to the panel you're looking at. Pinning ejects the tab from any
    // native group automatically.
    await browser.sessions.setTabValue(tab.id, 'panel', activePanel);
    await browser.sessions.setTabValue(tab.id, 'panelPinned', true);
    try { await browser.tabs.update(tab.id, { pinned: true }); } catch {}
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

  // Toggle a per-panel pin on the right-clicked tab. Title is corrected to
  // reflect the tab's current state in menus.onShown below.
  browser.menus.create({
    id: 'houdini-pin-toggle',
    title: 'Pin on this panel',
    contexts: ['tab']
  });
}

if (browser.menus) {
  browser.menus.onClicked.addListener((info, tab) => {
    if (!tab || typeof info.menuItemId !== 'string') return;

    if (info.menuItemId === 'houdini-pin-toggle') {
      togglePanelPin(tab);
      return;
    }

    if (!info.menuItemId.startsWith('houdini-move:')) return;
    const panelId = info.menuItemId.slice('houdini-move:'.length);
    // info.selectedTabIds contains all highlighted tabs (Firefox 63+); fall back to single tab.
    const tabIds = (Array.isArray(info.selectedTabIds) && info.selectedTabIds.length > 0)
      ? info.selectedTabIds
      : [tab.id];
    moveTabsToPanel(tabIds, panelId);
  });

  // Correct the pin-toggle label to match the right-clicked tab's current state.
  if (browser.menus.onShown) {
    browser.menus.onShown.addListener(async (info, tab) => {
      if (!tab || !Array.isArray(info.contexts) || !info.contexts.includes('tab')) return;
      const panelPinned = (await browser.sessions.getTabValue(tab.id, 'panelPinned')) === true;
      browser.menus.update('houdini-pin-toggle', {
        title: panelPinned ? 'Unpin from this panel' : 'Pin on this panel'
      });
      browser.menus.refresh();
    });
  }
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
  const meta = new Map(); // groupId -> { title, color, collapsed, memberIds[] }
  for (const t of allWinTabs) {
    if (hideSet.has(t.id) && t.groupId != null && t.groupId !== -1) {
      if (!meta.has(t.groupId)) meta.set(t.groupId, { title: '', color: '', collapsed: false, memberIds: [] });
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
      info.collapsed = g.collapsed || false;
    } catch {}
    for (const tid of info.memberIds) {
      await browser.sessions.setTabValue(tid, 'savedGroup', { groupId: gid, title: info.title, color: info.color, collapsed: info.collapsed });
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
      byOriginGroup.set(saved.groupId, { title: saved.title, color: saved.color, collapsed: saved.collapsed === true, tabIds: [] });
    byOriginGroup.get(saved.groupId).tabIds.push(tid);
  }
  for (const [, info] of byOriginGroup) {
    try {
      const newGid = await browser.tabs.group({ tabIds: info.tabIds });
      if (info.title || info.color) await browser.tabGroups.update(newGid, { title: info.title, color: info.color });
      // Restore collapsed state last. Firefox refuses to collapse a group that
      // holds the active tab, so this is best-effort and may no-op for the
      // panel's focused group.
      if (info.collapsed) {
        try { await browser.tabGroups.update(newGid, { collapsed: true }); } catch {}
      }
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

// Tag every new tab with the currently active panel; steer it into the
// panel's linked container if it didn't already land there; group sub-tabs
// if enabled.
browser.tabs.onCreated.addListener(async (tab) => {
  // Houdini already created and fully tagged this tab itself (for a specific,
  // possibly non-active panel) — don't let the active-panel logic below touch it.
  if (selfTaggedTabs.has(tab.id)) return;

  const panelId = activePanelCache || (await getPanels()).activePanel;

  // Private-browsing tabs can't be moved into a regular container, and
  // freshly-restored session tabs shouldn't be thrashed on browser startup.
  if (!tab.incognito && !isStartupSettling()) {
    const cookieStoreId = await containerForPanel(panelId);
    if (cookieStoreId && tab.cookieStoreId !== cookieStoreId) {
      const replacement = await reassignContainer(tab, cookieStoreId);
      // The replacement fires its own onCreated with a matching cookieStoreId,
      // which tags + groups it below — nothing left to do for this original tab.
      if (replacement) return;
    }
  }

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
    case 'add':          return addPanel(msg.name, msg.icon, msg.color, msg.containerId);
    case 'update':       return updatePanel(msg.id, msg.name, msg.icon, msg.color, msg.containerId);
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
    case 'newTab': {
      const { activePanel } = await getPanels();
      return createTabForPanel(activePanel, { active: true });
    }
    case 'listContainers': return { supported: containersSupported(), containers: await listContainers() };
    case 'togglePanelPin': {
      const t = await browser.tabs.get(msg.tabId).catch(() => null);
      return togglePanelPin(t);
    }
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

// If the user manually unpins a per-panel pin that's visible in the active panel,
// respect it: drop the flag so we don't re-pin it on the next switch. Houdini's
// own unpin-on-leave retags the tab to a non-active panel first, so it's excluded
// by the panel === activePanel check.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.pinned !== false) return;
  const panelPinned = (await browser.sessions.getTabValue(tabId, 'panelPinned')) === true;
  if (!panelPinned) return;
  const { activePanel } = await getPanels();
  const p = await browser.sessions.getTabValue(tabId, 'panel');
  if (p === activePanel) {
    await browser.sessions.removeTabValue(tabId, 'panelPinned');
    notifyChanged();
  }
}, { properties: ['pinned'] });

// On load, reconcile per-panel pins with the active panel. Firefox restores the
// native pinned/hidden state across restarts, which can leave a per-panel pin
// pinned in the wrong panel; fix those here.
async function reconcilePins() {
  const { activePanel } = await getPanels();
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    const panelPinned = (await browser.sessions.getTabValue(tab.id, 'panelPinned')) === true;
    if (!panelPinned) continue;
    const p = await browser.sessions.getTabValue(tab.id, 'panel');
    if (p === activePanel) {
      if (tab.hidden) { try { await browser.tabs.show(tab.id); } catch {} }
      if (!tab.pinned) { try { await browser.tabs.update(tab.id, { pinned: true }); } catch {} }
    } else {
      if (tab.pinned) { try { await browser.tabs.update(tab.id, { pinned: false }); } catch {} }
      if (!tab.hidden && !tab.active) { try { await browser.tabs.hide(tab.id); } catch {} }
    }
  }
}

// Ensure defaults exist on load, then re-apply the active panel's tint (a
// browser restart clears theme.update styling).
getPanels().then(({ activePanel }) => applyPanelTheme(activePanel));
initSnapshotAlarm();
rebuildTabMenu();
reconcilePins();
