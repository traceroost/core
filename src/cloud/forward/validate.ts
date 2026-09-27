/**
 * Client-side validation of a built rollup against the committed `schema/rollup.v1.json` (AL 03).
 *
 * The server validates too (SA 05). Validating in both places means a schema mistake is caught
 * by whoever introduced it, in a test or a debug build, rather than by a customer seeing a 400.
 */

import * as fs from 'fs'
import * as path from 'path'
import { SchemaValidator, type ValidationError } from './jsonSchemaValidate'
import type { RollupPayload } from './schema'

let cached: { validator: SchemaValidator; schema: unknown } | undefined

/** Locates the committed schema. It ships at the package root in both the npm package and the
 *  VSIX; this walks up from `__dirname` (which differs by build) until it finds it. */
export function loadRollupSchema(): unknown {
  if (cached) return cached.schema
  for (const rel of ['..', '../..', '../../..', '../../../..']) {
    const candidate = path.join(__dirname, rel, 'schema', 'rollup.v1.json')
    try {
      const schema = JSON.parse(fs.readFileSync(candidate, 'utf-8'))
      cached = { schema, validator: new SchemaValidator(schema as Record<string, unknown>) }
      return schema
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('could not locate schema/rollup.v1.json — the package is built incorrectly')
}

function validator(): SchemaValidator {
  if (!cached) loadRollupSchema()
  return cached!.validator
}

export function validateRollupPayload(payload: unknown): ValidationError[] {
  return validator().validate(payload)
}

export function assertValidRollupPayload(payload: RollupPayload): void {
  const errors = validateRollupPayload(payload)
  if (errors.length > 0) {
    throw new Error(
      'built rollup failed client-side schema validation (this is a bug in the builder, not your data):\n' +
      errors.map(e => `  ${e.path}: ${e.message}`).join('\n'),
    )
  }
}
