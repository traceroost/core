#!/usr/bin/env node
// Generates privacy-certificate.json — run only after the pre-release privacy-scan job's lint
// and schema-drift checks have both passed. It doesn't perform any checks itself; it's a signed
// record (via actions/attest-build-provenance in release.yml) that those checks were green for
// this exact commit, over the exact schema files that define the cloud wire contract.
// See runbooks/README.md and .github/workflows/release.yml's `privacy-scan` job.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const schemaJsonRaw = readFileSync('schema/rollup.v1.json', 'utf-8')
const schemaTsRaw = readFileSync('src/cloud/forward/schema.ts', 'utf-8')
const schema = JSON.parse(schemaJsonRaw)

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

const certificate = {
  certificate_version: '1',
  schema_version: schema.properties.schema_version.const,
  schema_json_sha256: sha256(schemaJsonRaw),
  schema_source_sha256: sha256(schemaTsRaw),
  commit: process.env.GITHUB_SHA ?? 'unknown',
  ref: process.env.GITHUB_REF_NAME ?? 'unknown',
  generated_at: new Date().toISOString(),
  checks: [
    'every string in schema/rollup.v1.json is constrained by enum, pattern, const, or format (schemaViolations, src/test/cloud/forward/schema.test.ts)',
    'every object in schema/rollup.v1.json sets additionalProperties:false (schemaViolations, src/test/cloud/forward/schema.test.ts)',
    'src/cloud/forward/** contains no `any` or `as unknown` type-assertion escape hatches (eslint: @typescript-eslint/no-explicit-any, no-restricted-syntax)',
    'src/cloud/forward/** (excluding sender.ts) cannot import SessionSummaryCard, the internal type carrying prompts/completions/diffs (eslint: no-restricted-imports)',
    'only src/cloud/forward/sender.ts may reference the cloud ingest endpoints (eslint: no-restricted-imports)',
  ],
}

writeFileSync('privacy-certificate.json', JSON.stringify(certificate, null, 2) + '\n')
console.log(`Privacy certificate written: schema ${certificate.schema_json_sha256.slice(0, 12)}… @ ${certificate.commit}`)
