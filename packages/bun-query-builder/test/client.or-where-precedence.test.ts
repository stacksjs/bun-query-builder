/**
 * `orWhere` used to append a bare, ungrouped `OR`.
 *
 * SQL binds AND tighter than OR, so `a AND b OR c` parses as `(a AND b) OR c`
 * and the first filter stops applying to every row `c` matches. Nothing warns;
 * the query is valid SQL; the result set is a SUPERSET of what was asked for.
 * Failing toward MORE rows is what made it dangerous — it looks like data
 * rather than an error. The reported case returned 118 rows where 10 were
 * intended, on a moderation queue where the extra rows were already-published
 * content shown as pending.
 *
 * The rule now: each maximal run of OR terms is bracketed with the term that
 * opens it, so OR binds TIGHTER than AND in chain order. See renderWhereTerms
 * in src/sql-fragments.ts and stacksjs/bun-query-builder#1083.
 *
 * The no-churn guarantee matters as much as the fix: chains with no `orWhere`,
 * two-term OR chains, and all-OR chains must emit exactly what they emitted
 * before. Those are asserted with `toBe`, not `toContain`.
 */

import { describe, expect, it } from 'bun:test'
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

const q = () => createQueryBuilder<typeof schema>({ schema }).selectFrom('migrations').selectAll() as any
const sqlOf = (build: (b: any) => any): string => String(build(q()).toSQL())

describe('orWhere groups with the term before it (#1083)', () => {
  it('brackets a trailing OR run — the reported chain', () => {
    const sql = sqlOf(b => b
      .where('id', '<=', 10)
      .where('migration', 'like', '%create%')
      .orWhere('migration', 'like', '%table%'))

    // Was: `WHERE id <= $1 AND migration like $2 OR migration like $3`,
    // which meant `(id <= 10 AND create) OR table` and returned 118 of 118.
    expect(sql).toContain('WHERE id <= $1 AND (migration like $2 OR migration like $3)')
  })

  it('brackets a leading OR run against the AND that follows', () => {
    const sql = sqlOf(b => b
      .where('id', '<=', 10)
      .orWhere('migration', 'like', '%table%')
      .where('batch', '=', 2))

    // The mis-grouping ran in both directions: this used to parse as
    // `id <= 10 OR (table AND batch = 2)`, so the trailing filter bound only
    // to the OR's right arm.
    expect(sql).toContain('WHERE (id <= $1 OR migration like $2) AND batch = $3')
  })

  it('leaves a two-term OR chain byte-identical', () => {
    // `toBe`, deliberately. A single top-level piece needs no brackets, and
    // adding them anyway would churn the emitted SQL of every existing
    // two-term query for no correctness gain.
    expect(sqlOf(b => b.where('id', '<=', 10).orWhere('batch', '=', 2)))
      .toBe('SELECT * FROM migrations WHERE id <= $1 OR batch = $2')
  })

  it('leaves an all-OR chain unbracketed', () => {
    const sql = sqlOf(b => b
      .where('id', '<=', 10)
      .orWhere('migration', 'like', '%create%')
      .orWhere('migration', 'like', '%table%'))

    expect(sql).toBe('SELECT * FROM migrations WHERE id <= $1 OR migration like $2 OR migration like $3')
    expect(sql).not.toContain('(')
  })

  it('leaves an all-AND chain byte-identical', () => {
    expect(sqlOf(b => b.where('id', '<=', 10).where('batch', '=', 1).where('migration', 'like', '%x%')))
      .toBe('SELECT * FROM migrations WHERE id <= $1 AND batch = $2 AND migration like $3')
  })

  it('brackets every OR run in a longer chain', () => {
    const sql = sqlOf(b => b
      .where('id', '<=', 59)
      .where('migration', 'like', '%create%')
      .orWhere('migration', 'like', '%table%')
      .where('batch', '=', 1)
      .orWhere('batch', '=', 2))

    // Was `a AND b OR c AND d OR e`, which degenerates to the whole table.
    expect(sql).toContain('WHERE id <= $1 AND (migration like $2 OR migration like $3) AND (batch = $4 OR batch = $5)')
  })
})

describe('a leading orWhere emits WHERE, not a dangling OR (#1083)', () => {
  // Five methods bypassed the connector helper entirely and emitted
  // `SELECT … FROM migrations OR …` when they were the first predicate —
  // invalid SQL on every dialect.
  const leading: Array<[string, (b: any) => any]> = [
    ['orWhere', b => b.orWhere('id', '<=', 10)],
    ['orWhereIn', b => b.orWhereIn('id', [1, 2])],
    ['orWhereNotIn', b => b.orWhereNotIn('id', [1, 2])],
    ['orWhereColumn', b => b.orWhereColumn('id', '=', 'batch')],
    ['orWhereNested', b => b.orWhereNested('SELECT 1')],
    ['orWhereLike', b => b.orWhereLike('migration', '%x%')],
    ['orWhereNull', b => b.orWhereNull('batch')],
  ]

  for (const [name, build] of leading) {
    it(`${name}() as the first predicate`, () => {
      const sql = sqlOf(build)

      expect(sql).not.toMatch(/FROM\s+migrations\s+OR\b/)
      expect(sql).toContain('WHERE')
    })
  }
})

