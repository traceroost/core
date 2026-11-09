/**
 * A small protobuf wire-format walker for the Antigravity CLI's per-conversation SQLite database
 * (`~/.gemini/antigravity-cli/conversations/<uuid>.db`), and the two decoders built on it:
 * `gen_metadata.data` (token usage and model per generation) and `executor_metadata.data` (the
 * effort-qualified model the user picked).
 *
 * There is no published .proto. The field numbers below are third-party evidence: agentsview read
 * them from the FileDescriptorProto records embedded in official agy 1.1.16 / 1.1.24 binaries and
 * cross-checked them against real databases. TraceRoost has no real capture yet (README →
 * Antigravity is best-effort), so every decoder here is defensive: a malformed or unexpected blob
 * yields nothing rather than a wrong number, and token counts pass the same plausibility caps
 * agentsview uses before they are believed.
 *
 *   CortexStepGeneratorMetadata (gen_metadata.data)
 *     1  chat_model : ChatModelMetadata
 *          4  usage : ModelUsageStats
 *               1 model (enum, observed 1000..4999)   2 input_tokens (uncached)
 *               3 output_tokens (includes thinking)   4 cache_write_tokens (deprecated, 0/absent)
 *               5 cache_read_tokens (omitted when 0)
 *         19  response_model     : string (base slug or a serving canary, `…-exp-b`)
 *         21  model_display_name : string (preferred when present)
 *     2  step_indices : packed repeated varint (steps.idx the generation produced)
 *
 *   ExecutorMetadata (executor_metadata.data)
 *     3  last_step_idx : varint
 *    10  cascade_config → 1 planner_config → 28 model_name : string (`<base>-low|-medium|-high`)
 */

export const WIRE_VARINT = 0
export const WIRE_FIXED64 = 1
export const WIRE_BYTES = 2
export const WIRE_FIXED32 = 5

export interface ProtoField {
  num: number
  wire: number
  /** The value of a varint field. Exact up to 2^53; larger values lose precision (no field read
   *  here can legitimately be that large, and the plausibility caps reject them). */
  varint?: number
  /** The payload of a length-delimited field, or the raw bytes of a fixed32/fixed64 one. */
  bytes?: Uint8Array
}

/** Most fields one parse may decode — a flat run of two-byte fields in a huge blob would
 *  otherwise allocate far more than the blob itself. Past it the parse fails (returns null). */
const MAX_FIELDS = 100_000
/** Deepest nesting the bounded recursive walks descend. */
const MAX_DEPTH = 12

/** Reads one base-128 varint at `pos`: the value and the position after it, or null when it runs
 *  off the end or past 10 bytes. */
export function readVarint(buf: Uint8Array, pos: number): { value: number; next: number } | null {
  let value = 0
  let mul = 1
  for (let i = 0; i < 10; i++) {
    if (pos + i >= buf.length) return null
    const b = buf[pos + i]
    value += (b & 0x7f) * mul
    if ((b & 0x80) === 0) return { value, next: pos + i + 1 }
    mul *= 128
  }
  return null
}

/** Decodes one message level into its fields, or null when the bytes aren't a well-formed message
 *  (bad tag, field number 0, a group, a length past the end, too many fields). Nested messages
 *  stay as bytes — parse them with another call when the schema says they are messages. */
export function parseProto(buf: Uint8Array): ProtoField[] | null {
  const out: ProtoField[] = []
  let pos = 0
  while (pos < buf.length) {
    if (out.length >= MAX_FIELDS) return null
    const tag = readVarint(buf, pos)
    if (!tag) return null
    pos = tag.next
    const num = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (num <= 0) return null
    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, pos)
      if (!v) return null
      out.push({ num, wire, varint: v.value })
      pos = v.next
    } else if (wire === WIRE_FIXED64 || wire === WIRE_FIXED32) {
      const n = wire === WIRE_FIXED64 ? 8 : 4
      if (pos + n > buf.length) return null
      out.push({ num, wire, bytes: buf.subarray(pos, pos + n) })
      pos += n
    } else if (wire === WIRE_BYTES) {
      const len = readVarint(buf, pos)
      if (!len) return null
      pos = len.next
      if (len.value > buf.length - pos) return null
      out.push({ num, wire, bytes: buf.subarray(pos, pos + len.value) })
      pos += len.value
    } else {
      return null  // groups (3/4) and reserved wire types: not a message this decoder trusts
    }
  }
  return out
}

/** The first field numbered `num`, if any. */
export function findField(fields: readonly ProtoField[], num: number): ProtoField | undefined {
  return fields.find(f => f.num === num)
}

/** A length-delimited field parsed as a nested message, or null. */
export function nested(field: ProtoField | undefined): ProtoField[] | null {
  return field && field.wire === WIRE_BYTES && field.bytes ? parseProto(field.bytes) : null
}

