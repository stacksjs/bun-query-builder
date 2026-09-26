/**
 * `createMany()` against a live Postgres — see orm.create-many.test.ts for the
 * contract. Postgres reads generated keys through `RETURNING` and rewrites `?`
 * to `$n`, so the batched statement is exercised here too, including the
 * 65535-parameter ceiling.
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
