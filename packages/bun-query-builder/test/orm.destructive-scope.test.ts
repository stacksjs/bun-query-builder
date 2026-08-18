/**
 * The ORM's destructive statements must be scoped the way its reads are.
 * stacksjs/bun-query-builder#1111.
 *
 * `delete()`, `update()` and `increment()` built their WHERE with
 * `buildWhereClauses()`, guarded by `this._wheres.length > 0`. Every read path
 * uses `composeWhere()` — and `composeWhere` is the only place the soft-delete
 * predicate is added.
 *
 * So a scope expressed purely as that predicate contributed nothing to a
 * write, and when it was the ONLY scope the statement went out with no WHERE
 * at all:
 *
 *     Post.query().onlyTrashed().delete()   ->  DELETE FROM posts    (every row)
 *
 * "Purge the trash" was the exact call that destroyed the live rows.
 *
 * These assert row counts rather than emitted SQL. The defect was the gap
 * between two WHERE builders, so only the resulting table settles it.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel, createTableFromModel } from '../src'

let db: Database
let Post: any

beforeEach(async () => {
  clearModelRegistry()
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })

  Post = createModel({
    name: 'Sdpost',
    table: 'sd_posts',
    primaryKey: 'id',
    autoIncrement: true,
    traits: { useSoftDeletes: true },
    attributes: {
      title: { type: 'string', fillable: true },
      views: { type: 'integer', fillable: true },
    },
  } as any)

  await createTableFromModel(Post.getDefinition())
  for (const title of ['a', 'b', 'c', 'd'])
    await Post.create({ title, views: 0 })
  // 'a' and 'b' are trashed; 'c' and 'd' are live.
  db.run(`UPDATE sd_posts SET deleted_at = '2026-01-01' WHERE title IN ('a','b')`)
})

afterEach(() => {
  clearModelRegistry()
})

const total = (): number => (db.query('SELECT count(*) c FROM sd_posts').get() as any).c
const alive = (): number => (db.query('SELECT count(*) c FROM sd_posts WHERE deleted_at IS NULL').get() as any).c
const titles = (): string[] => (db.query('SELECT title FROM sd_posts ORDER BY title').all() as any[]).map(r => r.title)

describe('delete() honours the soft-delete scope (#1111)', () => {
  it('onlyTrashed().delete() removes the trashed rows and spares the live ones', async () => {
    expect([total(), alive()]).toEqual([4, 2])

    await Post.query().onlyTrashed().delete()

    // Previously: total 0 — the live rows went too.
    expect(total()).toBe(2)
    expect(alive()).toBe(2)
    expect(titles()).toEqual(['c', 'd'])
  })

  it('an unscoped delete still excludes trashed rows, as reads do', async () => {
    await Post.query().delete()

    // The default scope hides trashed rows, so a hard delete must not reach
    // them either — otherwise the same query means two different row sets
    // depending on whether it reads or writes.
    expect(titles()).toEqual(['a', 'b'])
  })

  it('a user filter still applies alongside the scope', async () => {
    await Post.query().where('title', 'c').delete()

    expect(titles()).toEqual(['a', 'b', 'd'])
  })
})

describe('update() and increment() honour the scope (#1111)', () => {
  it('onlyTrashed().update() rewrites only the trashed rows', async () => {
    await Post.query().onlyTrashed().update({ title: 'PURGED' })

    const purged = (db.query(`SELECT count(*) c FROM sd_posts WHERE title='PURGED'`).get() as any).c
    expect(purged).toBe(2)
    expect(total()).toBe(4)
  })

  it('onlyTrashed().increment() bumps only the trashed rows', async () => {
    await Post.query().onlyTrashed().increment('views', 5)

    const bumped = (db.query('SELECT count(*) c FROM sd_posts WHERE views = 5').get() as any).c
    expect(bumped).toBe(2)
  })

  it('an unscoped update leaves trashed rows alone', async () => {
    await Post.query().update({ views: 9 })

    const bumped = (db.query('SELECT count(*) c FROM sd_posts WHERE views = 9').get() as any).c
    expect(bumped).toBe(2)
  })
})

describe('clauses a write cannot emit are refused (#1111)', () => {
  // Silently ignoring limit() is what turned `limit(1).delete()` into a delete
  // of every matching row. LIMIT on UPDATE/DELETE is not portable — Postgres
  // has no such form — so being loud is the honest option.
  it('limit() on a delete throws instead of being dropped', async () => {
    await expect(Post.query().limit(1).delete()).rejects.toThrow(/cannot apply limit/)
    expect(total()).toBe(4)
  })

  it('orderBy() on a delete throws instead of being dropped', async () => {
    await expect(Post.query().orderBy('id').delete()).rejects.toThrow(/cannot apply .*orderBy/)
    expect(total()).toBe(4)
  })

  it('limit() on an update throws instead of being dropped', async () => {
    await expect(Post.query().limit(1).update({ views: 3 })).rejects.toThrow(/cannot apply limit/)
    const bumped = (db.query('SELECT count(*) c FROM sd_posts WHERE views = 3').get() as any).c
    expect(bumped).toBe(0)
  })

  it('a write with no ordering or limit is unaffected', async () => {
    await expect(Post.query().where('title', 'c').update({ views: 7 })).resolves.toBeDefined()
    const bumped = (db.query('SELECT count(*) c FROM sd_posts WHERE views = 7').get() as any).c
    expect(bumped).toBe(1)
  })
})

describe('a model without soft deletes is unchanged (#1111)', () => {
  it('deletes exactly what the filter selects', async () => {
    clearModelRegistry()
    const plain = new Database(':memory:', { create: true })
    configureOrm({ database: plain })

    const Item = createModel({
      name: 'Plainitem',
      table: 'plain_items',
      primaryKey: 'id',
      autoIncrement: true,
      attributes: { name: { type: 'string', fillable: true } },
    } as any)
    await createTableFromModel((Item as any).getDefinition())
    for (const name of ['x', 'y', 'z'])
      await (Item as any).create({ name })

    await (Item as any).query().where('name', 'y').delete()

    const left = (plain.query('SELECT name FROM plain_items ORDER BY name').all() as any[]).map(r => r.name)
    expect(left).toEqual(['x', 'z'])
  })
})
