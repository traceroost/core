// state.ts touches two DOM globals unconditionally at module scope: `window.__INITIAL_*__` (its
// two module-level signal initializers) and `document.documentElement` (applyThemeAttribute,
// called once at import time to sync the anti-flash theme attribute). There is no real `window`/
// `document` under plain Node/Mocha, so every test file that imports state.ts must import this
// file first, for its side effect alone.
(globalThis as { window?: unknown }).window = {
  __INITIAL_SESSION_SUMMARY__: null,
  __INITIAL_TOOL_CALLS__: {},
}
;(globalThis as { document?: unknown }).document = {
  documentElement: { removeAttribute() {}, setAttribute() {} },
  getElementById() { return null },
}
