/**
 * `defineModel()` is typed as the ORM model it returns on the server.
 *
 * It used to carry the browser model's type. The package root runs on Bun and
 * hands back the ORM model, so the two disagreed in both directions:
 *
 *  - `whereRaw`, `with`, `whereGroup`, `increment` and the aggregates worked
 *    but did not type-check;
 *  - `Model.update(id, data)`, `Model.delete(id)` and `query().find()`,
 *    `findOrFail()`, `latest()`, `oldest()` type-checked and then threw
 *    `TypeError: ... is not a function`, because the ORM had none of them.
 *
 * The types are asserted in src/__tests__/type-usage-compile.ts. This file
 * covers the ORM methods added so the browser-model calls keep working.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createTableFromModel, defineModel } from '../src'

let db: Database
let Trail: any
let Note: any
let deletedHook: unknown[]

const TRAILS = [
  { name: 'Ridge', distance: 12, created_at: '2026-01-02 00:00:00' },
  { name: 'Creek', distance: 4, created_at: '2026-01-03 00:00:00' },
  { name: 'Summit', distance: 20, created_at: '2026-01-01 00:00:00' },
]

beforeEach(async () => {
  clearModelRegistry()
  db = new Database(':memory:', { create: true })
  configureOrm({ database: db })
  deletedHook = []

  Trail = defineModel({
    name: 'DmTrail',
    table: 'dm_trails',
    primaryKey: 'id',
    autoIncrement: true,
    attributes: {
      name: { type: 'string', fillable: true },
      distance: { type: 'number', fillable: true },
      created_at: { type: 'string', fillable: true },
    },
  } as any)
  Note = defineModel({
    name: 'DmNote',
    table: 'dm_notes',
    primaryKey: 'id',
    autoIncrement: true,
    traits: { useSoftDeletes: true },
    attributes: { body: { type: 'string', fillable: true } },
    hooks: { afterDelete: (note: any) => { deletedHook.push(note.id) } },
  } as any)

  await createTableFromModel(Trail.getDefinition())
  await createTableFromModel(Note.getDefinition())
  for (const t of TRAILS) await Trail.create(t)
  await Note.create({ body: 'first' })
  await Note.create({ body: 'second' })
})

afterEach(() => {
  clearModelRegistry()
  db.close()
})

describe('query().find() and findOrFail()', () => {
  it('finds by primary key within the query constraints', async () => {
    expect((await Trail.query().find(2))?.get('name')).toBe('Creek')
    expect(await Trail.query().where('distance', '>', 10).find(2)).toBeUndefined()
    expect((await Trail.query().where('distance', '>', 10).find(3))?.get('name')).toBe('Summit')
  })

  it('respects the soft-delete scope', async () => {
    await Note.delete(1)
    expect(await Note.query().find(1)).toBeUndefined()
    expect((await Note.query().withTrashed().find(1))?.get('body')).toBe('first')
  })

  it('findOrFail throws for a missing row', async () => {
    expect((await Trail.query().findOrFail(1)).get('name')).toBe('Ridge')
    await expect(Trail.query().where('distance', '<', 5).findOrFail(1)).rejects.toThrow('DmTrail with id 1 not found')
  })
})

describe('query().latest() and oldest()', () => {
  it('order by created_at by default', async () => {
    expect((await Trail.query().latest().get()).map((t: any) => t.get('name'))).toEqual(['Creek', 'Ridge', 'Summit'])
    expect((await Trail.query().oldest().get()).map((t: any) => t.get('name'))).toEqual(['Summit', 'Ridge', 'Creek'])
  })

  it('take an explicit column', async () => {
    expect((await Trail.query().latest('distance').first())?.get('name')).toBe('Summit')
    expect((await Trail.query().oldest('distance').first())?.get('name')).toBe('Creek')
  })
})

describe('Model.update(id, data)', () => {
  it('updates the row and returns it', async () => {
    const updated = await Trail.update(2, { distance: 5 })
    expect(updated.get('distance')).toBe(5)
    const row = db.query('SELECT distance FROM dm_trails WHERE id = 2').get() as { distance: number }
    expect(row.distance).toBe(5)
    expect((db.query('SELECT distance FROM dm_trails WHERE id = 1').get() as { distance: number }).distance).toBe(12)
  })

  it('throws for a missing row', async () => {
    await expect(Trail.update(99, { distance: 5 })).rejects.toThrow('DmTrail with id 99 not found')
  })
})

describe('Model.delete(id)', () => {
  it('deletes the row', async () => {
    expect(await Trail.delete(2)).toBe(true)
    expect((db.query('SELECT id FROM dm_trails ORDER BY id').all() as { id: number }[]).map(r => r.id)).toEqual([1, 3])
  })

  it('soft-deletes a soft-deletable model and runs delete hooks', async () => {
    expect(await Note.delete(1)).toBe(true)
    const row = db.query('SELECT deleted_at FROM dm_notes WHERE id = 1').get() as { deleted_at: string | null }
    expect(row.deleted_at).not.toBeNull()
    expect(deletedHook).toEqual([1])
  })

  it('returns false for a missing or already-trashed row', async () => {
    expect(await Trail.delete(99)).toBe(false)
    await Note.delete(1)
    expect(await Note.delete(1)).toBe(false)
  })
})

describe('server-only builder methods on a defineModel() model', () => {
  it('whereRaw, whereGroup and increment run', async () => {
    const rows = await Trail.query().whereRaw('LOWER(name) = ?', ['ridge']).get()
    expect(rows.map((t: any) => t.id)).toEqual([1])
    await Trail.query().whereGroup((q: any) => q.where('name', 'Ridge').orWhere('name', 'Creek')).increment('distance', 1)
    expect((db.query('SELECT distance FROM dm_trails ORDER BY id').all() as { distance: number }[]).map(r => r.distance)).toEqual([13, 5, 20])
  })

  it('keeps the introspection helpers', () => {
    expect(Trail.definition.table).toBe('dm_trails')
    expect(Trail.getTable()).toBe('dm_trails')
    expect(Trail.getName()).toBe('DmTrail')
  })
})
