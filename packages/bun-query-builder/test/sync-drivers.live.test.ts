/**
 * The two synchronous drivers behave as one.
 *
 * sync-driver.ts keeps the connection on a worker thread. native-sync-driver.ts
 * waits on the calling thread, where the runtime's driver can (a Bun that has
 * `query.wait()`, see stacksjs/bun). Everything above them is written against
 * what they share, so every case here runs against each one this runtime can
 * open, on each database that answers: on stock Bun that is the worker alone,
 * on a Bun with the calls it is both.
 */

import type { SyncDatabase, SyncQueryResult } from '../src/sync-driver'
import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { resetConnection, setConfig } from '../src'
import { hasNativeSync, NativeSyncDriver } from '../src/native-sync-driver'
import { StatementTimeoutError, SyncDriver } from '../src/sync-driver'
import { openSyncDriver } from '../src/sync-transport'
import { MYSQL_URL, probeMysql } from './mysql'
import { PG_URL, probePostgres } from './pg'

const pgAvailable = await probePostgres()
const mysqlAvailable = await probeMysql()

const isPromise = (value: unknown): value is Promise<unknown> => value !== null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function'

/** The value of an answer that must not have had to wait. */
function inPlace<T>(answer: T | Promise<T>, what: string): T {
  expect(isPromise(answer), `${what} answered with a promise`).toBe(false)
  return answer as T
}

const runtimeHasNative = ((): boolean => {
  const probe = new SQL(PG_URL)
  const has = hasNativeSync(probe)
  void probe.close({ timeout: 0 }).catch(() => {})
  return has
})()

interface Dialect {
  name: 'postgres' | 'mysql'
  url: string
  available: boolean
  sleep: (seconds: number) => string
}

const dialects: Dialect[] = [
  { name: 'postgres', url: PG_URL, available: pgAvailable, sleep: seconds => `SELECT pg_sleep(${seconds})` },
  { name: 'mysql', url: MYSQL_URL, available: mysqlAvailable, sleep: seconds => `SELECT SLEEP(${seconds})` },
]

const transports: Array<{ name: 'worker' | 'native', runs: boolean, open: (url: string) => SyncDatabase }> = [
  { name: 'worker', runs: true, open: url => new SyncDriver(url, { max: 4 }) },
  { name: 'native', runs: runtimeHasNative, open: url => NativeSyncDriver.open(url, { max: 4 })! },
]

describe('which driver a connection gets', () => {
  // Where a run is there to test the driver on the calling thread (CI's test-native job), a runtime without the
  // calls must fail it: the cases below would otherwise test the worker a second time and say nothing.
  test.skipIf(process.env.EXPECT_NATIVE_SYNC !== '1')('this runtime has the synchronous calls', () => {
    expect(runtimeHasNative).toBe(true)
  })

  test.skipIf(!pgAvailable)('the one on the calling thread where the runtime has the calls, the worker where it does not or when asked', () => {
    const chosen = openSyncDriver(PG_URL, { max: 1 })
    expect(chosen instanceof NativeSyncDriver).toBe(runtimeHasNative)
    expect(chosen instanceof SyncDriver).toBe(!runtimeHasNative)
    chosen.close()

    setConfig({ models: { transport: 'worker' } })
    try {
      const asked = openSyncDriver(PG_URL, { max: 1 })
      expect(asked instanceof SyncDriver).toBe(true)
      asked.close()
    }
    finally {
      setConfig({ models: { transport: 'auto' } })
      resetConnection()
    }
  })
})

