/**
 * A model call returns its value where it is written.
 *
 * `const user = User.where(...).first()` used to be a pending promise: every
 * model method was `async`, even on SQLite, where the query had already run
 * by the time the method returned. So `user.email` was undefined unless the
 * line said `await`.
 *
 * Now a method returns a promise only when something it touched could not
 * answer in place: an `async` hook, or an `async` callback handed to it. The
 * awaited form keeps working, because `await` on a value is that value.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel, releaseOrm } from '../src'
import { isThenable } from '../src/settle'

let db: Database
let User: any
let Audited: any
let Slow: any
const log: string[] = []

beforeEach(() => {
  clearModelRegistry()
  log.length = 0
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })
  db.run('CREATE TABLE sy_users (id INTEGER PRIMARY KEY, email TEXT, name TEXT, created_at TEXT, updated_at TEXT)')
  db.run('CREATE TABLE sy_posts (id INTEGER PRIMARY KEY, sy_user_id INTEGER, title TEXT)')
  db.run(`INSERT INTO sy_users (id, email, name, created_at) VALUES
    (1, 'ada@example.com', 'Ada', '2026-01-01 00:00:00'),
    (2, 'grace@example.com', 'Grace', '2026-02-01 00:00:00'),
    (3, 'linus@elsewhere.org', 'Linus', '2026-03-01 00:00:00')`)
  db.run(`INSERT INTO sy_posts (id, sy_user_id, title) VALUES (1, 2, 'first'), (2, 2, 'second')`)

  const attributes = { email: { type: 'string', fillable: true }, name: { type: 'string', fillable: true } }
  User = createModel({ name: 'SyUser', table: 'sy_users', primaryKey: 'id', attributes, hasMany: ['SyPost'] } as any)
  createModel({ name: 'SyPost', table: 'sy_posts', primaryKey: 'id', traits: { useTimestamps: false }, attributes: { sy_user_id: { type: 'integer', fillable: true }, title: { type: 'string', fillable: true } }, belongsTo: ['SyUser'] } as any)
  // Hooks that return nothing: the write still answers in place.
  Audited = createModel({
    name: 'SyAudited',
    table: 'sy_users',
    primaryKey: 'id',
    attributes,
    hooks: {
      beforeCreate: () => { log.push('beforeCreate') },
      afterCreate: () => { log.push('afterCreate') },
      beforeDelete: () => { log.push('beforeDelete') },
    },
  } as any)
  // One async hook: every write on this model waits for it.
  Slow = createModel({
    name: 'SySlow',
    table: 'sy_users',
    primaryKey: 'id',
    attributes,
    hooks: {
      afterCreate: async () => {
        await Bun.sleep(1)
        log.push('afterCreate (async)')
      },
    },
  } as any)
})

afterEach(() => {
  releaseOrm()
  db.close()
})

describe('reads answer in place', () => {
  it('the un-awaited chain is the row, the same row the awaited chain gives', async () => {
    const awaited = await User
      .where('email', 'like', '%@example.com')
      .orderByDesc('created_at')
      .first()
    const bare = User
      .where('email', 'like', '%@example.com')
      .orderByDesc('created_at')
      .first()

    expect(isThenable(bare)).toBe(false)
    expect(bare.get('email')).toBe('grace@example.com')
    expect(bare.get('email')).toBe(awaited.get('email'))
    expect(bare.toJSON()).toEqual(awaited.toJSON())
  })

  it('every terminal returns a value, not a promise', () => {
    const results = {
      find: User.find(1),
      findMany: User.findMany([1, 2]),
      all: User.all(),
      first: User.first(),
      last: User.last(),
      get: User.where('id', '>', 1).get(),
      count: User.count(),
      exists: User.where('id', 1).exists(),
      doesntExist: User.where('id', 99).doesntExist(),
      pluck: User.orderBy('id').pluck('name'),
      max: User.max('id'),
      sum: User.sum('id'),
      paginate: User.paginate(1, 2),
      simplePaginate: User.simplePaginate(2),
      cursorPaginate: User.cursorPaginate(2),
      missing: User.find(99),
    }
    for (const [name, value] of Object.entries(results))
      expect(isThenable(value), `${name} returned a promise`).toBe(false)

    expect(results.find.get('name')).toBe('Ada')
    expect(results.findMany.length).toBe(2)
    expect(results.all.length).toBe(3)
    expect(results.count).toBe(3)
    expect(results.exists).toBe(true)
    expect(results.doesntExist).toBe(true)
    expect(results.pluck).toEqual(['Ada', 'Grace', 'Linus'])
    expect(results.max).toBe(3)
    expect(results.sum).toBe(6)
    expect(results.paginate.data.length).toBe(2)
    expect(results.simplePaginate.data.length).toBe(2)
    expect(results.cursorPaginate.data.length).toBe(2)
    // A missing row is falsy, which a promise of one never was.
    expect(results.missing).toBeUndefined()
  })

  it('a value can be used on the next line, mid-expression and in a condition', () => {
    const names = User.all().map((user: any) => user.get('name'))
    expect(names).toEqual(['Ada', 'Grace', 'Linus'])
    expect(User.find(2).get('email').split('@')[1]).toBe('example.com')
    expect(User.where('email', 'like', '%@nowhere').exists() ? 'some' : 'none').toBe('none')
    expect(User.count() + 1).toBe(4)
  })

  it('eager loading answers in place too', () => {
    const grace = User.with('SyPost').find(2)
    expect(isThenable(grace)).toBe(false)
    const posts = grace.getRelation('SyPost')
    expect(posts.map((post: any) => post.get('title'))).toEqual(['first', 'second'])
  })

  it('a failure is thrown where the call stands', () => {
    expect(() => User.findOrFail(99)).toThrow('SyUser with id 99 not found')
    expect(() => User.where('id', 99).firstOrFail()).toThrow()
    let caught = 'nothing'
    try {
      User.findOrFail(99)
    }
    catch (error) {
      caught = (error as Error).message
    }
    expect(caught).toContain('not found')
  })

  it('await still works on every one of them', async () => {
    expect((await User.find(1)).get('name')).toBe('Ada')
    expect(await User.count()).toBe(3)
    expect((await User.where('id', '>', 1).get()).length).toBe(2)
    await expect(Promise.all([User.count(), User.find(2)])).resolves.toHaveLength(2)
    let message = ''
    try {
      await User.findOrFail(99)
    }
    catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('not found')
  })
})

describe('writes answer in place unless a hook cannot', () => {
  it('create, update, save and delete return values on a model without hooks', () => {
    const created = User.create({ email: 'new@example.com', name: 'New' })
    expect(isThenable(created)).toBe(false)
    expect(created.id).toBeGreaterThan(3)
    expect(User.count()).toBe(4)

    const updated = created.update({ name: 'Renamed' })
    expect(updated).toBe(created)
    expect(User.find(created.id).get('name')).toBe('Renamed')

    created.set('name', 'Saved')
    expect(created.save()).toBe(created)
    expect(User.find(created.id).get('name')).toBe('Saved')

    expect(User.where('id', created.id).update({ name: 'Bulk' })).toBe(1)
    expect(created.delete()).toBe(true)
    expect(User.count()).toBe(3)

    const many = User.createMany([{ email: 'a@x.io', name: 'A' }, { email: 'b@x.io', name: 'B' }])
    expect(many.map((row: any) => row.get('name'))).toEqual(['A', 'B'])
    expect(User.where('email', 'like', '%@x.io').delete()).toBe(2)
    expect(User.firstOrCreate({ email: 'ada@example.com' }, { name: 'Other' }).get('name')).toBe('Ada')
    expect(User.updateOrCreate({ email: 'ada@example.com' }, { name: 'Ada L.' }).get('name')).toBe('Ada L.')
    expect(User.delete(1)).toBe(true)
    expect(User.delete(99)).toBe(false)
  })

  it('hooks that return nothing leave the write in place, and still run in order', () => {
    const created = Audited.create({ email: 'hooked@example.com', name: 'Hooked' })
    expect(isThenable(created)).toBe(false)
    expect(created.get('name')).toBe('Hooked')
    expect(log).toEqual(['beforeCreate', 'afterCreate'])
    expect(created.delete()).toBe(true)
    expect(log).toEqual(['beforeCreate', 'afterCreate', 'beforeDelete'])
  })

  it('an async hook makes the write a promise, which resolves once the hook has finished', async () => {
    const pending = Slow.create({ email: 'slow@example.com', name: 'Slow' })
    expect(isThenable(pending)).toBe(true)
    // The row is written before the hook is waited on.
    expect(User.where('email', 'slow@example.com').exists()).toBe(true)
    expect(log).toEqual([])
    const created = await pending
    expect(created.get('name')).toBe('Slow')
    expect(log).toEqual(['afterCreate (async)'])
    // Reads on the same model never run a hook, so they stay in place.
    expect(isThenable(Slow.find(created.id))).toBe(false)
  })

  it('chunk waits only for a callback that asks it to', async () => {
    const seen: number[] = []
    const inPlace = User.query().orderBy('id').chunk(2, (rows: any[]) => {
      seen.push(rows.length)
    })
    expect(isThenable(inPlace)).toBe(false)
    expect(seen).toEqual([2, 1])

    seen.length = 0
    const waited = User.query().orderBy('id').chunk(2, async (rows: any[]) => {
      await Bun.sleep(1)
      seen.push(rows.length)
    })
    expect(isThenable(waited)).toBe(true)
    await waited
    expect(seen).toEqual([2, 1])
  })
})
