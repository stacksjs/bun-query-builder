/**
 * `Model.query()…delete()` deletes the way `instance.delete()` does, and
 * `forceDelete()` purges.
 *
 * A query delete was a bare `DELETE` on every model and ran no hooks. So on a
 * soft-deletable model `Post.where(...).delete()` permanently removed live rows
 * that `Post.delete(id)` would have marked, and neither `beforeDelete` nor
 * `afterDelete` saw any of them.
 *
 * Now a soft-deletable model has the rows marked, hooks run per row, and
 * `forceDelete()` is the permanent one. `onlyTrashed().delete()` still purges
 * the trash (#1111).
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel } from '../src'

let db: Database
const log: string[] = []

function model(name: string, table: string, opts: { soft: boolean, hooks: boolean }): any {
  return createModel({
    name,
    table,
    primaryKey: 'id',
    traits: { useSoftDeletes: opts.soft, useTimestamps: false },
    attributes: { title: { type: 'string', fillable: true } },
    ...(opts.hooks
      ? {
          hooks: {
            beforeDelete: (m: any) => { log.push(`before:${m.get('title')}`) },
            afterDelete: (m: any) => { log.push(`after:${m.get('title')}${m.trashed?.() ? ' (trashed)' : ''}`) },
          },
        }
      : {}),
  } as any)
}

let Post: any // soft deletes, hooks
let Tag: any // no soft deletes, hooks
let Note: any // soft deletes, no hooks
let Log: any // neither

beforeEach(() => {
  clearModelRegistry()
  log.length = 0
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })
  for (const t of ['qd_posts', 'qd_notes'])
    db.run(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, title TEXT, deleted_at TEXT)`)
  for (const t of ['qd_tags', 'qd_logs'])
    db.run(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, title TEXT)`)
  // 'a' is already trashed on the soft-deletable tables; 'b', 'c', 'd' are live.
  for (const t of ['qd_posts', 'qd_notes'])
    db.run(`INSERT INTO ${t} VALUES (1, 'a', '2020-01-01'), (2, 'b', NULL), (3, 'c', NULL), (4, 'd', NULL)`)
  for (const t of ['qd_tags', 'qd_logs'])
    db.run(`INSERT INTO ${t} VALUES (1, 'a'), (2, 'b'), (3, 'c'), (4, 'd')`)

  Post = model('QdPost', 'qd_posts', { soft: true, hooks: true })
  Tag = model('QdTag', 'qd_tags', { soft: false, hooks: true })
  Note = model('QdNote', 'qd_notes', { soft: true, hooks: false })
  Log = model('QdLog', 'qd_logs', { soft: false, hooks: false })
})

afterEach(() => {
  clearModelRegistry()
  db.close()
})

/** Each row as `title` or `title*` when marked, and whether 'a' kept its original date. */
function state(table: string): string[] {
  return (db.query(`SELECT * FROM ${table} ORDER BY id`).all() as any[])
    .map(r => r.deleted_at == null ? r.title : r.deleted_at === '2020-01-01' ? `${r.title}*2020` : `${r.title}*`)
}

describe('delete() on a soft-deletable model', () => {
  it('marks the matching rows instead of removing them', async () => {
    // Was a DELETE: 'b' and 'c' were gone for good.
    expect(await Post.where('id', '<', 4).delete()).toBe(2)
    expect(state('qd_posts')).toEqual(['a*2020', 'b*', 'c*', 'd'])
  })

  it('runs the delete hooks for each row, and afterDelete sees it trashed', async () => {
    await Post.where('title', 'in', ['b', 'c']).delete()
    expect(log).toEqual(['before:b', 'before:c', 'after:b (trashed)', 'after:c (trashed)'])
  })

  it('marks every live row when unscoped, and leaves the trash alone', async () => {
    expect(await Post.query().delete()).toBe(3)
    expect(state('qd_posts')).toEqual(['a*2020', 'b*', 'c*', 'd*'])
    expect(log.filter(l => l.startsWith('before'))).toEqual(['before:b', 'before:c', 'before:d'])
  })

  it('withTrashed() does not re-stamp rows that are already marked', async () => {
    expect(await Post.withTrashed().where('id', '<', 3).delete()).toBe(1)
    expect(state('qd_posts')).toEqual(['a*2020', 'b*', 'c', 'd'])
    expect(log).toEqual(['before:b', 'after:b (trashed)'])
  })

  it('onlyTrashed().delete() still purges the trash (#1111)', async () => {
    expect(await Post.onlyTrashed().delete()).toBe(1)
    expect(state('qd_posts')).toEqual(['b', 'c', 'd'])
    expect(log).toEqual(['before:a', 'after:a (trashed)'])
  })

  it('marks without hooks on a model that has none', async () => {
    expect(await Note.where('id', '<', 4).delete()).toBe(2)
    expect(state('qd_notes')).toEqual(['a*2020', 'b*', 'c*', 'd'])
  })
})

