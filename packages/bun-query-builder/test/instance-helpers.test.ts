/**
 * Tests for the new ModelInstance helper methods:
 *   - getAttribute / getAttributes
 *   - only / except
 *   - toArray
 *   - fresh / refresh
 *   - get() defensive fallback when computed accessor returns undefined / throws
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { configureOrm, createModel, createTableFromModel, getDatabase } from '../src/orm'

const Post = createModel({
  name: 'Post',
  table: 'test_helpers_posts',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useTimestamps: true },
  attributes: {
    title: { type: 'string', fillable: true },
    body: { type: 'string', fillable: true },
    secret: { type: 'string', fillable: true },
    views: { type: 'number', fillable: true },
  },
  // Computed accessor that conflicts with an attribute name in lower case —
  // returning undefined here exercises the .get() defensive fallback.
  get: {
    silentTitle: () => undefined,
    upperTitle: (attrs: Record<string, unknown>) => String(attrs.title).toUpperCase(),
    boomTitle: () => { throw new Error('accessor exploded') },
  },
} as const)

describe('ModelInstance helper methods', () => {
  beforeAll(() => {
    configureOrm({ database: ':memory:' })
    const db = getDatabase()
    db.run(`CREATE TABLE IF NOT EXISTS test_helpers_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, body TEXT, secret TEXT, views INTEGER,
      created_at TEXT, updated_at TEXT
    )`)
    db.run(
      `INSERT INTO test_helpers_posts (title, body, secret, views) VALUES (?, ?, ?, ?)`,
      ['Hello', 'World', 'shhh', 42],
    )
  })

  afterAll(() => {
    getDatabase().run('DROP TABLE IF EXISTS test_helpers_posts')
  })

  it('getAttribute reads the raw value, skipping computed accessors', () => {
    const post = Post.find(1)!
    // Computed accessor would uppercase, getAttribute should not.
    expect(post.getAttribute('title')).toBe('Hello')
    expect((post.get as any)('upperTitle')).toBe('HELLO')
  })

  it('get() falls back to raw attribute when accessor returns undefined', () => {
    const post = Post.find(1)!
    // silentTitle accessor returns undefined → fall through to attribute (none for that key, undefined)
    expect((post.get as any)('silentTitle')).toBeUndefined()
    // For real attribute names, get() returns the raw value (no accessor defined for 'title')
    expect(post.get('title')).toBe('Hello')
  })

  it('get() catches exceptions thrown by buggy accessors', () => {
    const post = Post.find(1)!
    // boomTitle throws — get() must not propagate; falls back to attribute (undefined for that key)
    expect(() => (post.get as any)('boomTitle')).not.toThrow()
  })

  it('getAttributes returns a shallow copy of all attributes', () => {
    const post = Post.find(1)!
    const attrs = post.getAttributes()
    expect(attrs.title).toBe('Hello')
    expect(attrs.body).toBe('World')
    // Mutating the snapshot must not affect the underlying instance
    ;(attrs as any).title = 'Changed'
    expect(post.get('title')).toBe('Hello')
  })

  it('only() narrows to the named attributes', () => {
    const post = Post.find(1)!
    const slim = post.only(['title', 'views'])
    expect(slim).toEqual({ title: 'Hello', views: 42 } as any)
    expect((slim as any).body).toBeUndefined()
    expect((slim as any).secret).toBeUndefined()
  })

  it('except() drops the named attributes', () => {
    const post = Post.find(1)!
    const safe = post.except(['secret'])
    expect((safe as any).title).toBe('Hello')
    expect((safe as any).body).toBe('World')
    expect((safe as any).secret).toBeUndefined()
  })

  it('toArray() returns the attribute snapshot', () => {
    const post = Post.find(1)!
    const arr = post.toArray()
    expect(arr.title).toBe('Hello')
    expect(arr.views).toBe(42)
  })

  it('fresh() returns a new instance with the latest DB values', () => {
    const post = Post.find(1)!
    getDatabase().run(`UPDATE test_helpers_posts SET views = ? WHERE id = ?`, [99, 1])
    // Receiver is unchanged
    expect(post.get('views')).toBe(42)
    const next = post.fresh()
    expect(next).not.toBeNull()
    expect(next!.get('views')).toBe(99)
    // Receiver still untouched
    expect(post.get('views')).toBe(42)
  })

  it('refresh() updates this instance in place and clears dirty state', () => {
    const post = Post.find(1)!
    post.set('views', 1234)
    expect(post.isDirty()).toBe(true)
    const same = post.refresh()
    expect(same).toBe(post)
    // After refresh, the in-memory value matches the DB (not the previous local mutation)
    expect(post.get('views')).toBe(99)
    expect(post.isDirty()).toBe(false)
  })

  it('fresh() returns null when the row no longer exists', () => {
    const post = Post.find(1)!
    getDatabase().run(`DELETE FROM test_helpers_posts WHERE id = ?`, [1])
    expect(post.fresh()).toBeNull()
  })

  it('refresh() returns null when the row no longer exists', () => {
    // Re-seed and re-fetch so we have a clean instance whose primary key
    // does NOT match any row in the DB once we delete it.
    const db = getDatabase()
    db.run(`INSERT INTO test_helpers_posts (id, title, body, secret, views) VALUES (?, ?, ?, ?, ?)`, [99, 'Tmp', 'b', 's', 1])
    const post = Post.find(99)!
    db.run(`DELETE FROM test_helpers_posts WHERE id = ?`, [99])
    expect(post.refresh()).toBeNull()
  })
})
