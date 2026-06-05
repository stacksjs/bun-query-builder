/**
 * Regression coverage for stacksjs/bun-query-builder#1024.
 *
 * The `useSoftDeletes` trait soft-deletes on `delete()`, but reads must hide
 * trashed rows by default (and offer withTrashed/onlyTrashed/restore).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { configureOrm, createModel, createTableFromModel, getDatabase } from '../src/orm'

const Post = createModel({
  name: 'SDPost',
  table: 'sd_posts',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useSoftDeletes: true },
  attributes: { title: { type: 'string', fillable: true } },
} as const)

describe('soft-delete read filtering (#1024)', () => {
  beforeAll(() => {
    configureOrm({ database: ':memory:' })
  })

  beforeEach(async () => {
    const db = getDatabase()
    db.run('DROP TABLE IF EXISTS sd_posts')
    await createTableFromModel(Post.getDefinition())
    await Post.create({ title: 'A' })
    await Post.create({ title: 'B' })
    await Post.create({ title: 'C' })
  })

  afterAll(() => getDatabase().close())

  async function deleteByTitle(title: string) {
    const row = await Post.where('title', title).first()
    await row!.delete()
    return row!
  }

  it('excludes soft-deleted rows from get()/count()', async () => {
    await deleteByTitle('B')
    const titles = (await Post.query().get()).map(r => r.get('title'))
    expect(titles.sort()).toEqual(['A', 'C'])
    expect(await Post.query().count()).toBe(2)
  })

  it('excludes soft-deleted rows from find()/findMany()/first()/pluck()/aggregates', async () => {
    const b = await deleteByTitle('B')
    expect(await Post.find(b.id!)).toBeUndefined()
    expect((await Post.findMany([b.id!])).length).toBe(0)
    expect((await Post.pluck('title')).sort()).toEqual(['A', 'C'])
    // max(id) must ignore the trashed row
    const all = await Post.withTrashed().get()
    const maxLive = Math.max(...all.filter(r => r.get('title') !== 'B').map(r => r.id!))
    expect(await Post.query().max('id')).toBe(maxLive)
  })

  it('withTrashed() includes and onlyTrashed() isolates soft-deleted rows', async () => {
    await deleteByTitle('B')
    expect((await Post.withTrashed().get()).length).toBe(3)
    const only = await Post.onlyTrashed().get()
    expect(only.map(r => r.get('title'))).toEqual(['B'])
  })

  it('soft-delete filter survives a top-level OR (cannot be escaped by orWhere)', async () => {
    await deleteByTitle('B')
    // "title A OR title B" must still exclude the trashed B.
    const rows = await Post.where('title', 'A').orWhere('title', 'B').get()
    expect(rows.map(r => r.get('title'))).toEqual(['A'])
  })

  it('restore() clears deleted_at and brings the row back; trashed() reflects state', async () => {
    const b = await deleteByTitle('B')
    expect(b.trashed()).toBe(true)
    await b.restore()
    expect(b.trashed()).toBe(false)
    expect(await Post.query().count()).toBe(3)
    expect((await Post.find(b.id!))?.get('title')).toBe('B')
  })
})
