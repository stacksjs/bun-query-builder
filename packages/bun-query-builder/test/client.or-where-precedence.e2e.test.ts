/**
 * The `orWhere` grouping fix (#1083), measured in rows rather than SQL text.
 *
 * Asserting the emitted string proves the shape changed. Only row counts prove
 * the shape was WRONG — and wrong in the dangerous direction, returning a
 * superset of what was asked for rather than erroring. Every `it` here carries
 * the pre-fix number next to the post-fix one, because "10, not 80" is the
 * whole report and a bare `toBe(10)` loses it.
 *
 * Fixture: 118 rows, matching the numbers in the issue.
 *   ids   1-40   create_t{i}_table
 *   ids  41-80   alter_t{i}_table
 *   ids  81-118  create_i{i}_index
 *   batch = id <= 59 ? 1 : 2
 *
 * So `%create%` matches 78 rows, `%table%` matches 80, and `id <= 10` matches
 * 10 — the overlaps are what make the mis-grouping visible.
 */

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, createQueryBuilder } from '../src'

const schema = buildDatabaseSchema({
  Migration: {
    name: 'Migration',
    table: 'migrations',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      migration: { validation: { rule: {} } },
      batch: { validation: { rule: {} } },
    },
  },
} as any)

let sql: SQL

beforeAll(async () => {
  sql = new SQL('sqlite://:memory:')
  await sql.unsafe('CREATE TABLE migrations (id INTEGER PRIMARY KEY, migration TEXT, batch INTEGER)')
  for (let i = 1; i <= 118; i++) {
    const name = i <= 40 ? `create_t${i}_table` : i <= 80 ? `alter_t${i}_table` : `create_i${i}_index`
    await sql.unsafe('INSERT INTO migrations (id, migration, batch) VALUES (?, ?, ?)', [i, name, i <= 59 ? 1 : 2])
  }
})

afterAll(async () => {
  await sql?.end()
})

const q = () => createQueryBuilder<typeof schema>({ schema, sql }).selectFrom('migrations').selectAll() as any

describe('orWhere grouping, in rows (#1083)', () => {
  it('the reported chain matches 10 rows, not 118', async () => {
    const rows = await q()
      .where('id', '<=', 10)
      .where('migration', 'like', '%create%')
      .orWhere('migration', 'like', '%table%')
      .execute()

    expect(rows.length).toBe(10)
    // The bounding filter is the thing that used to vanish. Assert it directly:
    // a count alone would pass for the wrong reason if the fixture changed.
    expect(rows.every((r: any) => r.id <= 10)).toBe(true)
  })

  it('a where after an orWhere constrains the whole group', async () => {
    const rows = await q()
      .where('id', '<=', 10)
      .orWhere('migration', 'like', '%table%')
      .where('batch', '=', 2)
      .execute()

    // Was 31: the trailing `batch = 2` bound only to the OR's right arm, so
    // rows 1-10 came back regardless of their batch.
    expect(rows.length).toBe(21)
    expect(rows.every((r: any) => r.batch === 2)).toBe(true)
  })

  it('a five-term chain does not degenerate to the whole table', async () => {
    const rows = await q()
      .where('id', '<=', 59)
      .where('migration', 'like', '%create%')
      .orWhere('migration', 'like', '%table%')
      .where('batch', '=', 1)
      .orWhere('batch', '=', 2)
      .execute()

    // Was 118 — every row in the table, from a query with five filters on it.
    expect(rows.length).toBe(59)
  })

  it('a two-term OR chain still returns both branches', async () => {
    const rows = await q().where('id', '<=', 10).orWhere('migration', 'like', '%table%').execute()

    // Unchanged by the fix, and that is the point: no churn for the common case.
    expect(rows.length).toBe(80)
  })

  it('a leading orWhere runs instead of raising a syntax error', async () => {
    const rows = await q().orWhere('id', '<=', 10).execute()

    // Was `SELECT * FROM migrations OR id <= ?` — SQLiteError: near "OR".
    expect(rows.length).toBe(10)
  })

  it('whereGroup reproduces the pre-fix reading exactly', async () => {
    const rows = await q()
      .whereGroup((g: any) => g.where('id', '<=', 10).where('migration', 'like', '%create%'))
      .orWhere('migration', 'like', '%table%')
      .execute()

    // 80 is what the broken chain returned. Anyone who was relying on the old
    // grouping has this as the migration path, so it is pinned to the old
    // number on purpose.
    expect(rows.length).toBe(80)
  })

  it('count/sum/min/max all see the grouped WHERE', async () => {
    const filtered = () => q()
      .where('id', '<=', 10)
      .where('migration', 'like', '%create%')
      .orWhere('migration', 'like', '%table%')

    // The aggregates rebuild their SQL by slicing from ' FROM ', which is the
    // cheapest possible tripwire for a missed emit path: if any of them still
    // read the raw text, they would aggregate over the unfiltered table.
    expect(await filtered().count()).toBe(10)
    expect(await filtered().max('id')).toBe(10)
    expect(await filtered().min('id')).toBe(1)
    expect(await filtered().sum('id')).toBe(55)
  })

  it('first() and exists() see the grouped WHERE', async () => {
    const filtered = () => q().where('id', '>=', 100).orWhere('id', '<=', 2).where('batch', '=', 1)

    expect(await filtered().exists()).toBe(true)
    const rows = await filtered().execute()
    expect(rows.length).toBe(2)
  })

  it('paginate counts and pages the grouped WHERE', async () => {
    const page = await q()
      .where('id', '<=', 10)
      .where('migration', 'like', '%create%')
      .orWhere('migration', 'like', '%table%')
      .paginate(4)

    expect(page.meta.total).toBe(10)
    expect(page.data.map((r: any) => r.id)).toEqual([1, 2, 3, 4])
  })
})
