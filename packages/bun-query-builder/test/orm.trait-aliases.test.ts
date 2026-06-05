/**
 * Regression coverage for stacksjs/bun-query-builder#1031.
 *
 * The `timestampable` / `softDeletable` trait aliases (accepted by the types
 * and the migration generator) were ignored at runtime — the ORM only checked
 * `useTimestamps` / `useSoftDeletes`, so a model declared with the aliases got
 * the columns but never populated timestamps and hard-deleted instead of soft.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { configureOrm, createModel, createTableFromModel, getDatabase } from '../src/orm'

const Post = createModel({
  name: 'AliasPost',
  table: 'alias_posts',
  primaryKey: 'id',
  autoIncrement: true,
  // Aliases, NOT useTimestamps/useSoftDeletes.
  traits: { timestampable: true, softDeletable: true },
  attributes: { title: { type: 'string', fillable: true } },
} as const)

describe('timestampable/softDeletable runtime aliases (#1031)', () => {
  beforeAll(() => configureOrm({ database: ':memory:' }))
  beforeEach(async () => {
    getDatabase().run('DROP TABLE IF EXISTS alias_posts')
    await createTableFromModel(Post.getDefinition())
  })
  afterAll(() => getDatabase().close())

  it('populates created_at/updated_at on create via the timestampable alias', async () => {
    const p = await Post.create({ title: 'A' })
    expect(p.get('created_at' as any)).not.toBeNull()
    expect(p.get('updated_at' as any)).not.toBeNull()
  })

  it('soft-deletes (sets deleted_at, hidden from reads) via the softDeletable alias', async () => {
    const p = await Post.create({ title: 'B' })
    await p.delete()
    // Row hidden from default reads (soft delete, not hard delete).
    expect(await Post.query().count()).toBe(0)
    // But still present with deleted_at set.
    const trashed = await Post.withTrashed().get()
    expect(trashed.length).toBe(1)
    expect(trashed[0].get('deleted_at' as any)).not.toBeNull()
  })
})
