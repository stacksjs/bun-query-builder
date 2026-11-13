/**
 * The query builder returns its value where it is written.
 *
 * `const rows = db.selectFrom('users').where(...).get()` used to be a pending
 * promise: every terminal was `async`, even on SQLite, where the statement had
 * already run by the time the method returned. `db.transaction(fn)` was a
 * promise too, so the lines after it ran before it had committed unless it was
 * awaited.
 *
 * Now a terminal returns a promise only when something it touched could not
 * answer in place: a connection that answers later, or a callback that does.
 * The awaited form keeps working, because `await` on a value is that value.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createQueryBuilder, resetConnection, setConfig } from '../src'
import { config } from '../src/config'
import { isThenable } from '../src/settle'

let directory: string
let file: string
let db: any
let saved: { dialect: typeof config.dialect, database: typeof config.database, hooks: typeof config.hooks, softDeletes: typeof config.softDeletes }

/** What is on disk, read through a connection of its own. */
function stored(): string[] {
  // Not opened read-only: a WAL database with nothing written yet has no
  // shared-memory file, and a read-only handle is not allowed to create it.
  const reader = new Database(file)
  try {
    return (reader.query('SELECT name FROM sy_items ORDER BY id').all() as { name: string }[]).map(row => row.name)
  }
  finally {
    reader.close()
  }
}

beforeEach(() => {
  saved = { dialect: config.dialect, database: config.database, hooks: config.hooks, softDeletes: config.softDeletes }
  directory = mkdtempSync(join(tmpdir(), 'qb-sync-builder-'))
  file = join(directory, 'builder.sqlite')
  const seed = new Database(file, { create: true })
  seed.run('CREATE TABLE sy_items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER DEFAULT 0)')
  seed.run(`INSERT INTO sy_items (id, name, qty) VALUES (1, 'bolt', 10), (2, 'nut', 25), (3, 'washer', 4)`)
  seed.close()
  // Soft deletes are off here: the table has no deleted_at, and the setting
  // is process-wide, so another file's value would otherwise decide.
  setConfig({ dialect: 'sqlite', database: { database: file }, hooks: {}, softDeletes: { enabled: false } } as any)
  resetConnection()
  db = createQueryBuilder()
})

afterEach(() => {
  resetConnection()
  setConfig({ dialect: saved.dialect, database: saved.database, hooks: saved.hooks, softDeletes: saved.softDeletes } as any)
  rmSync(directory, { recursive: true, force: true })
})

describe('reads answer in place', () => {
  it('the un-awaited chain is the rows, the same rows the awaited chain gives', async () => {
    const bare = db.selectFrom('sy_items').where('qty', '>', 5).orderBy('qty', 'desc').get()
    expect(isThenable(bare)).toBe(false)
    expect(bare.map((row: any) => row.name)).toEqual(['nut', 'bolt'])
    expect(await db.selectFrom('sy_items').where('qty', '>', 5).orderBy('qty', 'desc').get()).toEqual(bare)
  })

  it('every terminal returns a value, not a promise', () => {
    const items = () => db.selectFrom('sy_items')
    const terminals: Record<string, unknown> = {
      get: items().get(),
      execute: items().execute(),
      first: items().orderBy('id').first(),
      executeTakeFirst: items().executeTakeFirst(),
      firstOrFail: items().firstOrFail(),
      find: items().find(2),
      findMany: items().findMany([1, 3]),
      count: items().count(),
      sum: items().sum('qty'),
      avg: items().avg('qty'),
      min: items().min('qty'),
      max: items().max('qty'),
      exists: items().where({ name: 'nut' }).exists(),
      doesntExist: items().where({ name: 'screw' }).doesntExist(),
      value: items().where({ id: 1 }).value('name'),
      pluck: items().orderBy('id').pluck('name'),
      paginate: items().orderBy('id').paginate(2, 1),
      simplePaginate: items().orderBy('id').simplePaginate(2, 1),
      cursorPaginate: items().cursorPaginate(2),
      explain: items().explain(),
    }
    for (const [name, value] of Object.entries(terminals))
      expect(isThenable(value), `${name}() returned a promise`).toBe(false)

    expect(terminals.count).toBe(3)
    expect(terminals.sum).toBe(39)
    expect(terminals.first).toMatchObject({ name: 'bolt' })
    expect(terminals.pluck).toEqual(['bolt', 'nut', 'washer'])
    expect((terminals.paginate as any).meta).toMatchObject({ total: 3, lastPage: 2 })
    expect(terminals.exists).toBe(true)
    expect(terminals.doesntExist).toBe(true)
  })

  it('a value can be used on the next line, mid-expression and in a condition', () => {
    const name = db.selectFrom('sy_items').where({ id: 2 }).first().name
    expect(name).toBe('nut')
    expect(db.selectFrom('sy_items').get().length + 1).toBe(4)
    if (!db.selectFrom('sy_items').where({ name: 'screw' }).first())
      expect(true).toBe(true)
    else
      throw new Error('a missing row has to be falsy where the call stands')
  })

  it('a failure is thrown where the call stands', () => {
    expect(() => db.selectFrom('sy_no_such_table').get()).toThrow(/sy_no_such_table/)
    expect(() => db.selectFrom('sy_items').where({ id: 99 }).firstOrFail()).toThrow()
  })

  it('chunk waits only for a handler that asks it to', async () => {
    const sizes: number[] = []
    const inPlace = db.selectFrom('sy_items').orderBy('id').chunk(2, (rows: unknown[]) => { sizes.push(rows.length) })
    expect(isThenable(inPlace)).toBe(false)
    expect(sizes).toEqual([2, 1])

    const waited = db.selectFrom('sy_items').orderBy('id').chunk(2, async (rows: unknown[]) => {
      await Bun.sleep(1)
      sizes.push(rows.length)
    })
    expect(isThenable(waited)).toBe(true)
    await waited
    expect(sizes).toEqual([2, 1, 2, 1])
  })
})

