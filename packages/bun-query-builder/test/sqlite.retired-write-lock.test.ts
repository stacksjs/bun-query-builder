/**
 * Regression coverage for stacksjs/stacks#2922: when a transaction was retired
 * mid-flight, `closeConnection()` resolved successfully but the SQLite file
 * stayed write-locked for the rest of the process. The next connection's first
 * write failed with SQLITE_BUSY after the native 5000ms busy timeout.
 *
 * Cause: the wrapper routes statements it cannot cache through `db.prepare()`
 * and never finalized them. An outstanding uncached sqlite3_stmt keeps the
 * database handle alive, so `db.close()` defers to a garbage collection that
 * may never arrive. Transactions hit it every time -- `BEGIN`, `COMMIT`,
 * `ROLLBACK` and `SAVEPOINT` all miss CACHEABLE_SQLITE_STATEMENT, which
 * matches only SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE. Instrumented to
 * confirm: BEGIN/COMMIT go through `prepare`, the UPDATE through `query`.
 *
 * Two conditions are both required, which is why a plain commit-then-close
 * does not reproduce: the transaction must still be open (bqb runs in WAL
 * mode, where COMMIT releases the lock), and the leaked statement must still
 * be alive. Retiring the connection mid-transaction gives both -- the rollback
 * cannot run on an already-closed handle.
 */

import { Database } from 'bun:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { config } from '../src/config'
import { closeConnection, getOrCreateBunSql, resetConnection } from '../src/db'

describe('sqlite write locks after a retired connection', () => {
  let root: string
  let dbPath: string
  let snapshot: { dialect: typeof config.dialect, database: Record<string, unknown> }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'bqb-retired-write-lock-')))
    dbPath = join(root, 'probe.sqlite')
    snapshot = { dialect: config.dialect, database: { ...config.database } }
    config.dialect = 'sqlite'
    config.database.database = dbPath
    resetConnection()
  })

  afterEach(async () => {
    await closeConnection().catch(() => {})
    config.dialect = snapshot.dialect
    for (const key of Object.keys(config.database)) delete (config.database as any)[key]
    Object.assign(config.database, snapshot.database)
    resetConnection()
    rmSync(root, { recursive: true, force: true })
  })

  async function seed(): Promise<any> {
    const sql = getOrCreateBunSql()
    await sql.unsafe('CREATE TABLE probe (id INTEGER PRIMARY KEY, generation INTEGER)').execute()
    await sql.unsafe('INSERT INTO probe (id, generation) VALUES (1, 0)').execute()
    return sql
  }

  /**
   * Write from a connection the wrapper knows nothing about. The timeout is
   * shortened from the native 5000ms default so a held lock fails fast instead
   * of making the suite wait it out.
   */
  function writeFromAFreshConnection(): void {
    const fresh = new Database(dbPath)
    try {
      fresh.exec('PRAGMA busy_timeout = 1000')
      fresh.exec('INSERT INTO probe (id, generation) VALUES (2, 0)')
    }
    finally {
      fresh.close(true)
    }
  }

  it('releases the write lock when a transaction is retired mid-flight', async () => {
    const sql = await seed()

    let closing: Promise<void> | undefined
    await expect((sql as any).begin(async (tx: any) => {
      const pending = tx.unsafe('UPDATE probe SET generation = 1 WHERE id = 1 RETURNING generation').execute()
      queueMicrotask(() => { closing = closeConnection() })
      await pending
      // The retired handle must still refuse this. Releasing the lock is not
      // allowed to come at the cost of the closed-handle fence.
      tx.unsafe('SELECT generation FROM probe').executeSync()
    })).rejects.toThrow(/closed database/)
    await closing

    expect(() => writeFromAFreshConnection()).not.toThrow()
  })

  it('leaves no lock behind when the connection is reset mid-flight', async () => {
    const sql = await seed()

    await expect((sql as any).begin(async (tx: any) => {
      const pending = tx.unsafe('UPDATE probe SET generation = 1 WHERE id = 1 RETURNING generation').execute()
      queueMicrotask(() => { resetConnection() })
      await pending
      tx.unsafe('SELECT generation FROM probe').executeSync()
    })).rejects.toThrow(/closed database/)
    // `resetConnection()` discards the handle without awaiting a drain, so
    // close explicitly to settle any retired closure before measuring.
    await closeConnection()

    expect(() => writeFromAFreshConnection()).not.toThrow()
  })

  it('does not finalize the statements bun:sqlite caches for reuse', async () => {
    // Guards the other direction: only statements the wrapper prepared itself
    // may be finalized. Finalizing a cached one does not throw -- bun:sqlite
    // re-prepares it -- so the observable damage is a silently defeated
    // statement cache. Count the prepares rather than the results.
    const sql = getOrCreateBunSql()
    await sql.unsafe('CREATE TABLE probe (id INTEGER PRIMARY KEY, generation INTEGER)').execute()
    await sql.unsafe('INSERT INTO probe (id, generation) VALUES (1, 7)').execute()

    const read = 'SELECT generation FROM probe WHERE id = ?'
    // Over-finalizing is invisible in the results: bun:sqlite evicts a
    // finalized statement from its cache and re-prepares on the next
    // `query()`, so the rows still come back. What changes is identity -- the
    // cache hands out a fresh statement every time instead of reusing one.
    const query = spyOn(Database.prototype, 'query')
    try {
      for (let attempt = 0; attempt < 3; attempt++)
        expect(await sql.unsafe(read, [1])).toEqual([{ generation: 7 }])

      const handedOut = query.mock.results
        .filter((result: any) => result.type === 'return')
        .map((result: any) => result.value)
      expect(handedOut).toHaveLength(3)
      expect(new Set(handedOut).size).toBe(1)
    }
    finally {
      query.mockRestore()
    }

    // A re-prepared statement (cacheable SQL, no arguments given, but real
    // placeholders) is the wrapper's own and IS finalized -- reusing the SQL
    // afterwards must still work.
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await sql.unsafe(read)).toEqual([])
  })
})
