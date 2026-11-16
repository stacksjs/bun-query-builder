/**
 * A write made through a model inside `db.transaction()` is part of that
 * transaction (stacksjs/stacks#3269).
 *
 * The model layer resolves its own executor: a `bun:sqlite` handle of its own,
 * or the pooled driver. `transaction()` ran on the builder's connection, and
 * nothing bound the one to the other, so `Person.update()` inside a callback
 * that threw stayed written, `Person.create()` stayed created, and a model
 * read could not see what the handle had written and not yet committed.
 *
 * Measured before the fix, SQLite: every case below except the commit and the
 * write after the transaction failed. Each dialect runs in its own subprocess
 * because the model executor and the shared connection are process-wide.
 *
 * Two models of a database are not one: a model layer pinned by
 * `configureOrm()` to a different database than the builder's keeps writing
 * there, outside the transaction, as before.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { MYSQL_URL, probeMysql } from './mysql'
import { PG_URL, probePostgres } from './pg'

// Real connections in a subprocess: the duration follows machine load.
setDefaultTimeout(30_000)

const pgAvailable = await probePostgres()
const mysqlAvailable = await probeMysql()

const srcEntry = resolve(import.meta.dir, '../src/index.ts')

const probe = `
import { SQL } from 'bun'
import { Database } from 'bun:sqlite'
import { clearModelRegistry, configureOrm, createQueryBuilder, defineModel, getDatabase, resetConnection, setConfig } from ${JSON.stringify(srcEntry)}

const [dialect, target, mode] = process.argv.slice(2)
const T = '_qb_model_tx_people'
const failures = []
const check = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) failures.push(label + ': got ' + g + ', want ' + w)
}
const boom = () => { throw new Error('boom') }
const attempt = async (run) => { try { await run() } catch (error) { if (error?.message !== 'boom') failures.push('unexpected error: ' + error?.message) } }

// What is committed, read on a connection of its own.
let committed
if (dialect === 'sqlite') {
  const raw = new Database(target, { create: true })
  raw.run('PRAGMA journal_mode = WAL')
  raw.run('DROP TABLE IF EXISTS ' + T)
  raw.run('CREATE TABLE ' + T + ' (id integer primary key autoincrement, name text)')
  committed = () => raw.query('SELECT name FROM ' + T + ' ORDER BY id').all().map(r => r.name)
  setConfig({ dialect: 'sqlite', database: { database: target } })
}
else {
  const raw = new SQL(target)
  await raw.unsafe('DROP TABLE IF EXISTS ' + T)
  await raw.unsafe(dialect === 'postgres'
    ? 'CREATE TABLE ' + T + ' (id serial primary key, name text)'
    : 'CREATE TABLE ' + T + ' (id int auto_increment primary key, name varchar(100))')
  committed = async () => (await raw.unsafe('SELECT name FROM ' + T + ' ORDER BY id')).map(r => r.name)
  setConfig({ dialect, database: { url: target } })
}
resetConnection()
clearModelRegistry()
if (mode === 'orm-same')
  configureOrm({ database: target })
if (mode === 'orm-memory') {
  configureOrm({ database: ':memory:' })
  getDatabase().run('CREATE TABLE ' + T + ' (id integer primary key autoincrement, name text)')
}

const Person = defineModel({
  name: 'ModelTxPerson',
  table: T,
  primaryKey: 'id',
  traits: { useTimestamps: false },
  attributes: { name: { type: 'string', fillable: true } },
})
const db = createQueryBuilder()

if (mode === 'orm-memory') {
  // A different database from the builder's: the model writes there, and the
  // builder's transaction cannot take that back.
  await attempt(() => db.transaction(() => { Person.create({ name: 'Elsewhere' }); boom() }))
  check('a model on another database keeps its write', await Person.where('name', 'Elsewhere').count(), 1)
  check('the builder database never saw it', await committed(), [])
}
else {
  const ada = await Person.create({ name: 'Ada' })
  const id = ada.get('id')

  await attempt(() => db.transaction(async () => {
    await Person.update(id, { name: 'Changed' })
    boom()
  }))
  check('model update rolls back', await committed(), ['Ada'])

  await attempt(() => db.transaction(() => {
    Person.create({ name: 'Ghost' })
    boom()
  }))
  check('model create rolls back', await committed(), ['Ada'])

  let seen
  await attempt(() => db.transaction(async (tx) => {
    await tx.updateTable(T).set({ name: 'InTx' }).where('id', '=', id).execute()
    seen = (await Person.find(id))?.get('name')
    boom()
  }))
  check('a model reads what the handle wrote', seen, 'InTx')
  check('and that rolls back', await committed(), ['Ada'])

  let counted
  await attempt(() => db.transaction(async (tx) => {
    await Person.create({ name: 'Bea' })
    counted = Number(await tx.selectFrom(T).where('name', '=', 'Bea').count())
    boom()
  }))
  check('the handle reads what a model wrote', counted, 1)
  check('and that rolls back too', await committed(), ['Ada'])

  await db.transaction(async () => { await Person.create({ name: 'Cy' }) })
  check('a model write commits with the transaction', await committed(), ['Ada', 'Cy'])

  await db.transaction(async (tx) => {
    await Person.create({ name: 'Outer' })
    await attempt(() => tx.transaction(async () => {
      await Person.create({ name: 'Inner' })
      boom()
    }))
  })
  check('a savepoint takes back only its own model writes', await committed(), ['Ada', 'Cy', 'Outer'])

  // Scheduled inside the callback, run after the commit: the transaction is
  // over, so the write is an ordinary one, not one on a closed transaction.
  let later
  await db.transaction(async () => {
    later = new Promise((done, fail) => setTimeout(() => { Promise.resolve().then(() => Person.create({ name: 'Later' })).then(done, fail) }, 20))
  })
  await later
  check('a write after the transaction is its own', await committed(), ['Ada', 'Cy', 'Outer', 'Later'])

  if (dialect !== 'sqlite') {
    // Another request's write while a transaction is open is not part of it.
    let release
    const gate = new Promise(done => { release = done })
    const open = attempt(() => db.transaction(async () => {
      await Person.create({ name: 'Inside' })
      await gate
      boom()
    }))
    await new Promise(done => setTimeout(done, 20))
    await Person.create({ name: 'Outside' })
    release()
    await open
    check('a write from outside the callback commits on its own', await committed(), ['Ada', 'Cy', 'Outer', 'Later', 'Outside'])
  }
}

console.log(JSON.stringify({ failures }))
process.exit(0)
`

function run(dialect: string, target: string, mode = 'config'): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'qb-model-tx-'))
  try {
    const script = join(dir, 'probe.ts')
    writeFileSync(script, probe)
    const resolved = dialect === 'sqlite' ? join(dir, target) : target
    const out = Bun.spawnSync(['bun', script, dialect, resolved, mode], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: process.env })
    const stdout = out.stdout.toString()
    const line = stdout.trim().split('\n').reverse().find(l => l.startsWith('{"failures"'))
    if (!line)
      throw new Error(`probe exited ${out.exitCode}\n${stdout}\n${out.stderr.toString()}`)
    return JSON.parse(line).failures
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('model writes inside db.transaction()', () => {
  it('belong to the transaction on SQLite', () => {
    expect(run('sqlite', 'people.db')).toEqual([])
  })

  it('belong to it when configureOrm() names the same SQLite file', () => {
    expect(run('sqlite', 'people.db', 'orm-same')).toEqual([])
  })

  it('stay outside it when configureOrm() names another database', () => {
    expect(run('sqlite', 'people.db', 'orm-memory')).toEqual([])
  })

  it.skipIf(!pgAvailable)('belong to the transaction on Postgres', () => {
    expect(run('postgres', PG_URL)).toEqual([])
  })

  it.skipIf(!mysqlAvailable)('belong to the transaction on MySQL', () => {
    expect(run('mysql', MYSQL_URL)).toEqual([])
  })
})