describe('a raw statement runs when it is executed', () => {
  it('unsafe() builds a statement, and execute() is its rows', async () => {
    const statement = db.unsafe('SELECT name FROM sy_items WHERE qty > ? ORDER BY id', [5])
    const rows = statement.execute()
    expect(isThenable(rows)).toBe(false)
    expect(rows).toEqual([{ name: 'bolt' }, { name: 'nut' }])
    // Awaiting the statement is the same rows.
    expect(await db.unsafe('SELECT name FROM sy_items WHERE qty > ? ORDER BY id', [5])).toEqual(rows)
  })

  it('nothing runs until it is asked for', () => {
    db.unsafe('DELETE FROM sy_items')
    expect(stored()).toEqual(['bolt', 'nut', 'washer'])
    db.unsafe('DELETE FROM sy_items WHERE id = ?', [3]).execute()
    expect(stored()).toEqual(['bolt', 'nut'])
  })
})

describe('writes answer in place', () => {
  it('insert, update and delete are done when they return', () => {
    expect(isThenable(db.insertInto('sy_items').values({ id: 4, name: 'screw', qty: 1 }).execute())).toBe(false)
    expect(stored()).toEqual(['bolt', 'nut', 'washer', 'screw'])

    const updated = db.updateTable('sy_items').set({ name: 'screw M4' }).where({ id: 4 }).execute()
    expect(updated).toBe(1)
    expect(stored()).toEqual(['bolt', 'nut', 'washer', 'screw M4'])

    const deleted = db.deleteFrom('sy_items').where({ id: 4 }).execute()
    expect(deleted).toBe(1)
    expect(stored()).toEqual(['bolt', 'nut', 'washer'])
  })

  it('the table helpers are values too', () => {
    const created = db.create('sy_items', { id: 5, name: 'rivet', qty: 2 })
    expect(isThenable(created)).toBe(false)
    expect(created).toMatchObject({ id: 5, name: 'rivet' })
    expect(db.count('sy_items')).toBe(4)
    expect(db.find('sy_items', 5)).toMatchObject({ name: 'rivet' })
    expect(db.insertGetId('sy_items', { name: 'pin' })).toBe(6)
    expect(db.updateOrInsert('sy_items', { id: 6 }, { name: 'pin 2mm' })).toBe(true)
    expect(db.remove('sy_items', 5)).toBeDefined()
    expect(stored()).toEqual(['bolt', 'nut', 'washer', 'pin 2mm'])
  })

  it('returning() rows come back in place', () => {
    const row = db.insertInto('sy_items').values({ id: 7, name: 'clip' }).returning('id', 'name').first()
    expect(isThenable(row)).toBe(false)
    expect(row).toEqual({ id: 7, name: 'clip' })
  })
})

