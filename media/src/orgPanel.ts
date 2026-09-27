/**
 * The webview's one seam to TraceRoost Pro's Org panel (media/src/cloud/panels/OrgPanel.tsx) —
 * App.tsx and tabs/Pricing.tsx import it from here, never from the cloud directory directly.
 *
 * The core edition's build (`node esbuild.js --edition=core`) resolves the re-export below to
 * media/src/orgPanel.core.tsx instead: a stub whose button and panel render nothing, whose
 * signals stay empty, and which handles no messages — so no module under media/src/cloud/ is
 * bundled. Mirrors src/cloudBridge.ts on the extension side.
 */

export * from './cloud/panels/OrgPanel'
