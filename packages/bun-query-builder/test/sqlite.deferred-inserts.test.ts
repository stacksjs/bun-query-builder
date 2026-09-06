import { Database } from 'bun:sqlite'
import { SQL } from 'bun'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueryBuilder } from '../src/client'
import { config, defaultConfig, setConfig } from '../src/config'
import { getBunSql, getOrCreateBunSql, resetConnection, setSqlInstance } from '../src/db'
import type { DriverQuery } from '../src/db'

function syncQuery(db: ReturnType<typeof createQueryBuilder>, sql: string): unknown {
  // unsafe()'s public return type predates the native executeSync capability.
  return (db.unsafe(sql) as unknown as DriverQuery).executeSync!()
}

describe('connection-owned SQLite deferred inserts', () => {
  let directory: string
  let saved: typeof config

  beforeEach(() => {
    saved = { ...config }
    resetConnection()
    Object.assign(config, JSON.parse(JSON.stringify(defaultConfig)))
    directory = mkdtempSync(join(tmpdir(), 'bqb-deferred-'))
    setConfig({ dialect: 'sqlite', database: { database: join(directory, 'first.sqlite') } })
  })

  afterEach(() => {
    resetConnection()
    Object.assign(config, saved)
    rmSync(directory, { recursive: true, force: true })
  })

  it('awaits persistence and preserves every record shape and default', async () => {
    const db = createQueryBuilder()
    await db.unsafe("CREATE TABLE logs (name TEXT DEFAULT 'unnamed', tag TEXT DEFAULT 'default')")
    expect(typeof db.deferInsert).toBe('function')
    await Promise.all([
      db.deferInsert!('logs', { name: 'missing' }),
      db.deferInsert!('logs', { name: 'present', tag: 'custom' }),
      db.deferInsert!('logs', { name: 'null', tag: null }),
      db.deferInsert!('logs', {}),
      db.deferInsert!('logs', {}),
    ])
    expect(await db.unsafe('SELECT * FROM logs ORDER BY rowid')).toEqual([
      { name: 'missing', tag: 'default' },
      { name: 'present', tag: 'custom' },
      { name: 'null', tag: null },
      { name: 'unnamed', tag: 'default' },
      { name: 'unnamed', tag: 'default' },
    ])
  })

  it('flushes synchronously before reset and rejects later writes on the closed connection', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE logs (name TEXT)')
    expect(typeof db.deferInsert).toBe('function')
    const pending = db.deferInsert!('logs', { name: 'original' })
    resetConnection()
    const reader = new Database(join(directory, 'first.sqlite'), { readonly: true })
    try {
      expect(reader.query('SELECT name FROM logs').all()).toEqual([{ name: 'original' }])
    }
    finally {
      reader.close()
    }
    await pending
    await expect(db.deferInsert!('logs', { name: 'late' })).rejects.toThrow('closed')
  })

  it('drains the old connection when configuration replaces the cache', async () => {
    const db = createQueryBuilder()
    const original = getOrCreateBunSql()
    try {
      await db.unsafe('CREATE TABLE logs (name TEXT)')
      const pending = db.deferInsert!('logs', { name: 'original' })
      setConfig({ database: { database: join(directory, 'second.sqlite') } })
      const replacement = createQueryBuilder()
      expect(syncQuery(db, 'SELECT name FROM logs')).toEqual([{ name: 'original' }])
      await replacement.unsafe('CREATE TABLE logs (name TEXT)')
      await pending
      expect(await replacement.unsafe('SELECT name FROM logs')).toEqual([])
      // Configuration replacement preserves existing captured builders.
      await db.deferInsert!('logs', { name: 'still original' })
      expect(await db.unsafe('SELECT count(*) AS count FROM logs')).toEqual([{ count: 2 }])
    }
    finally {
      await original.close()
    }
  })

  it('rejects first-time deferred use after the connection is closed', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE logs (name TEXT)')
    resetConnection()
    await expect(db.deferInsert!('logs', { name: 'late' })).rejects.toThrow('closed')
  })

  it('preserves raw transactions and nested savepoint membership', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE logs (name TEXT)')
    const begin = db.unsafe('/* transaction control */ BEGIN') as unknown as DriverQuery
    const before = db.deferInsert!('logs', { name: 'outside' })
    // Queries captured before the queue exists must still reach its barriers.
    begin.executeSync!()
    await db.deferInsert!('logs', { name: 'transaction' })
    await db.unsafe('SAVEPOINT inner_scope')
    await db.deferInsert!('logs', { name: 'savepoint' })
    await db.unsafe('ROLLBACK TO inner_scope')
    await db.unsafe('RELEASE inner_scope')
    expect(await db.unsafe('SELECT name FROM logs')).toEqual([{ name: 'outside' }, { name: 'transaction' }])
    await db.unsafe('ROLLBACK')
    await before
    expect(await db.unsafe('SELECT name FROM logs')).toEqual([{ name: 'outside' }])
  })

  it('drains pending work before a custom connection replaces the cache', async () => {
    const db = createQueryBuilder()
    const original = getOrCreateBunSql()
    try {
      await db.unsafe('CREATE TABLE logs (name TEXT)')
      const pending = db.deferInsert!('logs', { name: 'original' })
      setConfig({ database: { database: join(directory, 'injected.sqlite') } })
      setSqlInstance(getBunSql())
      expect(syncQuery(db, 'SELECT name FROM logs')).toEqual([{ name: 'original' }])
      const replacement = createQueryBuilder()
      await replacement.unsafe('CREATE TABLE logs (name TEXT)')
      await pending
      expect(await replacement.unsafe('SELECT name FROM logs')).toEqual([])
    }
    finally {
      await original.close()
    }
  })

  it('leaves the capability absent on other drivers', async () => {
    // Bun opens this pool lazily; checking capabilities sends no queries.
    const connection = new SQL('postgres://unused:unused@127.0.0.1:1/unused')
    try {
      const db = createQueryBuilder({ sql: connection })
      expect(db.deferInsert).toBeUndefined()
      expect(db.flushDeferredInserts).toBeUndefined()
    }
    finally {
      await connection.close()
    }
  })

  it('can await inserts inside a managed transaction without deadlocking', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE logs (name TEXT)')
    const before = db.deferInsert!('logs', { name: 'outside' })
    await expect(db.transaction(async (tx) => {
      await tx.deferInsert!('logs', { name: 'inside' })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    await before
    expect(await db.unsafe('SELECT name FROM logs')).toEqual([{ name: 'outside' }])
  })

  for (const action of ['FAIL', 'ROLLBACK']) {
    it(`isolates a ${action} trigger without duplicating earlier records`, async () => {
      const db = createQueryBuilder()
      await db.unsafe('CREATE TABLE logs (name TEXT)')
      // AFTER triggers can leave both the rejected row and its side effects
      // behind without atomic rollback of the original batch and each retry.
      await db.unsafe('CREATE TABLE audit (name TEXT)')
      await db.unsafe(`CREATE TRIGGER reject_log AFTER INSERT ON logs WHEN NEW.name='bad'
        BEGIN INSERT INTO audit VALUES (NEW.name); SELECT RAISE(${action}, 'rejected'); END`)
      const results = await Promise.allSettled(['first', 'bad', 'last'].map(name => db.deferInsert!('logs', { name })))
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
      expect(await db.unsafe('SELECT name FROM logs ORDER BY rowid')).toEqual([{ name: 'first' }, { name: 'last' }])
      expect(await db.unsafe('SELECT name FROM audit')).toEqual([])
    })
  }

  it('isolates a commit-time foreign key failure before retrying valid rows', async () => {
    const db = createQueryBuilder()
    await db.unsafe('PRAGMA foreign_keys=ON')
    await db.unsafe('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
    await db.unsafe('INSERT INTO parents VALUES (1)')
    await db.unsafe('CREATE TABLE logs (parent INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)')
    const results = await Promise.allSettled([1, 2, 1].map(parent => db.deferInsert!('logs', { parent })))
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(await db.unsafe('SELECT parent FROM logs')).toEqual([{ parent: 1 }, { parent: 1 }])
  })

  it('drains before schema changes and PRAGMAs', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE logs (name TEXT)')
    const first = db.deferInsert!('logs', { name: 'before rename' })
    await db.unsafe('ALTER TABLE logs RENAME TO archive')
    const second = db.deferInsert!('archive', { name: 'before pragma' })
    syncQuery(db, 'PRAGMA user_version=1')
    expect(syncQuery(db, 'SELECT name FROM archive')).toEqual([{ name: 'before rename' }, { name: 'before pragma' }])
    await Promise.all([first, second])
  })

  it('bounds retained rows and offers an explicit synchronous flush', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE logs (name TEXT)')
    const pending = Array.from({ length: 33 }, (_, index) => db.deferInsert!('logs', { name: String(index) }))
    // Ordinary DML does not drain the queue; SELECT observes the row cap.
    expect(syncQuery(db, 'SELECT count(*) AS count FROM logs')).toEqual([{ count: 32 }])
    db.flushDeferredInserts!()
    expect(syncQuery(db, 'SELECT count(*) AS count FROM logs')).toEqual([{ count: 33 }])
    await Promise.all(pending)
  })

  it('bounds payload bytes and executes oversized records immediately', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE logs (value TEXT)')
    const first = db.deferInsert!('logs', { value: 'a'.repeat(70_000) })
    const second = db.deferInsert!('logs', { value: 'b'.repeat(70_000) })
    expect(syncQuery(db, 'SELECT count(*) AS count FROM logs')).toEqual([{ count: 1 }])
    const huge = db.deferInsert!('logs', { value: 'x'.repeat(150_000) })
    expect(syncQuery(db, 'SELECT count(*) AS count FROM logs')).toEqual([{ count: 3 }])
    await Promise.all([first, second, huge])
  })

  it('snapshots mutable bindings and quotes identifiers as literals', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE "logs; quoted" ("odd""column" BLOB, tag TEXT)')
    const bytes = new Uint8Array([1, 2, 3, 4])
    const record = { 'odd"column': bytes.subarray(1, 3), 'tag': 'original' }
    const pending = db.deferInsert!('logs; quoted', record)
    bytes.fill(9)
    record.tag = 'changed'
    await pending
    expect(await db.unsafe('SELECT * FROM "logs; quoted"')).toEqual([{ 'odd"column': new Uint8Array([2, 3]), 'tag': 'original' }])
  })

  it('releases oversized statement bindings after success and failure', async () => {
    const db = createQueryBuilder()
    await db.unsafe('CREATE TABLE logs (name TEXT, value TEXT)')
    await db.unsafe("CREATE TRIGGER reject_log BEFORE INSERT ON logs WHEN NEW.name='bad' BEGIN SELECT RAISE(FAIL, 'rejected'); END")
    const nativePrepare = Database.prototype.prepare
    const finalizers: Array<ReturnType<typeof spyOn>> = []
    // Observe resource release at the native driver boundary while executing
    // the actual statements. Cached statements retain their last bound values.
    const observer = spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database, sql: string) {
      const statement = nativePrepare.call(this, sql)
      if (sql.startsWith('INSERT INTO '))
        finalizers.push(spyOn(statement, 'finalize'))
      return statement
    } as typeof Database.prototype.prepare)
    try {
      await db.deferInsert!('logs', { name: 'good', value: 'x'.repeat(150_000) })
      await expect(db.deferInsert!('logs', { name: 'bad', value: 'y'.repeat(150_000) })).rejects.toThrow('rejected')
      expect(finalizers).toHaveLength(2)
      for (const finalize of finalizers)
        expect(finalize).toHaveBeenCalledTimes(1)
      expect(await db.unsafe('SELECT name FROM logs')).toEqual([{ name: 'good' }])
    }
    finally {
      observer.mockRestore()
      for (const finalize of finalizers)
        finalize.mockRestore()
    }
  })

  it('does not invoke query hooks for raw deferred inserts', async () => {
    const events: string[] = []
    const db = createQueryBuilder({ hooks: { onQueryEnd: event => events.push(event.sql) } })
    await db.unsafe('CREATE TABLE logs (name TEXT)')
    await db.deferInsert!('logs', { name: 'raw' })
    expect(events).toEqual([])
    await db.selectFrom('logs').get()
    expect(events.length).toBe(1)
  })

  for (const scenario of ['batch', 'retry', 'singleton']) {
    it(`invalidates the connection after a failed ${scenario} rollback`, async () => {
      const db = createQueryBuilder()
      await db.unsafe('CREATE TABLE logs (name TEXT, tag TEXT)')
      await db.unsafe("CREATE TRIGGER reject_log AFTER INSERT ON logs WHEN NEW.name='bad' BEGIN SELECT RAISE(FAIL, 'rejected'); END")
      const nativeTransaction = Database.prototype.transaction
      let calls = 0
      const failingCall = scenario === 'retry' ? 3 : 1
      // Fault injection at the native driver boundary: execute real BEGIN and
      // real INSERTs, but emulate the driver's rollback failing after an error.
      // This leaves an actual open SQLite transaction containing partial writes.
      const fault = spyOn(Database.prototype, 'transaction').mockImplementation(function (this: Database, fn: () => unknown) {
        const transaction = nativeTransaction.call(this, fn)
        if (++calls !== failingCall)
          return transaction
        return (() => {
          this.exec('BEGIN')
          fn()
          throw new Error('Expected the native INSERT to fail')
        }) as typeof transaction
      } as typeof Database.prototype.transaction)
      try {
        const records = scenario === 'singleton'
          ? [{ name: 'bad' }, { name: 'last', tag: 'different shape' }]
          : [{ name: 'first' }, { name: 'bad' }, { name: 'last' }]
        const outcomes = Promise.allSettled(records.map(record => db.deferInsert!('logs', record)))
        expect(() => syncQuery(db, 'COMMIT')).toThrow('unusable')
        expect((await outcomes).map(result => result.status)).toEqual(
          scenario === 'retry' ? ['fulfilled', 'rejected', 'rejected'] : records.map(() => 'rejected'),
        )
        await expect(db.deferInsert!('logs', { name: 'later' })).rejects.toThrow('unusable')
        expect(() => syncQuery(db, 'SELECT * FROM logs')).toThrow('unusable')
        const reader = new Database(join(directory, 'first.sqlite'), { readonly: true })
        try {
          expect(reader.query('SELECT name FROM logs').all()).toEqual(scenario === 'retry' ? [{ name: 'first' }] : [])
        }
        finally {
          reader.close()
        }
      }
      finally {
        fault.mockRestore()
      }
    })
  }
})
