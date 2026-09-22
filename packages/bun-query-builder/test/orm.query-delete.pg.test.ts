/**
 * `Model.query()…delete()` and `forceDelete()` against a live Postgres — see
 * orm.query-delete.test.ts for the change. Marking puts the timestamp ahead of
 * the WHERE bindings, which only `$n` numbering would get wrong, so both the
 * bulk path (no hooks) and the read-then-delete-by-key path (hooks) run here.
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

describe.skipIf(!pgAvailable)('query delete() and forceDelete() against live Postgres', () => {
  it('marks on soft-deletable models, removes on forceDelete, runs hooks', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-qdel-'))
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
  for (const t of ['_qb_qdel_hooked', '_qb_qdel_plain']) {
    await raw.unsafe('DROP TABLE IF EXISTS ' + t)
    await raw.unsafe('CREATE TABLE ' + t + ' (id int primary key, title text, deleted_at timestamptz)')
    await raw.unsafe('INSERT INTO ' + t + " VALUES (1, 'a', '2020-06-15'), (2, 'b', NULL), (3, 'c', NULL), (4, 'd', NULL)")
  }
}
// title, with '*' when marked and '*2020' when it kept its original date.
const state = async t => (await raw.unsafe('SELECT title, deleted_at FROM ' + t + ' ORDER BY id'))
  .map(r => r.deleted_at == null ? r.title : new Date(r.deleted_at).getUTCFullYear() === 2020 ? r.title + '*2020' : r.title + '*')

setConfig({ dialect: 'postgres', database: { url: URL } })
resetConnection()
clearModelRegistry()
const log = []
const Hooked = defineModel({ name: 'QdelHooked', table: '_qb_qdel_hooked', primaryKey: 'id',
  traits: { useSoftDeletes: true, useTimestamps: false }, attributes: { title: { type: 'string', fillable: true } },
  hooks: { beforeDelete: m => { log.push('before:' + m.get('title')) }, afterDelete: m => { log.push('after:' + m.get('title')) } } })
const Plain = defineModel({ name: 'QdelPlain', table: '_qb_qdel_plain', primaryKey: 'id',
  traits: { useSoftDeletes: true, useTimestamps: false }, attributes: { title: { type: 'string', fillable: true } } })

for (const [label, M, table] of [['hooks', Hooked, '_qb_qdel_hooked'], ['bulk', Plain, '_qb_qdel_plain']]) {
  await seed(); log.length = 0
  // A binding in the WHERE, so the timestamp has to be numbered ahead of it.
  check(label + ' delete count', await attempt(label + ' delete', () => M.where('title', 'in', ['a', 'b', 'c']).where('id', '>', 1).delete()), 2)
  check(label + ' delete marks', await state(table), ['a*2020', 'b*', 'c*', 'd'])

  await seed()
  check(label + ' withTrashed delete', await attempt(label + ' withTrashed', () => M.withTrashed().where('id', '<', 3).delete()), 1)
  check(label + ' withTrashed keeps old date', await state(table), ['a*2020', 'b*', 'c', 'd'])

  await seed()
  check(label + ' onlyTrashed purges', await attempt(label + ' onlyTrashed', () => M.onlyTrashed().delete()), 1)
  check(label + ' onlyTrashed rows', await state(table), ['b', 'c', 'd'])

  await seed()
  check(label + ' forceDelete count', await attempt(label + ' forceDelete', () => M.where('id', '<', 4).forceDelete()), 2)
  check(label + ' forceDelete rows', await state(table), ['a*2020', 'd'])
}

await seed(); log.length = 0
await attempt('hook order', () => Hooked.where('id', '>', 2).delete())
check('hooks per row, befores first', log, ['before:c', 'before:d', 'after:c', 'after:d'])

for (const t of ['_qb_qdel_hooked', '_qb_qdel_plain'])
  await raw.unsafe('DROP TABLE IF EXISTS ' + t)
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

    expect(proc.exitCode, `query delete pg probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 30_000)
})