/** A length-delimited field read as a model name: valid UTF-8, printable, at least one letter and
 *  at most 64 characters (agentsview's isPlausibleModelName — an older record can hold a nested
 *  message whose bytes happen to decode as text). Null otherwise. */
export function modelString(field: ProtoField | undefined): string | null {
  if (!field || field.wire !== WIRE_BYTES || !field.bytes || field.bytes.length === 0 || field.bytes.length > 256) return null
  let s: string
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(field.bytes) } catch { return null }
  if (s.length === 0 || s.length > 64) return null
  if (!/\p{L}/u.test(s)) return null
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(s)) return null
  return s
}

/** A repeated varint field's values, packed or not; null when one is malformed. */
export function repeatedVarints(fields: readonly ProtoField[], num: number): number[] | null {
  const out: number[] = []
  for (const f of fields) {
    if (f.num !== num) continue
    if (f.wire === WIRE_VARINT && f.varint !== undefined) { out.push(f.varint); continue }
    if (f.wire !== WIRE_BYTES || !f.bytes) return null
    let pos = 0
    while (pos < f.bytes.length) {
      const v = readVarint(f.bytes, pos)
      if (!v) return null
      out.push(v.value)
      pos = v.next
    }
  }
  return out
}

// ── gen_metadata ─────────────────────────────────────────────────────────────

/** Largest single token count (and input + output) believed — agentsview's maxPlausibleTokens: no
 *  real generation is millions of tokens, and a decoy submessage (a nanosecond latency, e.g.)
 *  can carry a large integer in the right field number. */
export const MAX_PLAUSIBLE_TOKENS = 2_000_000
const MODEL_ENUM_MIN = 1000
const MODEL_ENUM_MAX = 5000

export interface AntigravityUsage {
  /** Uncached input tokens (ModelUsageStats.input_tokens). */
  input: number
  /** Output tokens, thinking included — never add thinking again. */
  output: number
  /** Cache-read input tokens; 0 when the field is absent (proto3 omits zero). */
  cacheRead: number
}

/** A ModelUsageStats-shaped message: model enum in [1000, 5000), input and output present as
 *  varints, every count ≤ MAX_PLAUSIBLE_TOKENS, input + output too. Null otherwise. */
export function usageFrom(fields: readonly ProtoField[]): AntigravityUsage | null {
  const model = findField(fields, 1), input = findField(fields, 2), output = findField(fields, 3)
  const cacheWrite = findField(fields, 4), cacheRead = findField(fields, 5)
  const isVarint = (f: ProtoField | undefined): f is ProtoField & { varint: number } => !!f && f.wire === WIRE_VARINT && f.varint !== undefined
  if (!isVarint(model) || !isVarint(input) || !isVarint(output)) return null
  if (model.varint < MODEL_ENUM_MIN || model.varint >= MODEL_ENUM_MAX) return null
  if (input.varint > MAX_PLAUSIBLE_TOKENS || output.varint > MAX_PLAUSIBLE_TOKENS) return null
  if (input.varint + output.varint > MAX_PLAUSIBLE_TOKENS) return null
  if (cacheWrite && (!isVarint(cacheWrite) || cacheWrite.varint > MAX_PLAUSIBLE_TOKENS)) return null
  if (cacheRead && (!isVarint(cacheRead) || cacheRead.varint > MAX_PLAUSIBLE_TOKENS)) return null
  return { input: input.varint, output: output.varint, cacheRead: cacheRead ? (cacheRead as { varint: number }).varint : 0 }
}

export interface AntigravityGeneration {
  /** Token usage, or null when the blob has none TraceRoost believes. */
  usage: AntigravityUsage | null
  /** `model_display_name` (21) when present, else `response_model` (19); null when neither. */
  model: string | null
  /** True when `model` came from the display name, which stays authoritative. */
  displayName: boolean
  /** The steps.idx values the generation produced (empty when the field is absent). */
  stepIndices: number[]
}

/** Decodes one `gen_metadata.data` blob. A record with the `chat_model` wrapper (field 1 holding
 *  usage or a model name) is read by field number; an older record without it is searched for a
 *  ModelUsageStats-shaped submessage and the model fields by a bounded recursive walk. Null when
 *  the blob doesn't parse at all. */
export function decodeGeneration(data: Uint8Array): AntigravityGeneration | null {
  const top = parseProto(data)
  if (!top) return null
  const stepIndices = repeatedVarints(top, 2) ?? []
  const chat = nested(findField(top, 1))
  if (chat) {
    const usageMsg = nested(findField(chat, 4))
    const display = modelString(findField(chat, 21))
    const response = modelString(findField(chat, 19))
    if (usageMsg || display || response) {
      return { usage: usageMsg ? usageFrom(usageMsg) : null, model: display ?? response, displayName: !!display, stepIndices }
    }
  }
  // Legacy record: no chat_model wrapper.
  const usage = walk(top, 0, fs => usageFrom(fs))
  const display = walkString(top, 21)
  const response = display ? null : walkString(top, 19)
  return { usage, model: display ?? response, displayName: !!display, stepIndices }
}

