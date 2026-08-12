import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, config, createQueryBuilder, setConfig } from '../src'
import { resetConnection } from '../src/db'

/**
 * Regression coverage for stacksjs/bun-query-builder#1084.
 *
 * `paginate()` threw `SQLite query expected 3 values, received 2` on any query
 * whose WHERE contributed a binding, and the arithmetic named the cause: the
 * shortfall was always exactly the number of parameters the WHERE needed, and
 * `whereNull` — the one where-form that adds SQL text but no bindings — was the
 * one that worked.
 *
 * The bug was NOT in `paginate`. It was in the bun:sqlite wrapper's
 * tagged-template interpolation (`processTaggedTemplate` in db.ts). The queries
 * that wrapper returns carry `raw: () => sql` so callers can read their text,
 * which also made them satisfy the raw-marker branch that was tested FIRST. So
 * interpolating one query into another spliced its SQL text and discarded its
 * `values`, leaving placeholders with nothing behind them.
 *
 * `paginate` nests twice — once for `COUNT(*) FROM (…)` and once for
 * `… LIMIT ? OFFSET ?` — which made it the loudest victim, but everything that
 * composes a query into a template was affected. The count half failed more
 * quietly than the page half: bun:sqlite only arity-checks when some values are
 * passed, so `WHERE id > ?` bound the placeholder to NULL, matched nothing, and
 * reported `total: 0` instead of throwing. That is why these tests assert
 * `meta.total` explicitly rather than only that `paginate()` does not throw.
 *
 * These must run against the library's own SQLite connection (config-driven,
 * via `resetConnection()`), NOT an injected `new SQL(...)`. An injected
 * connection routes around the wrapper entirely, so the bug is invisible — that
 * is precisely why the existing pagination tests never caught this.
 */

const schema = buildDatabaseSchema({
  Row: {
    name: 'Row',
    table: 'p_rows',
    primaryKey: 'id',
    attributes: { id: { validation: { rule: {} } }, executed_at: { validation: { rule: {} } } },
  },
} as any)

let saved: { dialect: any, database: any }

beforeEach(async () => {
  saved = { dialect: config.dialect, database: { ...config.database } }
  setConfig({ dialect: 'sqlite', database: { database: ':memory:' } })
  resetConnection()

  const db = createQueryBuilder<typeof schema>({ schema })
  await db.unsafe('CREATE TABLE p_rows (id INTEGER PRIMARY KEY, executed_at TEXT)')
  for (let i = 1; i <= 20; i++)
    await db.unsafe(`INSERT INTO p_rows (id, executed_at) VALUES (${i}, ${i > 13 ? `'done'` : 'NULL'})`)
})

afterEach(() => {
  setConfig({ dialect: saved.dialect, database: saved.database } as any)
  resetConnection()
})

const qb = () => createQueryBuilder<typeof schema>({ schema })

describe('paginate carries the WHERE clause bindings (#1084)', () => {
  it('pages a filtered query instead of throwing', async () => {
    // Was: SQLite query expected 3 values, received 2
    const result: any = await qb().selectFrom('p_rows').selectAll().where('id', '>', 10).paginate(5)

    expect(result.data.map((r: any) => r.id)).toEqual([11, 12, 13, 14, 15])
  })

  it('counts only the filtered rows', async () => {
    // A separate assertion on purpose: the count query failed SILENTLY (bound
    // the placeholder to NULL and matched nothing), so it would have reported
    // total 0 even once the page query stopped throwing.
    const result: any = await qb().selectFrom('p_rows').selectAll().where('id', '>', 10).paginate(5)

    expect(result.meta.total).toBe(10)
    expect(result.meta.total).not.toBe(0)
  })

  it('binds a whereIn list', async () => {
    // Was: expected 5 values, received 2 — the shortfall is the list length.
    const result: any = await qb().selectFrom('p_rows').selectAll().whereIn('id', [1, 2, 3]).paginate(5)

    expect(result.data.map((r: any) => r.id)).toEqual([1, 2, 3])
    expect(result.meta.total).toBe(3)
  })

  it('still works for a where-form that contributes no bindings', async () => {
    // whereNull was the case that always worked; it must not regress.
    const result: any = await qb().selectFrom('p_rows').selectAll().whereNull('executed_at').paginate(5)

    expect(result.meta.total).toBe(13)
  })

  it('still works with no filter at all', async () => {
    const result: any = await qb().selectFrom('p_rows').selectAll().paginate(5)

    expect(result.data.length).toBe(5)
    expect(result.meta.total).toBe(20)
  })
})

describe('other query-composing methods see the WHERE (#1084)', () => {
  // Same root cause, quieter symptoms: these returned the un-filtered answer
  // rather than throwing, because their nested fragment lost its bindings.
  it('exists() respects the filter', async () => {
    expect(await qb().selectFrom('p_rows').selectAll().where('id', '>', 10).exists()).toBe(true)
    expect(await qb().selectFrom('p_rows').selectAll().where('id', '>', 999).exists()).toBe(false)
  })

  it('first() returns a row matching the filter', async () => {
    const row: any = await qb().selectFrom('p_rows').selectAll().where('id', '>', 10).first()

    expect(row?.id).toBe(11)
  })

  it('count() agrees with the number of rows get() returns', async () => {
    // The cheapest tripwire for this whole family: if a composing path loses
    // its bindings again, these two stop matching.
    const q = () => qb().selectFrom('p_rows').selectAll().where('id', '>', 10)
    const rows: any = await q().get()

    expect(Number(await q().count())).toBe(rows.length)
  })
})