for (const dialect of dialects) {
  for (const transport of transports) {
    describe.skipIf(!dialect.available || !transport.runs)(`${dialect.name} through the ${transport.name} driver`, () => {
      const table = `sync_driver_${dialect.name}_${transport.name}_${process.pid}`
      let driver!: SyncDatabase
      const open = (): SyncDatabase => driver ??= transport.open(dialect.url)
      const names = (): string[] => (inPlace(open().unsafe(`SELECT name FROM ${table} ORDER BY id`), 'a read') as SyncQueryResult).map(row => String(row.name))

      afterAll(() => {
        try {
          open().unsafe(`DROP TABLE IF EXISTS ${table}`)
        }
        finally {
          open().close()
        }
      })

      test('a statement is its rows, with its parameters and its result modes', () => {
        const rows = inPlace(open().unsafe('SELECT 1 AS one'), 'a statement')
        expect(Number(rows[0].one)).toBe(1)
        const placeholder = dialect.name === 'postgres' ? '$1' : '?'
        const bound = inPlace(open().unsafe(`SELECT LOWER(${placeholder}) AS word`, ['TEXT']), 'a bound statement')
        expect(bound[0].word).toBe('text')
        const values = inPlace(open().unsafe('SELECT 1 AS a, 2 AS b', [], undefined, { mode: 'values' }), 'a values statement') as unknown as unknown[][]
        expect(values[0].map(Number)).toEqual([1, 2])
      })

      test('a template built by the caller runs on the connection', () => {
        const template = { __qb: 'template' as const, strings: ['SELECT LOWER(', ') AS word'], raw: ['SELECT LOWER(', ') AS word'], values: ['WORD'] }
        expect(inPlace(open().template(template), 'a template')[0].word).toBe('word')
      })

      test('a failure is thrown where the statement is, and the driver goes on', () => {
        expect(() => open().unsafe('SELECT * FROM sync_driver_no_such_table')).toThrow()
        expect(Number(inPlace(open().unsafe('SELECT 2 AS two'), 'the next statement')[0].two)).toBe(2)
      })

      test('a transaction commits or rolls back in place, and a savepoint rolls back alone', () => {
        inPlace(open().unsafe(`DROP TABLE IF EXISTS ${table}`), 'drop')
        inPlace(open().unsafe(`CREATE TABLE ${table} (id INT PRIMARY KEY, name VARCHAR(64))`), 'create')

        const kept = inPlace(open().open({ kind: 'begin' }), 'begin')
        inPlace(open().unsafe(`INSERT INTO ${table} (id, name) VALUES (1, 'kept')`, [], undefined, { session: kept }), 'insert')
        // Another connection does not see it until the commit.
        expect(names()).toEqual([])
        const inner = inPlace(open().open({ kind: 'savepoint', parent: kept }), 'savepoint')
        inPlace(open().unsafe(`INSERT INTO ${table} (id, name) VALUES (2, 'inner')`, [], undefined, { session: inner }), 'insert')
        inPlace(open().end(inner, false), 'rollback to savepoint')
        inPlace(open().end(kept, true), 'commit')
        expect(names()).toEqual(['kept'])

        const dropped = inPlace(open().open({ kind: 'begin' }), 'begin')
        inPlace(open().unsafe(`INSERT INTO ${table} (id, name) VALUES (3, 'dropped')`, [], undefined, { session: dropped }), 'insert')
        inPlace(open().end(dropped, false), 'rollback')
        expect(names()).toEqual(['kept'])

        // Ended twice, or after it is over: nothing to do, and nothing thrown.
        inPlace(open().end(dropped, false), 'a second end')
        expect(() => open().unsafe('SELECT 1', [], undefined, { session: dropped })).toThrow(/over/)
      })

      test('a reserved connection is the caller\'s until it is given back', () => {
        const reserved = inPlace(open().open({ kind: 'reserve' }), 'reserve')
        expect(Number(inPlace(open().unsafe('SELECT 4 AS n', [], undefined, { session: reserved }), 'a statement on it')[0].n)).toBe(4)
        inPlace(open().end(reserved, true), 'release')
      })

      test('a statement that outlives its limit is abandoned with an error that says so', () => {
        let thrown: unknown
        try {
          open().unsafe(dialect.sleep(2), [], 150)
        }
        catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(StatementTimeoutError)
        expect(Number(inPlace(open().unsafe('SELECT 5 AS n'), 'the next statement')[0].n)).toBe(5)
      })

      test('while a transaction is held open, only what needs it answers with a promise', async () => {
        inPlace(open().unsafe(`DELETE FROM ${table}`), 'clear')
        inPlace(open().unsafe(`INSERT INTO ${table} (id, name) VALUES (10, 'locked'), (11, 'free')`), 'seed')

        const holder = inPlace(open().open({ kind: 'begin', held: true }), 'begin')
        open().hold(holder)
        try {
          inPlace(open().unsafe(`UPDATE ${table} SET name = 'held' WHERE id = 10`, [], undefined, { session: holder }), 'the holder\'s own write')

          // Nothing the holder has: in place, as if no transaction were open.
          inPlace(open().unsafe(`UPDATE ${table} SET name = 'still free' WHERE id = 11`), 'a write to another row')
          expect(Number(inPlace(open().unsafe('SELECT 6 AS n'), 'a read')[0].n)).toBe(6)

          // The row the holder has: its commit needs this thread, so the rows cannot exist yet.
          const waiting = open().unsafe(`UPDATE ${table} SET name = 'after' WHERE id = 10`)
          expect(isPromise(waiting)).toBe(true)
          let settled = false
          void (waiting as Promise<unknown>).then(() => { settled = true }, () => { settled = true })
          await new Promise(resolve => setTimeout(resolve, 60))
          expect(settled).toBe(false)

          const committed = open().end(holder, true)
          if (isPromise(committed))
            await committed
          await waiting
        }
        finally {
          open().unhold(holder)
        }
        expect(names()).toEqual(['after', 'still free'])
      })

      test('once nothing is held, statements are not watched any more', () => {
        // The row that was contended a moment ago.
        inPlace(open().unsafe(`UPDATE ${table} SET name = 'plain' WHERE id = 10`), 'a write')
        expect(names()).toEqual(['plain', 'still free'])
      })
    })
  }
}