describe('the WHERE lands in the right place (#1083)', () => {
  it('a where added after an orderBy still precedes the ORDER BY', () => {
    const sql = sqlOf(b => b.where('id', '<=', 10).orderBy('id').orWhere('batch', '=', 2))

    // Was `… WHERE id <= $1 ORDER BY id ASC OR batch = $2` — a syntax error.
    expect(sql.indexOf('WHERE')).toBeLessThan(sql.indexOf('ORDER BY'))
    expect(sql).toBe('SELECT * FROM migrations WHERE id <= $1 OR batch = $2 ORDER BY id ASC')
  })

  it('a where added after a limit still precedes the LIMIT', () => {
    const sql = sqlOf(b => b.where('id', '<=', 10).limit(5).where('batch', '=', 1))

    expect(sql.indexOf('WHERE')).toBeLessThan(sql.indexOf('LIMIT'))
  })

  it('keeps params in emitted order across a group', () => {
    const built = q().where('id', '<=', 10).orWhere('batch', '=', 2).where('id', '>=', 1)

    expect(built.__rawState().params).toEqual([10, 2, 1])
  })
})

describe('whereGroup is the escape hatch for the old reading (#1083)', () => {
  it('expresses (a AND b) OR c', () => {
    const sql = sqlOf(b => b
      .whereGroup((g: any) => g.where('id', '<=', 10).where('migration', 'like', '%create%'))
      .orWhere('migration', 'like', '%table%'))

    expect(sql).toContain('WHERE (id <= $1 AND migration like $2) OR migration like $3')
  })

  it('numbers the group placeholders after the terms before it', () => {
    const built = q()
      .where('batch', '=', 1)
      .whereGroup((g: any) => g.where('id', '<=', 10).orWhere('id', '>=', 100))

    const sql = String(built.toSQL())
    expect(sql).toContain('WHERE batch = $1 AND (id <= $2 OR id >= $3)')
    // The sub-builder numbers from $1; without the offset both the outer and
    // inner first placeholder would be $1 and the values would bind shifted.
    expect((sql.match(/\$1/g) ?? []).length).toBe(1)
    expect(built.__rawState().params).toEqual([1, 10, 100])
  })

  it('orWhereGroup ORs the whole group', () => {
    const sql = sqlOf(b => b
      .where('batch', '=', 1)
      .orWhereGroup((g: any) => g.where('id', '<=', 10).where('migration', 'like', '%x%')))

    expect(sql).toContain('WHERE batch = $1 OR (id <= $2 AND migration like $3)')
  })

  it('throws rather than widening when the callback adds nothing', () => {
    // A group that contributed no predicate would silently drop out and leave
    // the query matching every row it existed to exclude.
    expect(() => q().whereGroup(() => {})).toThrow(/added no conditions/)
  })
})

describe('object and raw forms are one term each (#1083)', () => {
  it('brackets a multi-key object so a later orWhere binds to all of it', () => {
    const sql = sqlOf(b => b.where({ batch: 1, id: 2 }).orWhere('migration', 'like', '%x%'))

    // Un-bracketed this was `batch = $1 AND id = $2 OR migration like $3`,
    // which drops `batch` — the object's own keys came apart.
    expect(sql).toContain('WHERE (batch = $1 AND id = $2) OR migration like $3')
  })

  it('leaves a single-key object unbracketed', () => {
    expect(sqlOf(b => b.where({ batch: 1 })))
      .toBe('SELECT * FROM migrations WHERE batch = $1')
  })

  it('treats orWhere({a, b}) as OR (a AND b)', () => {
    const sql = sqlOf(b => b.where('id', '<=', 10).orWhere({ batch: 1, migration: 'x' }))

    expect(sql).toContain('OR (batch = $2 AND migration = $3)')
  })
})

describe('the sub-select builder groups the same way (#1083)', () => {
  const sub = () => createQueryBuilder<typeof schema>({ schema })
    .selectFromSub(createQueryBuilder<typeof schema>({ schema }).selectFrom('migrations').selectAll() as any, 'm') as any

  it('brackets a trailing OR run', () => {
    const sql = String(sub().where('id', '<=', 10).where('batch', '=', 1).orWhere('batch', '=', 2).toSQL())

    expect(sql).toContain('AND (batch = $2 OR batch = $3)')
  })

  it('places a where added after an orderBy before the ORDER BY', () => {
    const sql = String(sub().orderBy('id').where('id', '<=', 10).toSQL())

    // The old builder appended the WHERE to the end of the text, so ordering
    // first made the query unparseable.
    expect(sql.indexOf('WHERE')).toBeLessThan(sql.indexOf('ORDER BY'))
  })

  it('emits WHERE for a leading orWhere', () => {
    const sql = String(sub().orWhere('id', '<=', 10).toSQL())

    expect(sql).toContain('WHERE id <= $1')
    expect(sql).not.toMatch(/AS m\s+OR\b/)
  })

  it('supports whereGroup for the old reading', () => {
    const sql = String(sub()
      .whereGroup((g: any) => g.where('id', '<=', 10).where('batch', '=', 1))
      .orWhere('batch', '=', 2)
      .toSQL())

    expect(sql).toContain('WHERE (id <= $1 AND batch = $2) OR batch = $3')
  })
})
