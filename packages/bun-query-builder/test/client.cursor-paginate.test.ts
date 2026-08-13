/**
 * Regression coverage for stacksjs/bun-query-builder#1090.
 *
 * `cursorPaginate` appended its cursor predicate with an unconditional `WHERE`
 * keyword instead of continuing an existing one with `AND`. Any filter already
 * on the builder produced two top-level `WHERE`s and a parse error — on every
 * dialect, not just the SQLite wrapper.
 *
 * `chunkById` and `eachById` both delegate to it, so `.where(x).chunkById(...)`
 * — the natural way to walk a filtered table in batches — had never worked.
 *
 * The timing is what kept this hidden: page one is fetched with no cursor, so
 * no predicate is emitted and it succeeds. The failure only lands on page two.
 * A fixture that fits in a single chunk passes, which is why the existing
 * pagination tests never caught it. Every test here therefore either forces a
 * non-null cursor or spans more than one chunk.
 */

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, createQueryBuilder } from '../src'

const schema = buildDatabaseSchema({
  Row: {
    name: 'Row',
    table: 'cp_rows',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      b: { validation: { rule: {} } },
      g: { validation: { rule: {} } },
    },
  },
} as any)

let sql: SQL

beforeAll(async () => {
  sql = new SQL('sqlite://:memory:')
  await sql.unsafe('CREATE TABLE cp_rows (id INTEGER PRIMARY KEY, b INTEGER, g INTEGER)')
  // ids 1-20; `b` alternates 1/0 so a filter halves the set; `g` groups by 5.
  for (let i = 1; i <= 20; i++)
    await sql.unsafe('INSERT INTO cp_rows VALUES (?, ?, ?)', [i, i % 2, Math.ceil(i / 5)])
})

afterAll(async () => {
  await sql?.end()
})

const q = () => createQueryBuilder<typeof schema>({ schema, sql }).selectFrom('cp_rows').selectAll() as any

describe('cursorPaginate continues an existing WHERE (#1090)', () => {
  it('pages a filtered query instead of throwing', async () => {
    const page = await q().where('b', '=', 1).cursorPaginate(3, 5, 'id')

    // Was: SQLiteError: near "WHERE": syntax error.
    expect(page.data.map((r: any) => r.id)).toEqual([7, 9, 11])
    // The builder's own filter must still apply — a fix that merely stopped
    // throwing by dropping the WHERE would return 6, 7, 8 here.
    expect(page.data.every((r: any) => r.b === 1)).toBe(true)
  })

  it('pages an unfiltered query exactly as before', async () => {
    const page = await q().cursorPaginate(3, 5, 'id')

    expect(page.data.map((r: any) => r.id)).toEqual([6, 7, 8])
  })

  it('honours a descending cursor alongside a filter', async () => {
    const page = await q().where('b', '=', 1).cursorPaginate(3, 15, 'id', 'desc')

    expect(page.data.map((r: any) => r.id)).toEqual([13, 11, 9])
  })

  it('honours a composite cursor alongside a filter', async () => {
    const page = await q().where('b', '=', 1).cursorPaginate(3, [2, 7], ['g', 'id'])

    expect(page.data.map((r: any) => r.id)).toEqual([9, 11, 13])
  })

  it('carries a grouped OR filter into the cursor query', async () => {
    // Guards the interaction with #1083: the builder's WHERE is rendered from
    // the term list, so the cursor predicate has to be ANDed against the whole
    // group rather than against its last term.
    const page = await q().where('id', '<=', 4).orWhere('id', '>=', 18).cursorPaginate(10, 1, 'id')

    expect(page.data.map((r: any) => r.id)).toEqual([2, 3, 4, 18, 19, 20])
  })
})

describe('chunkById/eachById over a filtered query (#1090)', () => {
  it('chunkById walks every matching row', async () => {
    const seen: number[] = []
    await q().where('b', '=', 1).chunkById(3, 'id', (rows: any[]) => {
      seen.push(...rows.map(r => r.id))
    })

    // Was: threw on the second chunk. Note this spans four chunks — a fixture
    // that fitted in one would have passed against the bug.
    expect(seen).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19])
  })

  it('eachById visits every matching row', async () => {
    const seen: number[] = []
    await q().where('b', '=', 1).eachById(3, 'id', (row: any) => {
      seen.push(row.id)
    })

    expect(seen).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19])
  })

  it('chunkById is unchanged on an unfiltered query', async () => {
    const seen: number[] = []
    await q().chunkById(3, 'id', (rows: any[]) => {
      seen.push(...rows.map(r => r.id))
    })

    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })
})

describe('cursorPaginate argument validation (#1090)', () => {
  it('refuses to be combined with orderBy', async () => {
    // A cursor predicate `col > ?` only means "the rows after this one" if the
    // result is sorted by that column, so a second ordering makes the cursor
    // meaningless. This always emitted a duplicate ORDER BY and failed to
    // parse; it was invisible because the duplicate-WHERE error fired first.
    await expect(q().where('b', '=', 1).orderBy('id').cursorPaginate(3, 5, 'id'))
      .rejects.toThrow(/cannot be combined with orderBy/)
  })

  it('refuses a non-positive page size', async () => {
    await expect(q().cursorPaginate(0, 1, 'id')).rejects.toThrow(/expected positive integer/)
  })

  it('refuses a column that is not an identifier', async () => {
    await expect(q().cursorPaginate(3, 1, 'id; DROP TABLE cp_rows')).rejects.toThrow(/Invalid identifier/)
    // And the table is still there.
    expect((await sql.unsafe('SELECT count(*) as c FROM cp_rows'))[0].c).toBe(20)
  })
})
