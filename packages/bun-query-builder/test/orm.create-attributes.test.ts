/**
 * Regression coverage for stacksjs/bun-query-builder#1025.
 *
 * create()/save() must persist explicitly-set non-fillable columns (e.g. FK
 * columns like user_id) instead of silently dropping them from the INSERT,
 * while still keeping `guarded` columns mass-assignment protected.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { configureOrm, createModel, getDatabase } from '../src/orm'

const Post = createModel({
  name: 'CAPost',
  table: 'ca_posts',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    title: { type: 'string', fillable: true },
    user_id: { type: 'number' }, // neither fillable nor guarded
    secret: { type: 'string', guarded: true },
  },
} as const)

describe('create()/save() persists explicitly-set non-fillable columns (#1025)', () => {
  beforeAll(() => configureOrm({ database: ':memory:' }))

  beforeEach(() => {
    const db = getDatabase()
    db.run('DROP TABLE IF EXISTS ca_posts')
    db.run('CREATE TABLE ca_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, user_id INTEGER, secret TEXT)')
  })

  afterAll(() => getDatabase().close())

  it('persists a non-fillable, non-guarded column passed to create()', async () => {
    const p = await Post.create({ title: 'X', user_id: 99 } as any)
    expect(p.get('user_id' as any)).toBe(99)
    const row = getDatabase().query('SELECT title, user_id FROM ca_posts WHERE id = ?').get(p.id!) as any
    expect(row).toEqual({ title: 'X', user_id: 99 })
  })

  it('persists a non-fillable column set via .set() before save()', async () => {
    const p = Post.make({ title: 'Y' } as any)
    p.set('user_id' as any, 7)
    await p.save()
    const row = getDatabase().query('SELECT user_id FROM ca_posts WHERE id = ?').get(p.id!) as any
    expect(row.user_id).toBe(7)
  })

  it('still protects guarded columns from being persisted', async () => {
    const p = await Post.create({ title: 'Z', secret: 'leak' } as any)
    const row = getDatabase().query('SELECT secret FROM ca_posts WHERE id = ?').get(p.id!) as any
    expect(row.secret).toBeNull()
  })
})
