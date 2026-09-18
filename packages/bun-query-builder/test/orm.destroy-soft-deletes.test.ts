/**
 * `Model.destroy(id)` honours soft deletes and hooks; `forceDelete(id)` is the
 * permanent one.
 *
 * `destroy` issued a bare `DELETE FROM … WHERE id = ?` on every model. So on a
 * soft-deletable model it removed the row that `instance.delete()` — and
 * `Model.delete(id)` — would have marked, and no `beforeDelete`/`afterDelete`
 * hook ever saw it. Two spellings of "delete this row by id", opposite results,
 * and the destructive one was the one that looked emphatic.
 *
 * `destroy` now goes through `instance.delete()`. `forceDelete` is the way to
 * purge one row, and `remove` is an alias of it — the meaning `db.remove(table,
 * id)` already has in docs/delete.md.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel, createTableFromModel } from '../src'

let db: Database
let Post: any
let Tag: any
const hooks: string[] = []

beforeEach(async () => {
  clearModelRegistry()
  hooks.length = 0
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })

  Post = createModel({
    name: 'DsPost',
    table: 'ds_posts',
    primaryKey: 'id',
    autoIncrement: true,
    traits: { useSoftDeletes: true },
    attributes: { title: { type: 'string', fillable: true } },
    hooks: {
      beforeDelete: (post: any) => { hooks.push(`before:${post.get('title')}`) },
      afterDelete: (post: any) => { hooks.push(`after:${post.get('title')}`) },
    },
  } as any)
  Tag = createModel({
    name: 'DsTag',
    table: 'ds_tags',
    primaryKey: 'id',
    autoIncrement: true,
    attributes: { label: { type: 'string', fillable: true } },
    hooks: {
      beforeDelete: (tag: any) => { hooks.push(`before:${tag.get('label')}`) },
      afterDelete: (tag: any) => { hooks.push(`after:${tag.get('label')}`) },
    },
  } as any)

  await createTableFromModel(Post.getDefinition())
  await createTableFromModel(Tag.getDefinition())
  await Post.create({ title: 'A' })
  await Post.create({ title: 'B' })
  await Tag.create({ label: 'x' })
})

afterEach(() => {
  clearModelRegistry()
  db.close()
})

const ids = (table: string): number[] =>
  (db.query(`SELECT id FROM ${table} ORDER BY id`).all() as { id: number }[]).map(r => r.id)
const rows = (table: string): any[] => db.query(`SELECT id, deleted_at FROM ${table} ORDER BY id`).all() as any[]
const live = (table: string): number[] => rows(table).filter(r => r.deleted_at == null).map(r => r.id)

describe('Model.destroy(id) on a soft-deletable model (#1150 follow-up)', () => {
  it('marks the row instead of removing it', async () => {
    // Was a bare DELETE: the row was gone and could not be restored.
    expect(await Post.destroy(1)).toBe(true)
    expect(rows('ds_posts').length).toBe(2)
    expect(live('ds_posts')).toEqual([2])

    const trashed = await Post.onlyTrashed().first()
    expect(trashed.get('title')).toBe('A')
    await trashed.restore()
    expect(live('ds_posts')).toEqual([1, 2])
  })

  it('runs the delete hooks', async () => {
    await Post.destroy(1)
    expect(hooks).toEqual(['before:A', 'after:A'])
  })

  it('is false for a missing row, and for one already trashed', async () => {
    expect(await Post.destroy(99)).toBe(false)
    await Post.destroy(1)
    hooks.length = 0
    expect(await Post.destroy(1)).toBe(false)
    expect(hooks).toEqual([])
  })

  it('still removes the row on a model without soft deletes, and now runs its hooks', async () => {
    // The bare DELETE ran no hooks on any model; that half is new for plain ones.
    expect(await Tag.destroy(1)).toBe(true)
    expect(ids('ds_tags')).toEqual([])
    expect(hooks).toEqual(['before:x', 'after:x'])
  })

  it('deletes a row whose primary key is 0', async () => {
    // The instance guard read a falsy key as "no primary key" and threw, so a
    // row with id 0 survived a destroy that reported nothing wrong.
    db.run(`INSERT INTO ds_tags (id, label) VALUES (0, 'zero')`)
    expect(await Tag.destroy(0)).toBe(true)
    expect(ids('ds_tags')).toEqual([1])
  })
})

describe('Model.forceDelete(id) and remove(id)', () => {
  it('remove permanently deletes, soft deletes or not', async () => {
    expect(await Post.remove(1)).toBe(true)
    expect(ids('ds_posts')).toEqual([2])
  })

  it('forceDelete purges a row that was already soft-deleted', async () => {
    await Post.destroy(1)
    expect(rows('ds_posts').length).toBe(2)

    expect(await Post.forceDelete(1)).toBe(true)
    expect(ids('ds_posts')).toEqual([2])
  })

  it('runs the delete hooks', async () => {
    await Post.forceDelete(2)
    expect(hooks).toEqual(['before:B', 'after:B'])
  })

  it('purges a plain model too, with its hooks', async () => {
    expect(await Tag.forceDelete(1)).toBe(true)
    expect(ids('ds_tags')).toEqual([])
    expect(hooks).toEqual(['before:x', 'after:x'])
  })

  it('is false for a missing row', async () => {
    expect(await Post.forceDelete(99)).toBe(false)
    expect(await Tag.remove(99)).toBe(false)
  })

  it('purges a row whose primary key is 0', async () => {
    db.run(`INSERT INTO ds_tags (id, label) VALUES (0, 'zero')`)
    expect(await Tag.forceDelete(0)).toBe(true)
    expect(ids('ds_tags')).toEqual([1])
  })

  it('survives being destructured off the model', async () => {
    const { remove } = Post
    expect(await remove(1)).toBe(true)
    expect(ids('ds_posts')).toEqual([2])
  })
})

describe('instance.forceDelete()', () => {
  it('removes a soft-deletable row the instance would otherwise mark', async () => {
    const post = await Post.find(1)
    expect(await post.forceDelete()).toBe(true)
    expect(ids('ds_posts')).toEqual([2])
    expect(hooks).toEqual(['before:A', 'after:A'])
  })

  it('purges an already-trashed instance', async () => {
    const post = await Post.find(1)
    await post.delete()
    expect(post.trashed()).toBe(true)

    await post.forceDelete()
    expect(ids('ds_posts')).toEqual([2])
  })

  it('refuses an instance with no primary key', async () => {
    await expect(Post.make({ title: 'unsaved' }).forceDelete()).rejects.toThrow('Cannot delete a model without a primary key')
  })
})
