/**
 * An explicitly supplied `created_at` must survive the INSERT.
 *
 * `created_at` comes from the timestamps trait rather than a declared
 * attribute, so the insert payload builder never copied it off the instance —
 * and the timestamps block then wrote `formatNow()` unconditionally. A caller
 * who set it deliberately (importing historical records, backfilling a
 * migration, seeding dates that carry meaning) silently got the insert time:
 * the value was accepted, nothing errored, and the row simply came back with
 * the wrong date.
 *
 * `update()` honoured the same field all along, so the two paths disagreed
 * about who owned the column — a create-then-update round trip "fixed" it,
 * which is exactly what made the bug hard to see.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { clearModelRegistry, configureOrm, defineModel, getDatabase } from '../src'

const PAST = '2020-01-02 03:04:05'

beforeEach(() => {
  clearModelRegistry()
  configureOrm({ database: new Database(':memory:', { create: true }) })
})
afterEach(() => clearModelRegistry())

function makeModel() {
  getDatabase().run(`CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    created_at TEXT,
    updated_at TEXT
  )`)

  return defineModel({
    name: 'Post',
    table: 'posts',
    primaryKey: 'id',
    traits: { useTimestamps: true },
    attributes: { title: { type: 'string', fillable: true } },
  } as const)
}

describe('insert honours an explicitly supplied created_at', () => {
  it('keeps the supplied value instead of stamping now', async () => {
    const Post = makeModel()
    const instance = await (Post as any).make()
    instance.forceFill({ title: 'imported', created_at: PAST })
    await instance.save()

    const row: any = getDatabase().query('SELECT * FROM posts WHERE title = ?').get('imported')
    expect(row.created_at).toBe(PAST)
  })

  it('still stamps updated_at with the time of the write', async () => {
    const Post = makeModel()
    const instance = await (Post as any).make()
    instance.forceFill({ title: 'imported', created_at: PAST })
    await instance.save()

    const row: any = getDatabase().query('SELECT * FROM posts WHERE title = ?').get('imported')
    // The row IS being written now, whatever date it claims to have been created.
    expect(row.updated_at).not.toBe(PAST)
    expect(String(row.updated_at).length).toBeGreaterThan(0)
  })

  it('falls back to now when nothing was supplied', async () => {
    const Post = makeModel()
    const instance = await (Post as any).make()
    instance.forceFill({ title: 'fresh' })
    await instance.save()

    const row: any = getDatabase().query('SELECT * FROM posts WHERE title = ?').get('fresh')
    expect(row.created_at).toBeTruthy()
    expect(row.created_at).not.toBe(PAST)
    expect(row.created_at).toBe(row.updated_at)
  })

  it('treats an explicit null as "no value supplied"', async () => {
    const Post = makeModel()
    const instance = await (Post as any).make()
    instance.forceFill({ title: 'nulled', created_at: null })
    await instance.save()

    const row: any = getDatabase().query('SELECT * FROM posts WHERE title = ?').get('nulled')
    expect(row.created_at).toBeTruthy()
  })
})
