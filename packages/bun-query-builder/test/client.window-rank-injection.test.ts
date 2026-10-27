/**
 * Identifier injection on rowNumber / denseRank / rank — the three window
 * functions #1185 did not reach.
 *
 * #1185 routed the window family through `buildOverClause`, which validates
 * both halves of the OVER clause, and `addWindowFunction`, which validates the
 * alias. These three predate those helpers and built the clause by hand, so
 * they kept interpolating all three slots raw. Measured before the fix:
 *
 *   rowNumber('rn', 'id) OVER () , (SELECT token FROM secrets LIMIT 1')
 *   SELECT *, ROW_NUMBER() OVER (PARTITION BY id) OVER () ,
 *     (SELECT token FROM secrets LIMIT 1) AS rn FROM users
 *
 *   rowNumber('rn', 'team', [['id) OVER () , (SELECT token FROM secrets LIMIT 1', 'asc']])
 *   SELECT *, ROW_NUMBER() OVER (PARTITION BY team ORDER BY id) OVER () ,
 *     (SELECT token FROM secrets LIMIT 1 ASC) AS rn FROM users
 *
 * The subquery is projected as a selected column, so no stacked statement is
 * needed and it works wherever the driver refuses multiple statements — the
 * same shape as #1185's own `sumOver` reproduction.
 *
 * The fix shares `buildOverClause` rather than repeating its validation a
 * fourth time. Every legitimate form below emits byte-identical SQL to what it
 * did before, which was checked by diffing the two.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb(): any {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        name: { type: 'text' },
        team: { type: 'text' },
      },
    },
  } as any
  return createQueryBuilder<any>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

const REFUSED = /is not a plain column reference/
const PAYLOAD = 'id) OVER () , (SELECT token FROM secrets LIMIT 1'

describe('rowNumber/denseRank/rank refuse an injected partitionBy', () => {
  it('each of the three', () => {
    expect(() => qb().selectFrom('users').rowNumber('rn', PAYLOAD)).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').denseRank('dr', PAYLOAD)).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').rank('rk', PAYLOAD)).toThrow(REFUSED)
  })

  it('inside the array form, where only one element is hostile', () => {
    // The array spelling joins its elements, so a single bad entry among
    // good ones is the realistic shape.
    expect(() => qb().selectFrom('users').rowNumber('rn', ['team', PAYLOAD])).toThrow(REFUSED)
  })
})

describe('rowNumber/denseRank/rank refuse an injected alias', () => {
  it('the slot after AS', () => {
    expect(() => qb().selectFrom('users').rowNumber(PAYLOAD, 'team')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').denseRank(PAYLOAD, 'team')).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').rank(PAYLOAD, 'team')).toThrow(REFUSED)
  })
})

describe('rowNumber/denseRank/rank refuse an injected orderBy column', () => {
  it('the column half of the tuple', () => {
    // The direction half is mapped through a ternary and cannot carry a
    // payload; the column half was interpolated raw.
    expect(() => qb().selectFrom('users').rowNumber('rn', 'team', [[PAYLOAD, 'asc']])).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').denseRank('dr', 'team', [[PAYLOAD, 'desc']])).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').rank('rk', 'team', [[PAYLOAD, 'asc']])).toThrow(REFUSED)
  })
})

describe('legitimate window SQL is unchanged', () => {
  it('the default, with no arguments at all', () => {
    expect(String(qb().selectFrom('users').rowNumber().toSQL()))
      .toContain('ROW_NUMBER() OVER () AS row_number')
  })

  it('a single partition column', () => {
    expect(String(qb().selectFrom('users').rowNumber('rn', 'team').toSQL()))
      .toContain('ROW_NUMBER() OVER (PARTITION BY team) AS rn')
  })

  it('several partition columns and an ordering', () => {
    expect(String(qb().selectFrom('users').rowNumber('rn', ['team', 'id'], [['name', 'desc']]).toSQL()))
      .toContain('ROW_NUMBER() OVER (PARTITION BY team, id ORDER BY name DESC) AS rn')
  })

  it('denseRank and rank keep their own function names', () => {
    expect(String(qb().selectFrom('users').denseRank('dr', 'team', [['id', 'asc']]).toSQL()))
      .toContain('DENSE_RANK() OVER (PARTITION BY team ORDER BY id ASC) AS dr')
    expect(String(qb().selectFrom('users').rank('rk', 'team').toSQL()))
      .toContain('RANK() OVER (PARTITION BY team) AS rk')
  })

  it('a qualified partition column still works', () => {
    expect(String(qb().selectFrom('users').rank('rk', 'users.team').toSQL()))
      .toContain('PARTITION BY users.team')
  })
})
