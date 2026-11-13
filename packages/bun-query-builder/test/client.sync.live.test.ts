/**
 * The query builder answers where it is written, on a network database.
 *
 * `const rows = db.selectFrom('users').where(...).get()` was a pending promise
 * on MySQL and Postgres, and `db.transaction(fn)` was one on every database.
 * The builder now runs on the connection in src/sync-connection.ts: a
 * statement is its rows, and a transaction is done when it returns, on one
 * connection the worker holds open from BEGIN to COMMIT.
 *
 * These run the un-awaited API against live servers, in a process of their
 * own so the configuration and the worker are theirs alone. The probe never
 * calls `process.exit`: a worker that kept the process alive would show up as
 * a timeout here.
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
    ? 'CREATE TABLE _qb_sync_orders (id serial primary key, customer text, total integer default 0, placed_at timestamp)'
    : 'CREATE TABLE _qb_sync_orders (id int auto_increment primary key, customer varchar(190), total int default 0, placed_at datetime)'
  return `
import { SQL } from 'bun'
import { createQueryBuilder, resetConnection, setConfig } from ${src('index.ts')}
import { closeConnection, setSqlInstance } from ${src('db.ts')}
import { isThenable } from ${src('settle.ts')}

const URL = ${JSON.stringify(url)}
const DIALECT = ${JSON.stringify(dialect)}
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}
const plain = (label, value) => {
  if (isThenable(value)) failures.push(label + ' returned a promise')
  return value
}
const throws = (label, run, pattern) => {
  let thrown
  try { const value = run(); if (isThenable(value)) failures.push(label + ' returned a promise instead of throwing') }
  catch (error) { thrown = error }
  if (!thrown || !pattern.test(String(thrown.message))) failures.push(label + ': threw ' + (thrown ? thrown.message : 'nothing'))
  return thrown
}

const raw = new SQL(URL)
await raw.unsafe('DROP TABLE IF EXISTS _qb_sync_orders')
await raw.unsafe(${JSON.stringify(ddl)})
await raw.unsafe("INSERT INTO _qb_sync_orders (customer, total, placed_at) VALUES ('ada', 100, '2026-01-01 00:00:00'), ('grace', 250, '2026-02-01 00:00:00'), ('linus', 75, '2026-03-01 00:00:00')")
const outside = () => raw.unsafe('SELECT customer FROM _qb_sync_orders ORDER BY id').then(rows => rows.map(row => row.customer))

setConfig({ dialect: DIALECT, database: { url: URL } })
resetConnection()
const db = createQueryBuilder()
const orders = () => db.selectFrom('_qb_sync_orders')

// Reads, with and without await.
const awaited = await orders().where('total', '>', 80).orderBy('total', 'desc').get()
const bare = plain('get()', orders().where('total', '>', 80).orderBy('total', 'desc').get())
check('un-awaited get is the rows', bare.map(row => row.customer), ['grace', 'ada'])
check('awaited and un-awaited agree', bare, awaited)
check('first', plain('first()', orders().where({ customer: 'linus' }).first())?.total, 75)
check('a missing row is undefined', plain('first(missing)', orders().where({ customer: 'nobody' }).first()), undefined)
check('execute', plain('execute()', orders().orderBy('id').execute()).length, 3)
check('count', plain('count()', orders().count()), 3)
check('sum', Number(plain('sum()', orders().sum('total'))), 425)
check('max', Number(plain('max()', orders().max('total'))), 250)
check('exists', plain('exists()', orders().where({ customer: 'ada' }).exists()), true)
check('pluck', plain('pluck()', orders().orderBy('id').pluck('customer')), ['ada', 'grace', 'linus'])
check('value', plain('value()', orders().where({ customer: 'grace' }).value('total')), 250)
check('find', plain('find()', orders().find(1))?.customer, 'ada')
const page = plain('paginate()', orders().orderBy('id').paginate(2, 1))
check('paginate', [page.data.length, page.meta.total, page.meta.lastPage], [2, 3, 2])
check('a Date binds', plain('where(date)', orders().where('placed_at', '<', new Date(Date.UTC(2026, 1, 15))).count()), 2)
const seen = []
plain('chunk()', orders().orderBy('id').chunk(2, rows => { seen.push(rows.length) }))
check('chunk ran in place', seen, [2, 1])
check('unsafe', plain('unsafe().execute()', db.unsafe('SELECT COUNT(*) AS c FROM _qb_sync_orders').execute()).length, 1)
check('unsafe is still awaitable', (await db.unsafe('SELECT COUNT(*) AS c FROM _qb_sync_orders')).length, 1)

// Writes.
plain('insert execute()', db.insertInto('_qb_sync_orders').values({ customer: 'new', total: 10 }).execute())
check('an insert is visible to the next line', orders().count(), 4)
check('update', plain('update execute()', db.updateTable('_qb_sync_orders').set({ total: 11 }).where({ customer: 'new' }).execute()), 1)
check('an update is visible to the next line', orders().where({ customer: 'new' }).value('total'), 11)
check('delete', plain('delete execute()', db.deleteFrom('_qb_sync_orders').where({ customer: 'new' }).execute()), 1)
check('back to three rows', orders().count(), 3)
const created = plain('create()', db.create('_qb_sync_orders', { customer: 'made', total: 5 }))
check('create returns the row', created?.customer, 'made')
plain('remove()', db.remove('_qb_sync_orders', created.id))
check('and remove takes it away', orders().count(), 3)

// A failure is thrown where the call stands, as the driver reported it.
const failure = throws('a driver error', () => db.selectFrom('_qb_sync_no_such_table').get(), /_qb_sync_no_such_table/)
check('a driver error keeps its name', failure?.name, DIALECT === 'postgres' ? 'PostgresError' : 'MySQLError')
check('the connection survives an error', orders().count(), 3)

// A transaction is done when it returns.
const result = plain('transaction()', db.transaction((tx) => {
  tx.insertInto('_qb_sync_orders').values({ customer: 'in-tx', total: 1 }).execute()
  // Its own statements see its own writes: they run on the one connection.
  return tx.selectFrom('_qb_sync_orders').count()
}))
check('a transaction sees its own writes', result, 4)
check('and they are committed when it returns', await outside(), ['ada', 'grace', 'linus', 'in-tx'])

// A callback that throws rolls everything back, and the error is the callback's.
throws('a transaction that throws', () => db.transaction((tx) => {
  tx.deleteFrom('_qb_sync_orders').where({ customer: 'ada' }).execute()
  check('the delete is real inside the transaction', tx.selectFrom('_qb_sync_orders').count(), 3)
  throw new Error('changed my mind')
}), /changed my mind/)
check('a thrown callback rolled back', await outside(), ['ada', 'grace', 'linus', 'in-tx'])

// Nothing else sees a transaction's writes until it commits.
let midway
db.transaction((tx) => {
  tx.insertInto('_qb_sync_orders').values({ customer: 'unseen', total: 1 }).execute()
  // The builder outside the transaction is another connection.
  midway = db.selectFrom('_qb_sync_orders').count()
  tx.deleteFrom('_qb_sync_orders').where({ customer: 'unseen' }).execute()
})
check('an open transaction is invisible to other connections', midway, 4)

// A nested transaction is a savepoint: it rolls back alone.
db.transaction((tx) => {
  tx.insertInto('_qb_sync_orders').values({ customer: 'outer', total: 1 }).execute()
  try {
    tx.transaction((inner) => {
      inner.insertInto('_qb_sync_orders').values({ customer: 'inner', total: 1 }).execute()
      throw new Error('inner only')
    })
  }
  catch {}
  tx.savepoint((sp) => { sp.updateTable('_qb_sync_orders').set({ total: 2 }).where({ customer: 'outer' }).execute() })
})
check('the savepoint rolled back, the transaction committed', await outside(), ['ada', 'grace', 'linus', 'in-tx', 'outer'])
check('and a savepoint that returned was kept', orders().where({ customer: 'outer' }).value('total'), 2)

// A callback that has to wait is waited for: the transaction is then a promise.
const later = db.transaction(async (tx) => {
  await Bun.sleep(5)
  await tx.deleteFrom('_qb_sync_orders').where('customer', 'in', ['in-tx', 'outer']).execute()
  return 'waited'
})
check('an async callback makes the transaction a promise', isThenable(later), true)
check('which resolves to what the callback returned', await later, 'waited')
check('and commits', await outside(), ['ada', 'grace', 'linus'])
const failed = db.transaction(async (tx) => {
  await tx.deleteFrom('_qb_sync_orders').execute()
  throw new Error('async and wrong')
})
check('an async callback that throws rejects', await failed.then(() => 'resolved', error => error.message), 'async and wrong')
check('and rolls back', await outside(), ['ada', 'grace', 'linus'])

// A transaction whose callback has to wait stays open while other code runs,
// holding its locks. A statement that needs one of them cannot be waited for
// on this thread: the commit it is waiting for is a continuation waiting for
// this thread. So that statement, and only that one, answers with a promise.
await raw.unsafe("UPDATE _qb_sync_orders SET total = 10 WHERE customer = 'ada'")
await Promise.all(Array.from({ length: 8 }, () => db.transaction(async (tx) => {
  const [row] = await tx.unsafe("SELECT total FROM _qb_sync_orders WHERE customer = 'ada' FOR UPDATE").execute()
  await Bun.sleep(2)
  await tx.updateTable('_qb_sync_orders').set({ total: Number(row.total) + 1 }).where({ customer: 'ada' }).execute()
})))
check('eight transactions that lock the same row each see the last one', orders().where({ customer: 'ada' }).value('total'), 18)

let contended
let uncontended
const holding = db.transaction(async (tx) => {
  await tx.updateTable('_qb_sync_orders').set({ total: 500 }).where({ customer: 'grace' }).execute()
  await Bun.sleep(5)
  uncontended = db.selectFrom('_qb_sync_orders').where({ customer: 'linus' }).first()
  contended = db.updateTable('_qb_sync_orders').set({ total: 600 }).where({ customer: 'grace' }).execute()
  await Bun.sleep(20)
})
await holding
check('a read that needs nothing held is still a value while a transaction is held', [isThenable(uncontended), uncontended?.total], [false, 75])
check('a statement that needs the held lock is a promise', isThenable(contended), true)
check('which resolves once the transaction has committed', await contended, 1)
check('and was applied after it', orders().where({ customer: 'grace' }).value('total'), 600)
check('with nothing held, a statement is a value again', plain('count() after the held transaction', orders().count()), 3)

// More open transactions than the pool has connections: the ones that have to
// wait for a connection wait as promises, not on this thread.
const crowded = await Promise.all(Array.from({ length: 14 }, () => db.transaction(async (tx) => {
  await Bun.sleep(3)
  return tx.selectFrom('_qb_sync_orders').count()
})))
check('more transactions than connections all finish', crowded, Array(14).fill(3))
await raw.unsafe("UPDATE _qb_sync_orders SET total = 100 WHERE customer = 'ada'")
await raw.unsafe("UPDATE _qb_sync_orders SET total = 250 WHERE customer = 'grace'")

// Many transactions in a row: each connection goes back to the pool.
let total = 0
for (let i = 0; i < 60; i++) total += db.transaction(tx => tx.selectFrom('_qb_sync_orders').count())
check('60 transactions in a row', total, 180)

// A reserved connection is one session until it is released.
const reserved = plain('reserve()', db.reserve())
check('a reserved connection answers in place', plain('reserved get()', reserved.selectFrom('_qb_sync_orders').count()), 3)
reserved.release()

// The template form: identifiers and values are the driver's own helpers.
const viaTemplate = plain('template', db.sql\`SELECT customer FROM \${db.id('_qb_sync_orders')} WHERE total > \${80} ORDER BY id\`.executeSync())
check('a template statement', viaTemplate.map(row => row.customer), ['ada', 'grace'])
check('and it is still awaitable', (await db.sql\`SELECT COUNT(*) AS c FROM \${db.id('_qb_sync_orders')}\`).length, 1)

// The statement limit applies here as it does to a model call.
const holder = await raw.reserve()
await holder.unsafe('BEGIN')
await holder.unsafe("UPDATE _qb_sync_orders SET total = 1 WHERE id = 1")
setConfig({ models: { timeoutMs: 400 } })
const blocked = throws('a blocked statement', () => db.updateTable('_qb_sync_orders').set({ total: 2 }).where({ id: 1 }).execute(), /did not answer within/)
check('a blocked statement names its code', blocked?.code, 'ERR_QB_MODEL_STATEMENT_TIMEOUT')
await holder.unsafe('ROLLBACK')
holder.release()
setConfig({ models: { timeoutMs: 30000 } })
check('the next statement gets its own answer', orders().count(), 3)

// models.execution: 'async' asks for promises on purpose.
setConfig({ models: { execution: 'async' } })
const asked = createQueryBuilder().selectFrom('_qb_sync_orders').count()
check('execution async returns a promise', isThenable(asked), true)
check('and it resolves to the same answer', await asked, 3)
setConfig({ models: { execution: 'sync' } })
check('execution sync is in place again', plain('count() after switching back', createQueryBuilder().selectFrom('_qb_sync_orders').count()), 3)

// A connection the caller supplied lives on this thread: promises.
const own = new SQL(URL)
setSqlInstance(own)
const injected = createQueryBuilder().selectFrom('_qb_sync_orders').count()
check('an injected connection returns a promise', isThenable(injected), true)
check('and it resolves', await injected, 3)
resetConnection()

await raw.unsafe('DROP TABLE IF EXISTS _qb_sync_orders')
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
  const dir = mkdtempSync(join(tmpdir(), `qb-sync-builder-${dialect}-`))
  const scriptPath = join(dir, 'probe.ts')
  writeFileSync(scriptPath, probe(dialect, url))
  const proc = Bun.spawnSync({ cmd: [process.execPath, scriptPath], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env }, timeout: 45_000 })
  const out = proc.stdout.toString().trim()
  const err = proc.stderr.toString().trim()
  rmSync(dir, { recursive: true, force: true })
  expect(proc.exitCode, `sync builder probe (${dialect}) failed or never exited.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
  expect(out).toContain('OK')
}

describe.skipIf(!pgAvailable)('the query builder answers in place on live Postgres', () => {
  it('reads, writes, transactions, failures, and the two ways to get promises back', () => {
    run('postgres', PG_URL)
  }, 60_000)
})

describe.skipIf(!mysqlAvailable)('the query builder answers in place on live MySQL', () => {
  it('reads, writes, transactions, failures, and the two ways to get promises back', () => {
    run('mysql', MYSQL_URL)
  }, 60_000)
})