describe('a transaction is done when it returns', () => {
  it('commits what a callback wrote, and returns what it returned', () => {
    const result = db.transaction((tx: any) => {
      tx.insertInto('sy_items').values({ id: 10, name: 'in-tx' }).execute()
      // Not on disk yet: another connection cannot see it.
      expect(stored()).toEqual(['bolt', 'nut', 'washer'])
      return tx.selectFrom('sy_items').count()
    })
    expect(isThenable(result)).toBe(false)
    expect(result).toBe(4)
    expect(stored()).toEqual(['bolt', 'nut', 'washer', 'in-tx'])
  })

  it('rolls back and rethrows when the callback throws', () => {
    expect(() => db.transaction((tx: any) => {
      tx.deleteFrom('sy_items').where({ id: 1 }).execute()
      expect(tx.selectFrom('sy_items').count()).toBe(2)
      throw new Error('changed my mind')
    })).toThrow('changed my mind')
    expect(stored()).toEqual(['bolt', 'nut', 'washer'])
  })

  it('a nested transaction is a savepoint that rolls back alone', () => {
    db.transaction((tx: any) => {
      tx.insertInto('sy_items').values({ id: 11, name: 'outer' }).execute()
      expect(() => tx.transaction((inner: any) => {
        inner.insertInto('sy_items').values({ id: 12, name: 'inner' }).execute()
        throw new Error('inner only')
      })).toThrow('inner only')
      tx.savepoint((sp: any) => { sp.updateTable('sy_items').set({ qty: 9 }).where({ id: 11 }).execute() })
    })
    expect(stored()).toEqual(['bolt', 'nut', 'washer', 'outer'])
    expect(db.selectFrom('sy_items').where({ id: 11 }).value('qty')).toBe(9)
  })

  it('runs its callbacks in place, in order', () => {
    const order: string[] = []
    db.transaction((tx: any) => {
      order.push('body')
      tx.insertInto('sy_items').values({ id: 13, name: 'hooked' }).execute()
    }, { afterCommit: () => { order.push('afterCommit') } })
    order.push('next line')
    expect(order).toEqual(['body', 'afterCommit', 'next line'])
  })

  it('a retried transaction is still done when it returns', () => {
    let attempts = 0
    const result = db.transaction((tx: any) => {
      attempts++
      tx.insertInto('sy_items').values({ id: 20 + attempts, name: `attempt ${attempts}` }).execute()
      if (attempts === 1)
        throw new Error('database is locked: first attempt')
      return 'second time'
    }, { retries: 1, backoff: { baseMs: 1, maxMs: 1 } })
    // A retry that waited out its backoff on the event loop would have made
    // this a promise on the one run that needed it.
    expect(isThenable(result)).toBe(false)
    expect(result).toBe('second time')
    expect(stored()).toEqual(['bolt', 'nut', 'washer', 'attempt 2'])
  })

  it('a callback that has to wait makes the transaction a promise, which commits when it resolves', async () => {
    const pending = db.transaction(async (tx: any) => {
      await Bun.sleep(2)
      await tx.insertInto('sy_items').values({ id: 30, name: 'waited' }).execute()
      return 'waited'
    })
    expect(isThenable(pending)).toBe(true)
    expect(stored()).toEqual(['bolt', 'nut', 'washer'])
    expect(await pending).toBe('waited')
    expect(stored()).toEqual(['bolt', 'nut', 'washer', 'waited'])
  })

  it('an async callback that throws rejects and rolls back', async () => {
    const pending = db.transaction(async (tx: any) => {
      await tx.deleteFrom('sy_items').execute()
      throw new Error('async and wrong')
    })
    await expect(pending).rejects.toThrow('async and wrong')
    expect(stored()).toEqual(['bolt', 'nut', 'washer'])
  })

  it('transactional() wraps a function the same way', () => {
    const add = db.transactional((tx: any, name: string) => {
      tx.insertInto('sy_items').values({ name }).execute()
      return tx.selectFrom('sy_items').count()
    })
    expect(add('wrapped')).toBe(4)
    expect(stored()).toEqual(['bolt', 'nut', 'washer', 'wrapped'])
  })
})

describe('a connection that answers later still gets promises', () => {
  it('a supplied connection with no synchronous path is awaited', async () => {
    const rows = [{ id: 1, name: 'later' }]
    const query = { execute: () => Promise.resolve(rows), toString: () => 'SELECT * FROM sy_items' }
    const connection = Object.assign(() => query, { unsafe: () => query })
    const pending = (createQueryBuilder({ sql: connection as any }) as any).selectFrom('sy_items').get()
    expect(isThenable(pending)).toBe(true)
    expect(await pending).toEqual(rows)
  })
})

describe('query hooks see a statement that answered in place', () => {
  it('start and end fire before the call returns', () => {
    const seen: string[] = []
    setConfig({ hooks: { onQueryStart: () => { seen.push('start') }, onQueryEnd: () => { seen.push('end') } } } as any)
    db.selectFrom('sy_items').get()
    seen.push('next line')
    expect(seen).toEqual(['start', 'end', 'next line'])
  })
})
