/**
 * `createMany()` against a live Postgres — see orm.create-many.test.ts for the
 * contract. Postgres reads generated keys through `RETURNING` and rewrites `?`
 * to `$n`, so the batched statement is exercised here too, including the
 * 65535-parameter ceiling, and that batches leave no pile of prepared
 * statements behind.
 *
 * Runs in a subprocess, like orm.save-primary-key.pg.test.ts: an earlier
 * configureOrm() in the same process pins the model layer to sqlite.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()

describe.skipIf(!pgAvailable)('createMany() against live Postgres', () => {
  it('batches supplied and generated keys, and chunks large inputs', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-createmany-'))
    const scriptPath = join(dir, 'probe.ts')

    writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, resetConnection, defineModel, clearModelRegistry } from ${JSON.stringify(srcEntry)}
import { getOrCreateBunSql } from ${JSON.stringify(resolve(import.meta.dir, '../src/db.ts'))}

const URL = ${JSON.stringify(PG_URL)}
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}

const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS _qb_cm_posts')
await raw.unsafe('DROP TABLE IF EXISTS _qb_cm_countries')
await raw.unsafe('CREATE TABLE _qb_cm_posts (id serial primary key, title text, created_at timestamptz, updated_at timestamptz)')
await raw.unsafe('CREATE TABLE _qb_cm_countries (code text primary key, name text)')

setConfig({ dialect: 'postgres', database: { url: URL } })
resetConnection()
clearModelRegistry()
const Post = defineModel({ name: 'CmPgPost', table: '_qb_cm_posts', primaryKey: 'id',
  attributes: { title: { type: 'string', fillable: true } } })
const Country = defineModel({ name: 'CmPgCountry', table: '_qb_cm_countries', primaryKey: 'code',
  traits: { useTimestamps: false }, attributes: { code: { type: 'string', fillable: true }, name: { type: 'string', fillable: true } } })

const made = await Post.createMany([{ title: 'one' }, { title: 'two' }, { title: 'three' }])
const rows = (await raw.unsafe('SELECT id, title FROM _qb_cm_posts ORDER BY id')).map(r => [Number(r.id), r.title])
check('generated keys paired', made.map(m => [Number(m.get('id')), m.get('title')]), rows)

// 40000 rows x 2 columns is 80000 parameters: over Postgres' 65535, so it
// only succeeds if the batch is chunked.
const many = Array.from({ length: 40000 }, (_, i) => ({ code: 'C' + i, name: 'n' + i }))
const t0 = performance.now()
await Country.createMany(many)
const ms = performance.now() - t0
const n = (await raw.unsafe('SELECT COUNT(*)::int AS n FROM _qb_cm_countries'))[0].n
check('all rows written', n, 40000)
if (ms > 10000) failures.push('40000 rows took ' + Math.round(ms) + 'ms, which is not a batch')

// Nulls in different columns row to row, over many batches. Each of those
// used to be a new prepared statement on the connection, never freed.
await raw.unsafe('DROP TABLE IF EXISTS _qb_cm_hits')
await raw.unsafe('CREATE TABLE _qb_cm_hits (id text primary key, a text, b integer, c boolean, d bigint, e timestamp, f double precision)')
const Hit = defineModel({ name: 'CmPgHit', table: '_qb_cm_hits', primaryKey: 'id', traits: { useTimestamps: false },
  attributes: { id: { type: 'string', fillable: true }, a: { type: 'string', fillable: true }, b: { type: 'integer', fillable: true },
    c: { type: 'boolean', fillable: true }, d: { type: 'bigint', fillable: true }, e: { type: 'datetime', fillable: true }, f: { type: 'double', fillable: true } } })
const conn = getOrCreateBunSql()
const before = (await conn.unsafe('SELECT count(*)::int AS n FROM pg_prepared_statements'))[0].n
let hits = 0
for (let batch = 1; batch <= 40; batch++) {
  await Hit.createMany(Array.from({ length: 25 + batch }, () => {
    const m = hits++ % 64
    return { id: 'h' + hits, a: m & 1 ? null : "it's", b: m & 2 ? null : hits, c: m & 4 ? null : hits % 2 === 0,
      d: m & 8 ? null : 9007199254740993n, e: m & 16 ? null : new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), f: m & 32 ? null : 0.125 }
  }))
}
const after = (await conn.unsafe('SELECT count(*)::int AS n FROM pg_prepared_statements'))[0].n
if (after - before > 4) failures.push('batches left ' + (after - before) + ' prepared statements on the connection')
check('every hit written', (await raw.unsafe('SELECT count(*)::int AS n FROM _qb_cm_hits'))[0].n, hits)
const sample = (await raw.unsafe("SELECT a, b, c, d::text AS d, to_char(e, 'YYYY-MM-DD HH24:MI:SS') AS e, f FROM _qb_cm_hits WHERE id = 'h1'"))[0]
check('values survive the jsonb batch', [sample.a, sample.b, sample.c, sample.d, sample.e, sample.f], ["it's", 1, false, '9007199254740993', '2026-01-02 03:04:05', 0.125])
const nulls = (await raw.unsafe("SELECT a, b, c, d, e, f FROM _qb_cm_hits WHERE id = 'h64'"))[0]
check('nulls stay null', [nulls.a, nulls.b, nulls.c, nulls.d, nulls.e, nulls.f], [null, null, null, null, null, null])

await raw.unsafe('DROP TABLE IF EXISTS _qb_cm_hits')
await raw.unsafe('DROP TABLE IF EXISTS _qb_cm_posts')
await raw.unsafe('DROP TABLE IF EXISTS _qb_cm_countries')
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

    expect(proc.exitCode, `createMany pg probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 60_000)
})
