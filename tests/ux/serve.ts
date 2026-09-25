/**
 * Bundles the shipped dashboard and serves it standalone, with a synthetic fixture bridge
 * standing in for the real VS Code webview host — no standalone server, log readers, agent
 * configuration, or account access. Started as this suite's Playwright `webServer` (see
 * playwright.config.ts); run directly via `node demo/run-ts.js tests/ux/serve.ts` too.
 */
import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { sessions } from './fixtures'

const PORT = Number(process.env.TRACEROOST_UX_PORT ?? 4310)

async function main() {
  await mkdir('test-results/ux', { recursive: true })
  // bundle:true with a single `outfile` still emits a sibling .css when the entry pulls in CSS
  // via import statements (esbuild's bundled-CSS behavior) — media/src/dashboard.tsx does, so
  // this one call produces both dashboard.js and dashboard.css.
  await build({
    entryPoints: ['media/src/dashboard.tsx'],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: 'test-results/ux/dashboard.js',
    jsx: 'automatic',
    jsxImportSource: 'preact',
  })

  const standalone = await readFile('standalone/server.ts', 'utf8')
  const theme = standalone.slice(
    standalone.indexOf('  <style>') + 9,
    standalone.indexOf('  </style>'),
  )

  const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>TraceRoost UX evaluation</title><style>${theme}</style><link rel="stylesheet" href="/dashboard.css"></head><body><div id="sa-main"><div id="app"></div></div><script>
window.__STANDALONE__ = true; window.__VERSION__ = 'UX fixture';
window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: () => {}, postMessage: msg => {
 if (msg.type === 'searchSessions') setTimeout(() => window.postMessage({ type: 'searchResults', sessions: ${JSON.stringify(sessions)}, totalCount: 64, context: msg.context }, '*'), 150);
}});
</script><script src="/dashboard.js"></script></body></html>`

  const server = createServer(async (req, res) => {
    if (req.url === '/dashboard.js' || req.url === '/dashboard.css') {
      res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript')
      res.end(await readFile(`test-results/ux${req.url}`))
    } else {
      res.setHeader('Content-Type', 'text/html')
      res.end(html)
    }
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`UX fixture server listening on http://127.0.0.1:${PORT}`)
  })
}

main()
