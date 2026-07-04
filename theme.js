// Shared theme bootstrap for Houdini pages (popup + settings).
// Mode is 'auto' | 'light' | 'dark', stored in browser.storage.local as
// uiTheme. 'auto' follows the OS via prefers-color-scheme. The resolved theme
// lands on <html data-theme="dark|light">; the raw mode on data-theme-mode.
// A localStorage mirror lets pages paint the right theme synchronously,
// before the async storage read returns.
(function () {
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  let mode = localStorage.getItem('uiTheme') || 'auto';

  function apply() {
    root.dataset.theme = mode === 'auto' ? (mq.matches ? 'light' : 'dark') : mode;
    root.dataset.themeMode = mode;
  }
  apply();

  browser.storage.local.get('uiTheme').then((d) => {
    mode = d.uiTheme || 'auto';
    localStorage.setItem('uiTheme', mode);
    apply();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.uiTheme) {
      mode = changes.uiTheme.newValue || 'auto';
      localStorage.setItem('uiTheme', mode);
      apply();
    }
  });

  mq.addEventListener('change', apply);

  window.uiTheme = {
    get mode() { return mode; },
    set(m) { browser.storage.local.set({ uiTheme: m }); } // onChanged repaints
  };
})();
