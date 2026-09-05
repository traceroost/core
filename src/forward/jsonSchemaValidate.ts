/**
 * A small JSON Schema validator, purpose-built for `schema/rollup.v1.json` (AL 03).
 *
 * The client validates every built record against the committed schema before it is queued, so
 * a schema mistake is caught by whoever introduced it rather than by a customer. `alsaas` uses
 * `ajv` server-side; pulling `ajv` + `ajv-formats` into a VS Code extension that ships five
 * runtime dependencies is not worth it for one small fixed document, so this covers exactly the
 * draft-07 constructs that document uses: `type`, `const`, `enum`, `pattern`, `format` (`uuid`
 * only), `required`, `properties`, `patternProperties`, `additionalProperties:false`, `$ref`
 * into `#/$defs`, `items`, `minItems`/`maxItems`, `minimum`/`maximum`, `minProperties`/
 * `maxProperties`.
 *
 * If the schema grows a construct this does not handle, the test in `schema.test.ts` that walks
 * the schema will still pass but this validator would silently under-check — so
 * `assertKnownConstructs` fails loudly on an unrecognised keyword.
 */

export interface ValidationError {
  path: string
  message: string
}

type Node = Record<string, unknown>

const KNOWN_KEYWORDS = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description',
  'type', 'const', 'enum', 'pattern', 'format',
  'properties', 'patternProperties', 'additionalProperties', 'required',
  'items', 'minItems', 'maxItems',
  'minimum', 'maximum', 'minProperties', 'maxProperties',
])

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export class SchemaValidator {
  private readonly defs: Record<string, Node>

  constructor(private readonly root: Node) {
    this.defs = (root.$defs ?? {}) as Record<string, Node>
    assertKnownConstructs(root)
  }

  validate(value: unknown): ValidationError[] {
    const errors: ValidationError[] = []
    this.check(this.root, value, '#', errors)
    return errors
  }

  isValid(value: unknown): boolean {
    return this.validate(value).length === 0
  }

  private resolve(node: Node): Node {
    if (typeof node.$ref === 'string') {
      const name = node.$ref.replace('#/$defs/', '')
      const target = this.defs[name]
      if (!target) throw new Error(`unresolved $ref: ${node.$ref}`)
      return target
    }
    return node
  }

  private check(schemaNode: Node, value: unknown, path: string, errors: ValidationError[]): void {
    const node = this.resolve(schemaNode)
    const push = (message: string) => errors.push({ path, message })

    if ('const' in node && value !== node.const) {
      push(`must equal ${JSON.stringify(node.const)}`)
      return
    }
    if (Array.isArray(node.enum) && !node.enum.includes(value as never)) {
      push(`must be one of ${JSON.stringify(node.enum)}`)
      return
    }

    const type = node.type as string | undefined
    if (type && !typeMatches(type, value)) {
      push(`must be ${type}`)
      return
    }

    if (type === 'string' && typeof value === 'string') {
      if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(value)) {
        push(`must match ${node.pattern}`)
      }
      if (node.format === 'uuid' && !UUID_RE.test(value)) {
        push('must be a uuid')
      }
    }

    if ((type === 'integer' || type === 'number') && typeof value === 'number') {
      if (typeof node.minimum === 'number' && value < node.minimum) push(`must be ≥ ${node.minimum}`)
      if (typeof node.maximum === 'number' && value > node.maximum) push(`must be ≤ ${node.maximum}`)
    }

    if (type === 'array' && Array.isArray(value)) {
      if (typeof node.maxItems === 'number' && value.length > node.maxItems) push(`must have ≤ ${node.maxItems} items`)
      if (typeof node.minItems === 'number' && value.length < node.minItems) push(`must have ≥ ${node.minItems} items`)
      if (node.items) {
        value.forEach((v, i) => this.check(node.items as Node, v, `${path}/${i}`, errors))
      }
    }

    if (isPlainObject(value) && (type === 'object' || node.properties || node.patternProperties)) {
      const props = (node.properties ?? {}) as Record<string, Node>
      const patternProps = (node.patternProperties ?? {}) as Record<string, Node>
      const required = (node.required ?? []) as string[]

      for (const key of required) {
        if (!(key in value)) push(`missing required property "${key}"`)
      }
      if (typeof node.maxProperties === 'number' && Object.keys(value).length > node.maxProperties) {
        push(`must have ≤ ${node.maxProperties} properties`)
      }
      if (typeof node.minProperties === 'number' && Object.keys(value).length < node.minProperties) {
        push(`must have ≥ ${node.minProperties} properties`)
      }

      for (const [key, v] of Object.entries(value)) {
        const childPath = `${path}/${key}`
        if (key in props) {
          this.check(props[key], v, childPath, errors)
          continue
        }
        const patternEntry = Object.entries(patternProps).find(([re]) => new RegExp(re).test(key))
        if (patternEntry) {
          this.check(patternEntry[1], v, childPath, errors)
          continue
        }
        if (node.additionalProperties === false) {
          push(`unknown property "${key}"`)
        }
      }
    }
  }
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'number': return typeof value === 'number'
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function assertKnownConstructs(node: Node, path = '#'): void {
  for (const key of Object.keys(node)) {
    if (!KNOWN_KEYWORDS.has(key)) {
      throw new Error(`jsonSchemaValidate: unsupported schema keyword "${key}" at ${path} — extend the validator`)
    }
  }
  for (const [k, v] of Object.entries((node.properties ?? {}) as Record<string, Node>)) {
    assertKnownConstructs(v, `${path}/properties/${k}`)
  }
  for (const [k, v] of Object.entries((node.patternProperties ?? {}) as Record<string, Node>)) {
    assertKnownConstructs(v, `${path}/patternProperties/${k}`)
  }
  for (const [k, v] of Object.entries((node.$defs ?? {}) as Record<string, Node>)) {
    assertKnownConstructs(v, `#/$defs/${k}`)
  }
  if (node.items) assertKnownConstructs(node.items as Node, `${path}/items`)
}
