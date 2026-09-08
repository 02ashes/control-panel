(function () {
  'use strict';

  const storageKey = 'control-panel.theme';
  const root = document.documentElement;
  const validTheme = value => value === 'light' || value === 'dark';

  function updateControls() {
    const light = root.dataset.workTheme === 'light';
    document.querySelectorAll('[data-work-theme-toggle]').forEach(button => {
      // A stable label makes this a genuine accessible on/off toggle.
      button.textContent = 'Светлая тема';
      button.setAttribute('aria-pressed', String(light));
      button.setAttribute('title', light ? 'Переключить на тёмную тему' : 'Переключить на светлую тему');
      if (button.tagName === 'BUTTON') button.type = 'button';
    });
  }

  function applyTheme(value, persist) {
    const theme = validTheme(value) ? value : 'dark';
    root.dataset.workTheme = theme;
    if (persist) {
      try { localStorage.setItem(storageKey, theme); } catch (_) { /* Private mode still supports this page's theme. */ }
    }
    updateControls();
  }

  let initialTheme = 'dark';
  try {
    const savedTheme = localStorage.getItem(storageKey);
    if (validTheme(savedTheme)) initialTheme = savedTheme;
  } catch (_) { /* Storage can be unavailable without breaking the workbench. */ }

  // This small file is loaded synchronously in <head> to avoid a palette flash.
  applyTheme(initialTheme, false);

  document.addEventListener('click', event => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('[data-work-theme-toggle]');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    applyTheme(root.dataset.workTheme === 'light' ? 'dark' : 'light', true);
  });

  window.addEventListener('storage', event => {
    if (event.storageArea) {
      try { if (event.storageArea !== localStorage) return; } catch (_) { return; }
    }
    if (event.key === storageKey || event.key === null) applyTheme(event.newValue, false);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateControls, { once: true });
  } else {
    updateControls();
  }
}());