describe('forceDelete() on a query', () => {
  it('removes live matches for good on a soft-deletable model', async () => {
    expect(await Post.where('id', '<', 4).forceDelete()).toBe(2)
    // The default scope still hides 'a', so it is not reached.
    expect(state('qd_posts')).toEqual(['a*2020', 'd'])
    expect(log).toEqual(['before:b', 'before:c', 'after:b', 'after:c'])
  })

  it('reaches trashed rows under withTrashed()', async () => {
    expect(await Post.withTrashed().where('id', '<', 3).forceDelete()).toBe(2)
    expect(state('qd_posts')).toEqual(['c', 'd'])
  })

  it('removes rows on a model without soft deletes, as delete() does', async () => {
    expect(await Tag.where('id', '>', 2).forceDelete()).toBe(2)
    expect(await Tag.where('id', '=', 1).delete()).toBe(1)
    expect(state('qd_tags')).toEqual(['b'])
    expect(log).toEqual(['before:c', 'before:d', 'after:c', 'after:d', 'before:a', 'after:a'])
  })

  it('works without hooks', async () => {
    expect(await Note.query().forceDelete()).toBe(3)
    expect(await Log.query().forceDelete()).toBe(4)
    expect(state('qd_notes')).toEqual(['a*2020'])
    expect(state('qd_logs')).toEqual([])
  })

  it('refuses limit() and orderBy() like delete() does (#1111)', async () => {
    await expect(Post.query().orderBy('id').limit(1).forceDelete()).rejects.toThrow('forceDelete() cannot apply')
    expect(state('qd_posts')).toEqual(['a*2020', 'b', 'c', 'd'])
  })
})

describe('query deletes with hooks', () => {
  it('a throwing beforeDelete stops the whole delete', async () => {
    clearModelRegistry()
    const Guarded = createModel({
      name: 'QdGuarded',
      table: 'qd_tags',
      primaryKey: 'id',
      attributes: { title: { type: 'string', fillable: true } },
      hooks: { beforeDelete: (m: any) => { if (m.get('title') === 'c') throw new Error('c is protected') } },
    } as any) as any

    await expect(Guarded.query().delete()).rejects.toThrow('c is protected')
    // Every beforeDelete runs before anything is written.
    expect(state('qd_tags')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a query matching nothing runs no hooks', async () => {
    expect(await Post.where('title', 'zzz').delete()).toBe(0)
    expect(await Tag.where('title', 'zzz').forceDelete()).toBe(0)
    expect(log).toEqual([])
  })

  it('deletes a row whose primary key is 0', async () => {
    db.run(`INSERT INTO qd_tags VALUES (0, 'zero')`)
    expect(await Tag.where('title', 'zero').delete()).toBe(1)
    expect(state('qd_tags')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('deletes more rows than fit in one statement', async () => {
    const insert = db.prepare('INSERT INTO qd_tags (id, title) VALUES (?, ?)')
    db.transaction(() => { for (let i = 100; i < 1300; i++) insert.run(i, `t${i}`) })()
    expect(await Tag.where('id', '>=', 100).delete()).toBe(1200)
    expect(state('qd_tags')).toEqual(['a', 'b', 'c', 'd'])
    expect(log.length).toBe(2400)
  })
})
