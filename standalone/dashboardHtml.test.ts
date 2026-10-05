import * as assert from 'assert'
import { renderDashboardHtml, type DashboardHtmlVars } from './dashboardHtml'
import { dashboardCspHeader, generateCspNonce, scriptTagsOf, inlineHandlerAttributesOf, UNAUTHORIZED_PAGE_CSP } from './dashboardCsp'

function vars(nonce: string): DashboardHtmlVars {
  return {
    nonce,
    packageVersion: '1.2.3',
    collectorConflictJson: 'null',
    logIngestJson: JSON.stringify({ done: 1, total: 2 }),
    sessionRev: 7,
    sessionSummaryJson: JSON.stringify({ sessions: [], efficiency: {}, backgroundSpans: [] }),
    sidebarInitJson: JSON.stringify({ isActive: false, sessionCount: 0 }),
  }
}

suite('dashboardHtml / CSP contract', () => {
  const nonce = generateCspNonce()
  const html = renderDashboardHtml(vars(nonce))

  test('every <script> tag carries the response nonce', () => {
    const tags = scriptTagsOf(html)
    assert.ok(tags.length >= 7, `expected the page's script tags, got ${tags.length}`)
    for (const tag of tags) {
      assert.ok(tag.includes(`nonce="${nonce}"`), `script tag without the nonce: ${tag}`)
    }
  })

  test('the two bundles are loaded by nonced script tags', () => {
    const tags = scriptTagsOf(html)
    assert.ok(tags.some(t => t.includes('src="/dashboard.js"')))
    assert.ok(tags.some(t => t.includes('src="/sidebar.js"')))
  })

  test('no inline event-handler attributes remain in the markup', () => {
    assert.deepStrictEqual(inlineHandlerAttributesOf(html), [])
  })

  test('no javascript: URLs', () => {
    assert.ok(!/href\s*=\s*["']javascript:/i.test(html))
  })

  test('the nonce is unpredictable and base64', () => {
    const a = generateCspNonce(), b = generateCspNonce()
    assert.notStrictEqual(a, b)
    assert.match(a, /^[A-Za-z0-9+/]+=*$/)
    assert.ok(Buffer.from(a, 'base64').length >= 16)
  })

  test('the header allows only nonced scripts and same-origin connections', () => {
    const header = dashboardCspHeader(nonce)
    assert.ok(header.startsWith("default-src 'none'"))
    assert.ok(header.includes(`script-src 'nonce-${nonce}' 'strict-dynamic'`))
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(header), 'no unsafe-inline for scripts')
    assert.ok(header.includes("connect-src 'self'"))
    assert.ok(header.includes("style-src 'self' 'unsafe-inline'"), 'inline style attributes set by the bundle')
    assert.ok(header.includes("img-src 'self' data:"))
    assert.ok(header.includes("frame-ancestors 'none'"))
    assert.ok(UNAUTHORIZED_PAGE_CSP.startsWith("default-src 'none'"))
  })

  test('inlined values land where the page reads them', () => {
    assert.ok(html.includes('"1.2.3"'))
    assert.ok(html.includes('"done":1,"total":2'))
    assert.ok(html.includes('rev=7') || html.includes(' 7') || html.includes('= 7') || html.includes(':7'), 'session revision inlined')
    assert.ok(html.includes('var __SIDEBAR_INIT__ = {"isActive":false,"sessionCount":0};'))
  })

  test('inlineHandlerAttributesOf catches what the policy would block', () => {
    assert.deepStrictEqual(inlineHandlerAttributesOf('<img src="x" onerror="alert(1)">'), ['onerror='])
    assert.deepStrictEqual(inlineHandlerAttributesOf('<script src="/a.js" onload="x()"></script>'), [])
    assert.deepStrictEqual(inlineHandlerAttributesOf('<div data-on="x" ONCLICK = "go()">'), ['ONCLICK ='])
  })
})
