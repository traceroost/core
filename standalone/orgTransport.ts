/**
 * Which Org-panel messages the standalone host has to deliver *while* `handleOrgMessage` is still
 * running, rather than in the `/api/org` reply.
 *
 * `/api/org` is request/response: `post()` fills an outbox that is flushed once the handler
 * resolves. That is fine for everything that completes on its own, and wrong for the two link
 * flows, which do not resolve until the user has finished in their browser — `orgLink` waits on
 * the authorize round-trip, `orgLinkDevice` polls for up to the code's lifetime (15 minutes by
 * default). A message the page needs in order to *act* during that wait cannot travel in the
 * reply, because the reply is the thing it is waiting for.
 *
 * Both of the Org-panel linking bugs were this:
 *   - the device code is posted before the first poll and was delivered with the reply, so
 *     "Use a device code" never showed a code while it was still usable;
 *   - the authorize URL arrived only after a successful link, and the page's transport shim
 *     opened it, re-opening the sign-in page on top of the link that had just succeeded.
 *
 * These go out over the dashboard's SSE stream instead (`broadcastSse`), which re-dispatches them
 * as `window` `message` events — the same shape `post()` delivers, so App.tsx is unchanged. They
 * are deliberately *not* also put in the outbox: a page that receives one twice would set the
 * signal, have it cleared by `orgActionResult`, and then set it again from the stale copy.
 *
 * The extension host needs none of this — its `post` is `webview.postMessage`, which is already
 * live — so this is a standalone/desktop/Docker concern only.
 */
export const LIVE_ORG_MESSAGE_TYPES: readonly string[] = ['orgDevicePrompt', 'orgLinkUrl']

/** True when this message must be streamed to the page now, not queued for the `/api/org` reply. */
export function isLiveOrgMessage(type: unknown): boolean {
  return typeof type === 'string' && LIVE_ORG_MESSAGE_TYPES.includes(type)
}
