/**
 * A model call returns its value where it is written, on a network database.
 *
 * Bun's MySQL and Postgres drivers answer with promises, so this is the case
 * that needed work: the model layer holds its connection on a worker thread
 * and waits for each statement (src/sync-driver.ts). These run the un-awaited
 * API against live servers, in a process of their own so the configuration
 * and the worker are theirs alone. The probe never calls `process.exit`: a
 * worker that kept the process alive would show up as a timeout here.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { MYSQL_URL, probeMysql } from './mysql'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()
const mysqlAvailable = await probeMysql()

function probe(dialect: 'postgres' | 'mysql', url: string): string {
  const src = (file: string): string => JSON.stringify(resolve(import.meta.dir, '../src', file))
  const ddl = dialect === 'postgres'
    ? 'CREATE TABLE _qb_sync_users (id serial primary key, email text, name text, visits integer default 0, created_at timestamp, updated_at timestamp)'
    : 'CREATE TABLE _qb_sync_users (id int auto_increment primary key, email varchar(190), name varchar(190), visits int default 0, created_at datetime, updated_at datetime)'
  return `
import { SQL } from 'bun'
import { clearModelRegistry, createModel, resetConnection, setConfig } from ${src('index.ts')}
import { closeConnection, setSqlInstance } from ${src('db.ts')}
import { isThenable } from ${src('settle.ts')}

const URL = ${JSON.stringify(url)}
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}
const plain = (label, value) => {
  if (isThenable(value)) failures.push(label + ' returned a promise')
  return value
}

const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS _qb_sync_users')
await raw.unsafe(${JSON.stringify(ddl)})
await raw.unsafe("INSERT INTO _qb_sync_users (email, name, created_at) VALUES ('ada@example.com', 'Ada', '2026-01-01 00:00:00'), ('grace@example.com', 'Grace', '2026-02-01 00:00:00'), ('linus@elsewhere.org', 'Linus', '2026-03-01 00:00:00')")

setConfig({ dialect: ${JSON.stringify(dialect)}, database: { url: URL } })
resetConnection()
clearModelRegistry()
const User = createModel({ name: 'SyncLiveUser', table: '_qb_sync_users', primaryKey: 'id',
  attributes: { email: { type: 'string', fillable: true }, name: { type: 'string', fillable: true }, visits: { type: 'integer', fillable: true } } })

// The chain from the report, with and without await.
const awaited = await User.where('email', 'like', '%@example.com').orderByDesc('created_at').first()
const bare = plain('first()', User.where('email', 'like', '%@example.com').orderByDesc('created_at').first())
check('un-awaited first is the row', bare?.get('email'), 'grace@example.com')
check('awaited and un-awaited agree', bare?.toJSON(), awaited?.toJSON())

// Reads.
check('count', plain('count()', User.count()), 3)
check('find', plain('find()', User.find(1))?.get('name'), 'Ada')
check('missing row is undefined', plain('find(missing)', User.find(987654)), undefined)
check('get', plain('get()', User.where('id', '>', 1).orderBy('id').get()).map(u => u.get('name')), ['Grace', 'Linus'])
check('exists', plain('exists()', User.where('email', 'ada@example.com').exists()), true)
check('pluck', plain('pluck()', User.orderBy('id').pluck('name')), ['Ada', 'Grace', 'Linus'])
check('paginate', plain('paginate()', User.orderBy('id').paginate(1, 2)).data.length, 2)
check('a Date binds', plain('where(date)', User.where('created_at', '<', new Date(Date.UTC(2026, 1, 15))).count()), 2)

// Writes.
const made = plain('create()', User.create({ email: 'new@example.com', name: 'New' }))
check('create returns the row with its key', typeof Number(made.get('id')) === 'number' && Number(made.get('id')) > 3, true)
check('create is visible to the next line', User.count(), 4)
plain('update()', made.update({ name: 'Renamed', visits: 2 }))
check('update is visible to the next line', User.find(made.get('id'))?.get('name'), 'Renamed')
check('increment', plain('increment()', User.where('id', made.get('id')).increment('visits', 3)), 1)
check('incremented value', Number(User.find(made.get('id'))?.get('visits')), 5)
const many = plain('createMany()', User.createMany([{ email: 'a@x.io', name: 'A' }, { email: 'b@x.io', name: 'B' }]))
check('createMany pairs keys', many.map(m => m.get('name')), ['A', 'B'])
check('query delete', plain('query delete()', User.where('email', 'like', '%@x.io').delete()), 2)
check('instance delete', plain('delete()', made.delete()), true)
check('back to three rows', User.count(), 3)

// Failures are thrown where the call stands, as the driver reported them.
let thrown
try { User.findOrFail(987654) } catch (error) { thrown = error }
check('findOrFail throws in place', thrown?.message, 'SyncLiveUser with id 987654 not found')
const Missing = createModel({ name: 'SyncLiveMissing', table: '_qb_sync_no_such_table', primaryKey: 'id', attributes: { name: { type: 'string', fillable: true } } })
thrown = undefined
try { Missing.count() } catch (error) { thrown = error }
check('a driver error throws in place', thrown instanceof Error && /_qb_sync_no_such_table/.test(thrown.message), true)
check('a driver error keeps its name', thrown?.name, ${JSON.stringify(dialect === 'postgres' ? 'PostgresError' : 'MySQLError')})
check('the connection survives an error', User.count(), 3)

// Many statements in a row, each one finished before the next begins.
let total = 0
for (let i = 0; i < 200; i++) total += User.where('id', '<=', (i % 3) + 1).count()
check('200 statements in order', total, 67 * 1 + 67 * 2 + 66 * 3)

// models.execution: 'async' asks for promises on purpose.
setConfig({ models: { execution: 'async' } })
const asked = User.count()
check('execution async returns a promise', isThenable(asked), true)
check('and it resolves to the same answer', await asked, 3)
setConfig({ models: { execution: 'sync' } })
check('execution sync is in place again', plain('count() after switching back', User.count()), 3)

// A connection the caller supplied lives on this thread: promises.
const own = new SQL(URL)
setSqlInstance(own)
const injected = User.count()
check('an injected connection returns a promise', isThenable(injected), true)
check('and it resolves', await injected, 3)
resetConnection()
check('without it, in place again', plain('count() after reset', User.count()), 3)

await raw.unsafe('DROP TABLE IF EXISTS _qb_sync_users')
await raw.end()
await closeConnection()

if (failures.length) {
  console.error('FAILURES:\\n' + failures.join('\\n'))
  process.exitCode = 1
}
else {
  console.log('OK')
}
`
}

function run(dialect: 'postgres' | 'mysql', url: string): void {
  const dir = mkdtempSync(join(tmpdir(), `qb-sync-${dialect}-`))
  const scriptPath = join(dir, 'probe.ts')
  writeFileSync(scriptPath, probe(dialect, url))
  const proc = Bun.spawnSync({ cmd: [process.execPath, scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env }, timeout: 45_000 })
  const out = proc.stdout.toString().trim()
  const err = proc.stderr.toString().trim()
  rmSync(dir, { recursive: true, force: true })
  expect(proc.exitCode, `sync model probe (${dialect}) failed or never exited.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
  expect(out).toContain('OK')
}

describe.skipIf(!pgAvailable)('model calls answer in place on live Postgres', () => {
  it('reads, writes, failures, and the two ways to get promises back', () => {
    run('postgres', PG_URL)
  }, 60_000)
})

describe.skipIf(!mysqlAvailable)('model calls answer in place on live MySQL', () => {
  it('reads, writes, failures, and the two ways to get promises back', () => {
    run('mysql', MYSQL_URL)
  }, 60_000)
})
