/**
 * An update that names `updated_at` itself still writes it exactly once.
 *
 * On a timestamped model the write owns `updated_at` (orm.explicit-created-at
 * pins that for inserts), so `ModelQueryBuilder.update()` and an instance's
 * `save()` append `updated_at = ?` with the time of the write. Neither looked
 * at whether the caller had already set it, so `update({ updated_at })` sent
 * the column twice. SQLite keeps the rightmost assignment and MySQL applies
 * them left to right, so both quietly ended on the managed time; Postgres
 * refuses the statement, "multiple assignments to same column". A Stacks app
 * calling `Model.update(id, { updated_at })` failed only on Postgres
 * (stacksjs/stacks#3014).
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

describe.skipIf(!pgAvailable)('updates that name updated_at against live Postgres', () => {
  it('write it once, as the time of the write', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-upd-at-'))
    const scriptPath = join(dir, 'probe.ts')

    writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, resetConnection, defineModel, clearModelRegistry } from ${JSON.stringify(srcEntry)}

const URL = ${JSON.stringify(PG_URL)}
const PAST = '2020-06-15 00:00:00'
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
  await raw.unsafe('DROP TABLE IF EXISTS _qb_upd_at')
  await raw.unsafe('CREATE TABLE _qb_upd_at (id int primary key, title text, created_at timestamp, updated_at timestamp)')
  await raw.unsafe("INSERT INTO _qb_upd_at VALUES (1, 'a', '" + PAST + "', '" + PAST + "')")
}
// Whether the row's updated_at is still the seeded past, or was stamped by the write.
const stamped = async () => {
  const [row] = await raw.unsafe('SELECT title, updated_at FROM _qb_upd_at WHERE id = 1')
  return [row.title, new Date(row.updated_at).getUTCFullYear() !== 2020]
}

setConfig({ dialect: 'postgres', database: { url: URL } })
resetConnection()
clearModelRegistry()
const Post = defineModel({ name: 'UpdAtPost', table: '_qb_upd_at', primaryKey: 'id',
  traits: { useTimestamps: true }, attributes: { title: { type: 'string', fillable: true } } })

await seed()
check('update with updated_at', await attempt('update with updated_at', () => Post.where('id', 1).update({ title: 'b', updated_at: PAST })), 1)
check('update with updated_at row', await stamped(), ['b', true])

await seed()
check('update with updatedAt', await attempt('update with updatedAt', () => Post.where('id', 1).update({ title: 'b', updatedAt: PAST })), 1)
check('update with updatedAt row', await stamped(), ['b', true])

await seed()
check('update of updated_at alone', await attempt('update of updated_at alone', () => Post.where('id', 1).update({ updated_at: PAST })), 1)
check('update of updated_at alone row', await stamped(), ['a', true])

await seed()
await attempt('save with updated_at', async () => {
  const post = await Post.find(1)
  post.forceFill({ title: 'c', updated_at: PAST })
  await post.save()
})
check('save with updated_at row', await stamped(), ['c', true])

await raw.unsafe('DROP TABLE IF EXISTS _qb_upd_at')
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

    expect(proc.exitCode, `updated_at pg probe failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  }, 30_000)
})
