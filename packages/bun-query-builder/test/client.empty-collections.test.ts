import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, createQueryBuilder } from '../src'

/**
 * Regression coverage for the two smaller defects reported in
 * stacksjs/bun-query-builder#1083.
 *
 * `whereIn(col, [])` emitted `IN ()`. SQLite parses that and matches nothing,
 * which is the sane reading; Postgres and MySQL reject it as a syntax error. So
 * one call site behaved differently depending on which engine it ran against —
 * portable-looking code that was not portable.
 *
 * `whereAny([], op, value)` returned the builder untouched, so the predicate
 * vanished entirely. An empty column list is nearly always a `.filter()` that
 * removed everything, and the consequence was MORE rows than intended: the
 * query silently widened to include everything the filter existed to exclude.
 *
 * Both now emit a constant predicate. `1 = 0` and `1 = 1` take no parameters
 * and parse identically on all three engines.
 *
 * The mirror case is the one to be careful about: an empty `NOT IN` is TRUE,
 * not FALSE. Nothing is a member of the empty set, so everything is a
 * non-member. Writing `1 = 0` there would silently drop every row from any
 * query whose exclusion list happened to come back empty — the same class of
 * silent, direction-flipping bug being fixed here.
 */

const schema = buildDatabaseSchema({
  Row: {
    name: 'Row',
    table: 'm',
    primaryKey: 'id',
    attributes: { id: { validation: { rule: {} } }, s: { validation: { rule: {} } } },
  },
} as any)

const sqlOf = (build: (q: any) => any): string =>
  String(build(createQueryBuilder<typeof schema>({ schema }).selectFrom('m').selectAll()).toSQL())

describe('empty collections emit a constant predicate (#1083)', () => {
  it('whereIn with an empty list matches nothing instead of emitting IN ()', () => {
    const sql = sqlOf(q => q.whereIn('id', []))

    expect(sql).not.toContain('IN ()')
    expect(sql).toContain('1 = 0')
  })

  it('whereNotIn with an empty list matches everything', () => {
    // THE TRAP. Excluding nothing excludes nothing — this must be TRUE.
    // `1 = 0` here would silently return zero rows whenever an exclusion list
    // came back empty.
    const sql = sqlOf(q => q.whereNotIn('id', []))

    expect(sql).toContain('1 = 1')
    expect(sql).not.toContain('1 = 0')
  })

  it('whereAny with no columns matches nothing instead of vanishing', () => {
    const sql = sqlOf(q => q.where('s', '=', 'p').whereAny([], 'like', '%x%'))

    expect(sql).toContain('1 = 0')
    // The earlier filter must survive alongside it.
    expect(sql).toContain('s = ')
  })

  it('whereAll and whereNone with no columns stay no-ops', () => {
    // TRUE genuinely is their identity, so dropping the term is correct here.
    // The asymmetry with whereAny is deliberate.
    const baseline = sqlOf(q => q.where('s', '=', 'p'))

    expect(sqlOf(q => q.where('s', '=', 'p').whereAll([], 'like', '%x%'))).toBe(baseline)
    expect(sqlOf(q => q.where('s', '=', 'p').whereNone([], 'like', '%x%'))).toBe(baseline)
  })

  it('leaves a non-empty IN untouched', () => {
    const sql = sqlOf(q => q.whereIn('id', [1, 2, 3]))

    expect(sql).toContain('IN (')
    expect(sql).not.toContain('1 = 0')
  })
})
