import * as assert from 'assert'
import { isLiveOrgMessage, LIVE_ORG_MESSAGE_TYPES } from './orgTransport'

// `/api/org` flushes its outbox only when handleOrgMessage resolves, and neither link flow
// resolves until the user has finished in their browser. These two messages are the ones the page
// needs *during* that wait, so they stream over SSE instead — see orgTransport.ts for the two
// Org-panel linking bugs this was.
suite('orgTransport / which org messages must be delivered live', () => {
  test('the device code streams — it is posted before a poll that can run 15 minutes', () => {
    assert.ok(isLiveOrgMessage('orgDevicePrompt'))
  })

  test('the authorize URL streams — in the reply it arrives after the link already succeeded', () => {
    assert.ok(isLiveOrgMessage('orgLinkUrl'))
  })

  test('everything that resolves on its own still travels in the /api/org reply', () => {
    // orgActionResult in particular: it ends the flow, so it must stay ordered with the response
    // the page is awaiting rather than racing it down the SSE stream.
    for (const t of ['orgStatus', 'orgActionResult', 'orgPayloadPreview', 'orgReconcileProgress', 'orgReconcileResult', 'orgError']) {
      assert.ok(!isLiveOrgMessage(t), `${t} should not be streamed`)
    }
  })

  test('a non-string type is not live rather than throwing', () => {
    for (const t of [undefined, null, 42, {}, []]) assert.strictEqual(isLiveOrgMessage(t), false)
  })

  test('the list stays the two link-flow messages, so adding one is a deliberate change', () => {
    assert.deepStrictEqual([...LIVE_ORG_MESSAGE_TYPES].sort(), ['orgDevicePrompt', 'orgLinkUrl'])
  })
})
