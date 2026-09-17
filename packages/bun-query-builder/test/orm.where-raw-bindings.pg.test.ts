/**
 * `Model.query().whereRaw(sql, [a, b])` against a live Postgres —
 * stacksjs/bun-query-builder#1146.
 *
 * Postgres failed the array form differently from SQLite. Bun.sql's `unsafe()`
 * sends an array bound to a text parameter as its elements joined with commas, so a one-value
 * array reached the server as that value and looked fine, reads and writes
 * alike. Two values did not: `whereRaw('lower(name) = ? and country = ?',
 * ['ada', 'UK'])` put one comma-joined parameter against two placeholders and
 * failed with `insufficient data left in message` (08P01). A single `?` given
 * two values, `['ada', 'bob']`, bound the string `'ada,bob'` and returned no
 * rows without an error.
 *
 * Bun.sql encodes by the parameter's type, though: an array bound to a jsonb
 * parameter goes over as JSON. So `whereRaw('tags @> ?', ['bun'])` used to
 * compare against the array `["bun"]`, and now binds the string `"bun"` like
 * any other bindings list. The jsonb checks below pin both that change and the
 * spellings that still bind an array as one value.
 *
 * The SQLite suite (orm.where-raw-bindings.test.ts) asserts the bindings the
 * builder emits; this checks that the network driver executes them.
 *
 * Runs in a subprocess: an earlier configureOrm() in the same process pins the
 * model layer to sqlite and would mask the network-driver path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()

describe.skipIf(!pgAvailable)('whereRaw array bindings against live Postgres (#1146)', () => {
  it('binds every value of the array form, on reads and writes', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-wrb1146-'))
    const scriptPath = join(dir, 'probe.ts')

    writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, resetConnection, defineModel, clearModelRegistry } from ${JSON.stringify(srcEntry)}

const URL = ${JSON.stringify(PG_URL)}
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}
const attempt = async (label, fn) => {
  try { return await fn() }
  catch (e) { failures.push(label + ': threw ' + (e && e.message)); return undefined }
}

const raw = new SQL(URL)
const seed = async () => {
  await raw.unsafe('DROP TABLE IF EXISTS _qb_wrb1146')
  await raw.unsafe('CREATE TABLE _qb_wrb1146 (id int primary key, name text not null, country text not null, score int not null default 0, tags jsonb not null)')
  await raw.unsafe(\`INSERT INTO _qb_wrb1146 (id, name, country, tags) VALUES
    (1, 'Ada', 'US', '["bun","sql"]'), (2, 'ada', 'UK', '["node"]'), (3, 'Grace', 'US', '"bun"')\`)
}
const idsLeft = async () => (await raw.unsafe('SELECT id FROM _qb_wrb1146 ORDER BY id')).map(r => Number(r.id))

setConfig({ dialect: 'postgres', database: { url: URL } })
resetConnection()
clearModelRegistry()
const User = defineModel({ name: 'Wrbpguser', table: '_qb_wrb1146', primaryKey: 'id',
  attributes: { name: { type: 'string', fillable: true }, country: { type: 'string', fillable: true },
    score: { type: 'number', fillable: true }, tags: { type: 'json', fillable: true } } })

const ids = rows => (rows ?? []).map(r => Number(r.id ?? r.get('id'))).sort((a, b) => a - b)

await seed()
// Two values from one array. Threw 08P01 while #1146 was live.
check('two-value array read', ids(await attempt('two-value array read', () =>
  User.query().whereRaw('lower(name) = ? and country = ?', ['ada', 'UK']).get())), [2])
check('two-value array + where', ids(await attempt('two-value array + where', () =>
  User.query().where('id', 2).whereRaw('lower(name) = ? and country = ?', ['ada', 'UK']).get())), [2])
check('array + where, count', await attempt('array + where, count', () =>
  User.query().whereRaw('lower(name) = ?', ['ada']).where('country', 'US').count()), 1)
check('orWhereRaw array', ids(await attempt('orWhereRaw array', () =>
  User.query().where('country', 'UK').orWhereRaw('lower(name) = ? or id = ?', ['grace', 1]).get())), [1, 2, 3])
check('empty array + where', ids(await attempt('empty array + where', () =>
  User.query().whereRaw('1 = 1', []).where('country', 'US').get())), [1, 3])

// jsonb. Bun.sql sends an array bound to a jsonb parameter as JSON, so an
// array meant as one value is wrapped, or passed among separate arguments.
check('jsonb wrapped array', ids(await attempt('jsonb wrapped array', () =>
  User.query().whereRaw('tags @> ?', [['bun']]).get())), [1])
check('jsonb array among separate arguments', ids(await attempt('jsonb separate', () =>
  User.query().whereRaw('country = ? and tags @> ?', 'US', ['sql']).get())), [1])
check('jsonb array inside a bindings list', ids(await attempt('jsonb list', () =>
  User.query().whereRaw('country = ? and tags @> ?', ['US', ['bun']]).get())), [1])
check('jsonb array first among separate arguments', ids(await attempt('jsonb first', () =>
  User.query().whereRaw('tags @> ? and country = ?', ['bun'], 'US').get())), [1])
// The documented behaviour change: a bare array is the bindings list, so this
// binds the JSON string "bun" (contained by row 1's array and equal to row 3),
// where it used to bind the array ["bun"] and match row 1 only.
check('jsonb bare array is the bindings list', ids(await attempt('jsonb bare', () =>
  User.query().whereRaw('tags @> ?', ['bun']).get())), [1, 3])

// Writes: the placeholders are renumbered after update()'s SET values.
check('update affected', await attempt('update', () =>
  User.query().whereRaw('lower(name) = ? and country = ?', ['ada', 'UK']).update({ country: 'CA' })), 1)
check('update landed', (await raw.unsafe('SELECT country FROM _qb_wrb1146 WHERE id = 2'))[0].country, 'CA')
await attempt('increment', () => User.query().whereRaw('id = ? or id = ?', [1, 3]).increment('score', 4))
check('increment landed', (await raw.unsafe('SELECT score FROM _qb_wrb1146 ORDER BY id')).map(r => Number(r.score)), [4, 0, 4])
check('delete affected', await attempt('delete', () =>
  User.query().where('country', 'US').whereRaw('lower(name) = ? or lower(name) = ?', ['grace', 'nobody']).delete()), 1)
check('delete landed', await idsLeft(), [1, 2])

await raw.unsafe('DROP TABLE IF EXISTS _qb_wrb1146')
await raw.end()

if (failures.length) {
  console.error('FAILURES:\\n' + failures.join('\\n'))
  process.exit(1)
}
console.log('OK')
process.exit(0)
`)

    const proc = Bun.spawnSync({ cmd: ['bun', scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env } })
    const dec = new TextDecoder()
    const out = dec.decode(proc.stdout).trim()
    const err = dec.decode(proc.stderr).trim()
    rmSync(dir, { recursive: true, force: true })

    expect(proc.exitCode, `whereRaw array bindings pg probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 30_000)
})
