/**
 * Execution-level integration coverage against a live Postgres
 * (stacksjs/bun-query-builder#1038). Skipped when no Postgres is reachable.
 *
 * Exercises the DriverExecutor + client.ts Postgres branches end-to-end —
 * RETURNING inserts, UPDATE/DELETE affected-row counts, $n placeholders,
 * relations, aggregates — which unit/SQL-text tests never run. Runs in a fresh
 * subprocess so an earlier configureOrm() (which pins globalDb to sqlite) can't
 * mask the network-driver path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SQL } from 'bun'
import { describe, expect, it } from 'bun:test'

const PG_URL = `postgres://${process.env.USER}@localhost:5432/postgres`
let pgAvailable = false
try {
  const probe = new SQL(PG_URL)
  await probe.unsafe('SELECT 1')
  await probe.end()
  pgAvailable = true
}
catch {
  pgAvailable = false
}

describe.skipIf(!pgAvailable)('Postgres integration (#1038)', () => {
  it('runs ORM CRUD + relations + raw builder against live Postgres', () => {
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const dir = mkdtempSync(join(tmpdir(), 'qb-pgint-'))
    const scriptPath = join(dir, 'probe.ts')
    writeFileSync(scriptPath, `
import { SQL } from 'bun'
import { setConfig, defineModel, clearModelRegistry, createQueryBuilder, resetConnection } from ${JSON.stringify(srcEntry)}

const URL = ${JSON.stringify(PG_URL)}
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL:', msg); process.exit(1) } }

const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS _qb_posts')
await raw.unsafe('DROP TABLE IF EXISTS _qb_users')
await raw.unsafe('CREATE TABLE _qb_users (id serial primary key, name text, age int)')
// hasMany FK convention: snake_case(parent model name) + _id => pguser_id
await raw.unsafe('CREATE TABLE _qb_posts (id serial primary key, title text, pguser_id int)')
await raw.end()

setConfig({ dialect: 'postgres', database: { database: 'postgres', username: process.env.USER, host: 'localhost', port: 5432, password: '' } })
resetConnection()

// defineModel registers in the model registry, so relations resolve to the
// related model's explicit table.
clearModelRegistry()
const User = defineModel({ name: 'Pguser', table: '_qb_users', primaryKey: 'id', autoIncrement: true,
  hasMany: ['Pgpost'],
  attributes: { name: { type: 'string', fillable: true }, age: { type: 'number', fillable: true } } })
const Post = defineModel({ name: 'Pgpost', table: '_qb_posts', primaryKey: 'id', autoIncrement: true,
  attributes: { title: { type: 'string', fillable: true } } })

// INSERT ... RETURNING id (DriverExecutor.insert)
const u = await User.create({ name: 'Ada', age: 36 })
assert(u.id != null && u.id > 0, 'create() returned an id via RETURNING, got ' + u.id)

// find / where().first() ($n placeholders)
const found = await User.find(u.id)
assert(found && found.get('name') === 'Ada', 'find() round-trips')
const byName = await User.where('name', 'Ada').first()
assert(byName && byName.id === u.id, 'where().first() matches')

// aggregates (count returned as string by PG -> coerced)
await User.create({ name: 'Bob', age: 40 })
assert((await User.query().count()) === 2, 'count() == 2')
assert((await User.query().max('age')) === 40, 'max(age) == 40')

// UPDATE affected-row count (extractChanges via PG command tag)
const updated = await User.where('name', 'Ada').update({ age: 37 })
assert(updated === 1, 'update() affected 1, got ' + updated)

// hasMany eager load through the driver
await Post.create({ title: 'P1' })
await raw2()
async function raw2() {
  const r = new SQL(URL)
  await r.unsafe('UPDATE _qb_posts SET pguser_id = $1', [u.id])
  await r.end()
}
const withPosts = await User.where('id', u.id).with('pgpost').first()
const rel = withPosts.getRelation('pgpost')
assert(Array.isArray(rel) && rel.length === 1 && rel[0].get('title') === 'P1', 'hasMany eager-load loaded 1 post')

// DELETE affected-row count
const deleted = await User.where('name', 'Bob').delete()
assert(deleted === 1, 'delete() affected 1, got ' + deleted)
assert((await User.query().count()) === 1, 'count() == 1 after delete')

// Raw query builder against PG
const rows = await createQueryBuilder().selectFrom('_qb_users').where({ id: u.id }).get()
assert(rows.length === 1 && rows[0].name === 'Ada', 'raw selectFrom round-trips')

const cleanup = new SQL(URL)
await cleanup.unsafe('DROP TABLE IF EXISTS _qb_posts')
await cleanup.unsafe('DROP TABLE IF EXISTS _qb_users')
await cleanup.end()
console.log('OK')
`)

    const proc = Bun.spawnSync({ cmd: ['bun', scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env } })
    const dec = new TextDecoder()
    const out = dec.decode(proc.stdout).trim()
    const err = dec.decode(proc.stderr).trim()
    rmSync(dir, { recursive: true, force: true })
    expect(proc.exitCode, `pg integration failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toContain('OK')
  })
})