function walk<T>(fields: readonly ProtoField[], depth: number, test: (fs: readonly ProtoField[]) => T | null): T | null {
  const hit = test(fields)
  if (hit !== null) return hit
  if (depth >= MAX_DEPTH) return null
  for (const f of fields) {
    const sub = nested(f)
    if (!sub || sub.length === 0) continue
    const found = walk(sub, depth + 1, test)
    if (found !== null) return found
  }
  return null
}

function walkString(fields: readonly ProtoField[], num: number): string | null {
  return walk(fields, 0, fs => {
    for (const f of fs) if (f.num === num) { const s = modelString(f); if (s) return s }
    return null
  })
}

// ── executor_metadata ────────────────────────────────────────────────────────

export interface AntigravityExecutor {
  lastStepIdx: number
  /** Effort-qualified model name, e.g. `gemini-3.7-flash-high`. */
  modelName: string
}

/** Decodes one `executor_metadata.data` blob; null unless both fields are there and plausible. */
export function decodeExecutor(data: Uint8Array): AntigravityExecutor | null {
  const top = parseProto(data)
  if (!top) return null
  const last = findField(top, 3)
  if (!last || last.wire !== WIRE_VARINT || last.varint === undefined) return null
  const planner = nested(findField(nested(findField(top, 10)) ?? [], 1))
  const modelName = planner ? modelString(findField(planner, 28)) : null
  return modelName ? { lastStepIdx: last.varint, modelName } : null
}

// ── Model resolution ─────────────────────────────────────────────────────────

/** The one serving-canary suffix observed on `response_model`. Only this exact suffix is
 *  stripped — never a generic `-exp`: `gemini-2.0-flash-exp` is a model of its own. */
const CANARY_SUFFIX = '-exp-b'
const EFFORT_SUFFIXES = ['-low', '-medium', '-high'] as const

function effortBase(model: string): string {
  for (const s of EFFORT_SUFFIXES) if (model.endsWith(s)) return model.slice(0, -s.length)
  return model
}

/** The executor covering a step: the first (by last_step_idx, ascending) whose range reaches it. */
export function executorModelFor(executors: readonly AntigravityExecutor[], stepIdx: number): string | null {
  const sorted = [...executors].sort((a, b) => a.lastStepIdx - b.lastStepIdx)
  return sorted.find(e => e.lastStepIdx >= stepIdx)?.modelName ?? null
}

/** A generation's model as the user chose it (agentsview's resolveAntigravityModelName): a display
 *  name stays as it is; otherwise the response model, with only `-exp-b` stripped, is matched
 *  against the covering executor's effort-qualified name and replaced by it when the bases agree.
 *  A response model that disagrees with the executor (another base, a different effort) is kept. */
export function resolveModel(generationModel: string | null, displayName: boolean, executorModel: string | null): string | null {
  if (!generationModel) return executorModel
  if (displayName || !executorModel) return generationModel
  const stripped = generationModel.endsWith(CANARY_SUFFIX) ? generationModel.slice(0, -CANARY_SUFFIX.length) : generationModel
  return effortBase(executorModel) === stripped ? executorModel : generationModel
}

// ── Encoding (tests and synthetic fixtures only) ─────────────────────────────

/** A field to encode: a number (varint), a string or bytes (length-delimited), or a nested list. */
export type EncodeValue = number | string | Uint8Array | EncodeField[] | { packed: number[] }
export type EncodeField = [num: number, value: EncodeValue]

function varintBytes(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128) }
  out.push(v)
  return out
}

/** Encodes fields into protobuf bytes — how tests build synthetic gen_metadata / executor blobs. */
export function encodeProto(fields: readonly EncodeField[]): Uint8Array {
  const out: number[] = []
  for (const [num, value] of fields) {
    if (typeof value === 'number') { out.push(...varintBytes(num * 8 + WIRE_VARINT), ...varintBytes(value)); continue }
    let payload: Uint8Array
    if (typeof value === 'string') payload = new TextEncoder().encode(value)
    else if (value instanceof Uint8Array) payload = value
    else if (Array.isArray(value)) payload = encodeProto(value)
    else payload = Uint8Array.from(value.packed.flatMap(varintBytes))
    out.push(...varintBytes(num * 8 + WIRE_BYTES), ...varintBytes(payload.length), ...payload)
  }
  return Uint8Array.from(out)
}
