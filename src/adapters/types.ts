/**
 * Shapes shared by the agent adapter registry (registry.ts) and each adapter's `known.ts` — the
 * closed vocabulary of what an agent writes that TraceRoost reads. See classify.ts for how a
 * record is sorted into known / known-ignored / unknown against it.
 */

/** One per agent TraceRoost reads. A LogReader key (`copilot_vscode_json`, e.g.) maps onto one. */
export type AdapterKey = 'claude' | 'codex' | 'copilot' | 'copilot_vscode' | 'opencode' | 'cursor'

/** How much testing stands behind an adapter — see README → Supported agents. */
export type SupportLevel = 'verified' | 'fixture-tested' | 'best-effort'

export type SourceKind = 'otlp' | 'files' | 'sqlite'

/** known: a record the adapter reads. ignored: a record the agent writes that the adapter
 *  deliberately skips. unknown: anything else, or a known record missing a required key. */
export type RecordClass = 'known' | 'ignored' | 'unknown'

export interface Classification {
  cls: RecordClass
  /** The record's name in the adapter's vocabulary (`assistant`, `event_msg:token_count`, …). For
   *  a known record missing a required key: `<name> missing <key path>`. A closed-vocabulary
   *  string: never a value read from the record other than its type field. */
  name: string
}

/** The vocabulary of a record-per-line (or record-per-row) format. */
export interface KnownRecords {
  /** The record's name, or null when it carries none (classified unknown as `(no type)`). */
  nameOf(record: Record<string, unknown>): string | null
  /** Records the adapter reads, each with the dotted key paths it can't do without. */
  consumed: Readonly<Record<string, readonly string[]>>
  /** Records the agent writes that the adapter skips on purpose. */
  ignored: readonly string[]
  /** Dotted key paths a structural fingerprint may descend into (fingerprint.ts); below any
   *  other object key the fingerprint stops at `"object"`. */
  structural: readonly string[]
  /** The agent version a record carries, if this kind of record carries one. */
  versionOf?(record: Record<string, unknown>): string | null
  /** Key paths the adapter reads from a record when they're there, beyond `consumed`'s required
   *  ones — token counts, the model. Not checked at runtime (an older version may not write them);
   *  the CI format check (tests/e2e/fingerprint-diff.mjs) fails when the newest committed fixture's
   *  records of that name had one and a new capture's no longer do. */
  reads?: Readonly<Record<string, readonly string[]>>
}

/** OTLP names (log `event.name`s, span names) an agent emits. */
export interface KnownOtlp {
  consumed: readonly string[]
  ignored: readonly string[]
}

/** One OTLP log record or span, as far as adapter health needs to see it. */
export interface OtlpRecordView {
  /** The log record's event name or the span's name. */
  name: string
  /** Resource `service.name`, '' when absent. */
  serviceName: string
  /** Resource `service.version`, '' when absent. */
  serviceVersion: string
  /** `gen_ai.operation.name`, '' when absent — Copilot's span names carry model and tool names,
   *  so its spans are classified by operation instead. */
  genAiOperation: string
}
