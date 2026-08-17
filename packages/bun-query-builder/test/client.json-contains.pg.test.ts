/**
 * whereJsonContains against a live Postgres — stacksjs/bun-query-builder#1091.
 *
 * The bug: `whereJsonContains` pushed `JSON.stringify(json)`, but Bun's driver
 * already JSON-encodes a value bound to a jsonb parameter. The document was
 * therefore encoded twice and Postgres received the jsonb *string*
 * `"[\"bun\"]"` where the array `["bun"]` was meant. A jsonb string never
 * `@>`-contains anything, so the predicate was vacuously false and every call
 * returned zero rows, for every input, silently.
 *
 * This has to execute. The emitted SQL was correct throughout (`tags @> $1`) —
 * only the bound parameter was wrong, and `toSQL()` does not expose parameters,
 * so no SQL-text assertion can observe the difference. The existing #1026 suite
 * asserted the text and stayed green across the entire lifetime of this bug.
 *
 * Note also that every negative case ("no row should match") passed while the
 * bug was live, because the answer was always zero rows. Only positive cases —
 * containment that genuinely holds — can fail here, so every case below asserts
 * a row comes back except where it explicitly checks a non-match.
 *
 * Runs in a subprocess: `config.dialect` is global and other test files pin it
 * to sqlite, which would mask the network-driver path entirely.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()

describe.skipIf(!pgAvailable)('whereJsonContains against live Postgres (#1091)', () => {
  it('matches rows for documents and scalars, in both containment modes', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-jc1091-'))
    const scriptPath = join(dir, 'probe.ts')

    writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, resetConnection, createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from ${JSON.stringify(srcEntry)}

const URL = ${JSON.stringify(PG_URL)}
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}

const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS _qb_jsoncontains')
await raw.unsafe('CREATE TABLE _qb_jsoncontains (id int primary key, tags jsonb, meta jsonb)')
await raw.unsafe(\`INSERT INTO _qb_jsoncontains VALUES
  (1, '["bun","sql",1,true]', '{"published":true,"tier":"pro"}'),
  (2, '["node"]',             '{"published":false}')\`)
await raw.end()

setConfig({ dialect: 'postgres', database: { url: URL } })
resetConnection()

const models = { _qb_jsoncontains: { columns: {
  id: { type: 'integer', isPrimaryKey: true }, tags: { type: 'json' }, meta: { type: 'json' },
} } }
const db = createQueryBuilder({
  schema: buildDatabaseSchema(models),
  meta: buildSchemaMeta(models),
  autoMigration: { enabled: false },
})

const ids = async (column, operand) => {
  const rows = await db.selectFrom('_qb_jsoncontains').select('id')
    .whereJsonContains(column, operand).orderBy('id', 'asc').get()
  return rows.map(r => Number(r.id))
}

// Documents. Each of these returned [] while #1091 was live.
check('array', await ids('tags', ['bun']), [1])
check('array multi-element', await ids('tags', ['bun', 'sql']), [1])
check('object', await ids('meta', { published: true }), [1])
check('object multi-key', await ids('meta', { published: true, tier: 'pro' }), [1])
check('string', await ids('tags', 'bun'), [1])

// Scalars. Bound as int4/bool, so these need the to_jsonb lift or Postgres
// rejects the statement outright rather than returning nothing.
check('number', await ids('tags', 1), [1])
check('boolean', await ids('tags', true), [1])

// Non-matches still do not match — the fix must not widen the predicate.
check('array non-match', await ids('tags', ['nope']), [])
check('object non-match', await ids('meta', { published: 'nope' }), [])
check('string non-match', await ids('tags', 'zzz'), [])
check('number non-match', await ids('tags', 99), [])

// jsonb_contains() is the same containment through the function form.
setConfig({ sql: { jsonContainsMode: 'function' } })
check('function mode array', await ids('tags', ['bun']), [1])
check('function mode number', await ids('tags', 1), [1])
check('function mode non-match', await ids('tags', ['nope']), [])

const cleanup = new SQL(URL)
await cleanup.unsafe('DROP TABLE IF EXISTS _qb_jsoncontains')
await cleanup.end()

if (failures.length) {
  console.error('FAILURES:\\n' + failures.join('\\n'))
  process.exit(1)
}
console.log('OK')
`)

    const proc = Bun.spawnSync({ cmd: ['bun', scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env } })
    const dec = new TextDecoder()
    const out = dec.decode(proc.stdout).trim()
    const err = dec.decode(proc.stderr).trim()
    rmSync(dir, { recursive: true, force: true })

    expect(proc.exitCode, `whereJsonContains pg probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  })
})
