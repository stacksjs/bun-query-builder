/**
 * `save()` INSERT vs UPDATE against a live Postgres — see
 * orm.save-primary-key.test.ts for the bug. Postgres inserts through
 * `RETURNING <pk>`, a different path from SQLite's rowid, so the supplied-key
 * and string-key cases are executed here too.
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

describe.skipIf(!pgAvailable)('save() primary key handling against live Postgres', () => {
  it('inserts supplied and string keys, and updates a row keyed 0', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-savepk-'))
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
await raw.unsafe('DROP TABLE IF EXISTS _qb_savepk_posts')
await raw.unsafe('DROP TABLE IF EXISTS _qb_savepk_countries')
await raw.unsafe('CREATE TABLE _qb_savepk_posts (id serial primary key, title text, created_at timestamptz, updated_at timestamptz)')
await raw.unsafe('CREATE TABLE _qb_savepk_countries (code text primary key, name text)')
const posts = async () => (await raw.unsafe('SELECT id, title FROM _qb_savepk_posts ORDER BY id')).map(r => [Number(r.id), r.title])
const countries = async () => (await raw.unsafe('SELECT code, name FROM _qb_savepk_countries ORDER BY code')).map(r => [r.code, r.name])

setConfig({ dialect: 'postgres', database: { url: URL } })
resetConnection()
clearModelRegistry()
const Post = defineModel({ name: 'SavepkPost', table: '_qb_savepk_posts', primaryKey: 'id',
  attributes: { title: { type: 'string', fillable: true } } })
const Country = defineModel({ name: 'SavepkCountry', table: '_qb_savepk_countries', primaryKey: 'code',
  traits: { useTimestamps: false }, attributes: { name: { type: 'string', fillable: true } } })

const five = await attempt('create with id', () => Post.create({ id: 5, title: 'five' }))
check('create with id: key', five && Number(five.get('id')), 5)
check('create with id: rows', await posts(), [[5, 'five']])

const auto = await attempt('create generated', () => Post.create({ title: 'auto' }))
check('create generated: key read back', auto && Number(auto.get('id')) > 0, true)

const ph = await attempt('string key create', () => Country.create({ code: 'PH', name: 'Philippines' }))
check('string key: key', ph && ph.get('code'), 'PH')
check('string key: rows', await countries(), [['PH', 'Philippines']])
if (ph) {
  ph.set('name', 'Republic of the Philippines')
  await attempt('string key update', () => ph.save())
  check('string key: updated in place', await countries(), [['PH', 'Republic of the Philippines']])
}

await raw.unsafe("INSERT INTO _qb_savepk_posts (id, title) VALUES (0, 'zero')")
const zero = await attempt('find 0', () => Post.find(0))
if (zero) {
  zero.set('title', 'zero, edited')
  await attempt('save 0', () => zero.save())
}
const after = await posts()
check('key 0: updated, not copied', after.filter(([, t]) => String(t).startsWith('zero')), [[0, 'zero, edited']])

await raw.unsafe('DROP TABLE IF EXISTS _qb_savepk_posts')
await raw.unsafe('DROP TABLE IF EXISTS _qb_savepk_countries')
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

    expect(proc.exitCode, `save() primary key pg probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 30_000)
})
