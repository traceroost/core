/**
 * The standalone server's side of the dashboard's revision-checked `update` protocol — the same
 * wire contract `src/webviewSessionSync.ts` speaks to the VS Code webview (`base` → `rev`, a full
 * `sessionSummary` or a `sessionDelta` of changed cards / new order, `analyticsData` only when it
 * changed), so `media/src/App.tsx`'s `update` handler applies SSE frames exactly as it applies
 * webview posts. One addition: a delta also carries the summary's top-level `backgroundSpans`
 * when there are any (the extension host never has any; `applySessionDelta` defaults to none). Every SSE update used to carry the whole session list (~23MB at 20k sessions) to
 * be serialized by the server, written to every open tab, and parsed and re-rendered by each.
 *
 * Works on JSON text rather than card objects: the server already serializes each card for the
 * full payload (and caches that per log card), so "did this card change" is a string comparison
 * — usually of the very same cached string — instead of a structural walk.
 *
 * One instance is shared by every SSE client: all of them are sent the same frames in the same
 * order, so they all sit at the same revision. A client that isn't (a new connection, a reconnect
 * after a dropped stream) is sent a full update at the current revision; the dashboard asks for
 * one itself (`requestFullUpdate`) whenever a frame's `base` isn't its own revision.
 */

export interface SyncSummary {
  /** Session ids, in display order. */
  ids: readonly string[]
  /** Each session's card as JSON, in the same order — exactly the elements of the full payload's
   *  `sessions` array. */
  cardJsons: readonly string[]
  /** JSON of the summary's `efficiency`. */
  efficiencyJson: string
  /** JSON of the summary's top-level `backgroundSpans`. */
  backgroundSpansJson: string
  /** Whether the summary holds nothing beyond `sessions`, `efficiency` and `backgroundSpans` —
   *  all a delta rebuilds. Anything else can only be sent in full. */
  deltaable: boolean
}

type Posted =
  | null                                                                  // unknown — send in full
  | { kind: 'full'; json: string }                                        // last sent in full
  | { kind: 'cards'; byId: Map<string, string>; order: readonly string[]; efficiencyJson: string; backgroundSpansJson: string }

export interface SyncStep {
  base: number
  rev: number
  /** The `update` frame's session/analytics fields for this step, each as `,"key":value` — empty
   *  when nothing changed. */
  fields: string
}

export class SseSessionSync {
  private rev: number
  private posted: Posted = null
  private analyticsJson: string | null = null

  /** `initialRev` should differ between server runs (e.g. `Date.now()`), so a tab left open across
   *  a restart can't mistake the new server's revision for the one it holds. */
  constructor(initialRev: number) {
    this.rev = initialRev
  }

  get revision(): number {
    return this.rev
  }

  /** Advances the tracked state to `summary` (null: no summary at all) and returns what changed.
   *  `fullJson` is the complete `sessionSummary` JSON, only asked for when it has to be sent. */
  advance(summary: SyncSummary | null, fullJson: () => string, analyticsJson: string): SyncStep {
    const base = this.rev
    let fields = ''
    const prev = this.posted
    const byId = summary && summary.deltaable && summary.ids.length > 0 ? SseSessionSync.index(summary) : null
    if (summary && byId) {
      if (prev?.kind === 'cards') {
        const upserts: string[] = []
        for (let i = 0; i < summary.ids.length; i++) {
          if (prev.byId.get(summary.ids[i]) !== summary.cardJsons[i]) upserts.push(summary.cardJsons[i])
        }
        const sameOrder = summary.ids.length === prev.order.length && summary.ids.every((id, i) => id === prev.order[i])
        const { efficiencyJson, backgroundSpansJson } = summary
        if (upserts.length > 0 || !sameOrder || efficiencyJson !== prev.efficiencyJson || backgroundSpansJson !== prev.backgroundSpansJson) {
          fields += ',"sessionDelta":{"upserts":[' + upserts.join(',') + ']' +
            (sameOrder ? '' : ',"order":' + JSON.stringify(summary.ids)) +
            ',"efficiency":' + efficiencyJson +
            (backgroundSpansJson === '[]' ? '' : ',"backgroundSpans":' + backgroundSpansJson) + '}'
        }
      } else {
        fields += ',"sessionSummary":' + fullJson()
      }
      this.posted = { kind: 'cards', byId, order: summary.ids, efficiencyJson: summary.efficiencyJson, backgroundSpansJson: summary.backgroundSpansJson }
    } else {
      // Empty, missing, holding a duplicate session id, or shaped unlike a summary — none of
      // which a delta can express. Still only sent when it actually changed.
      const json = fullJson()
      if (prev?.kind !== 'full' || prev.json !== json) fields += ',"sessionSummary":' + json
      this.posted = { kind: 'full', json }
    }
    if (analyticsJson !== this.analyticsJson) {
      fields += ',"analyticsData":' + analyticsJson
      this.analyticsJson = analyticsJson
    }
    if (fields) this.rev++
    return { base, rev: this.rev, fields }
  }

  /** id → card JSON, or null when an id repeats (not expressible as a delta). */
  private static index(summary: SyncSummary): Map<string, string> | null {
    const byId = new Map<string, string>()
    for (let i = 0; i < summary.ids.length; i++) {
      if (byId.has(summary.ids[i])) return null
      byId.set(summary.ids[i], summary.cardJsons[i])
    }
    return byId
  }
}
