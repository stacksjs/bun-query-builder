/**
 * Window-function identifier injection — stacksjs/bun-query-builder#1185.
 *
 * #1183 validated the SELECT / FROM / ORDER BY / GROUP BY family and did not
 * reach `buildOverClause` or `addWindowFunction`, which interpolated all four
 * of their inputs raw. Verified against live Postgres before the fix:
 *
 *   sumOver('amount', { partitionBy: 'team_id) AS x, (SELECT secret FROM t LIMIT 1' })
 *   -> {"amount_sum": "hunter2"}
 *
 * The payload closes the PARTITION BY parenthesis and opens a subquery, so it
 * exfiltrates without a stacked statement and works wherever the driver
 * refuses multiple statements.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb(): any {
  const models = {
    users: {
      columns: {
        id: { type: 'integer', isPrimaryKey: true },
        team_id: { type: 'integer' },
        amount: { type: 'integer' },
      },
    },
  } as any
  return createQueryBuilder<any>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

const EXFIL = 'team_id) AS x, (SELECT secret FROM users LIMIT 1'
const STACKED = 'id; DROP TABLE users; --'
const REFUSED = /is not a plain column reference/

describe('window functions refuse injected identifiers (#1185)', () => {
  it('partitionBy, the vector proven against a live database', () => {
    expect(() => qb().selectFrom('users').sumOver('amount', { partitionBy: EXFIL })).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').lag('amount', { partitionBy: EXFIL })).toThrow(REFUSED)
  })

  it('orderBy, column and alias are the other three', () => {
    expect(() => qb().selectFrom('users').sumOver('amount', { orderBy: [[STACKED, 'asc']] })).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').sumOver(STACKED, {})).toThrow(REFUSED)
    expect(() => qb().selectFrom('users').sumOver('amount', { alias: STACKED })).toThrow(REFUSED)
  })

  it('every convenience method, not just sumOver', () => {
    const each = (fn: string) => () => (qb().selectFrom('users') as any)[fn]('amount', { partitionBy: EXFIL })
    for (const fn of ['avgOver', 'countOver', 'minOver', 'maxOver', 'firstValue', 'lastValue', 'lead'])
      expect(each(fn)).toThrow(REFUSED)
  })

  it('COUNT(*) is still allowed, and only for COUNT', () => {
    // The canonical window count. SUM(*) and AVG(*) are not valid SQL, so the
    // star is permitted here and refused everywhere else - caught by the
    // existing #1050 suite when the first pass of this fix rejected it.
    expect(String(qb().selectFrom('users').countOver('*').toSQL())).toContain('COUNT(*)')
    expect(() => qb().selectFrom('users').sumOver('*', {})).toThrow(REFUSED)
  })

  it('over() still validates partitionBy, though its expression stays raw', () => {
    // The expression is the documented escape hatch, same contract as `raw`.
    // partitionBy is not, and was injectable through it too.
    expect(() => qb().selectFrom('users').over('ROW_NUMBER()', 'rn', { partitionBy: EXFIL })).toThrow(REFUSED)
  })
})

describe('legitimate window usage is unaffected (#1185)', () => {
  it('builds the clause it always did', () => {
    const sum = String(qb().selectFrom('users').sumOver('amount', { partitionBy: 'team_id', orderBy: [['id', 'desc']] }).toSQL())
    expect(sum).toContain('SUM(amount) OVER (PARTITION BY team_id ORDER BY id DESC)')

    // An array partitionBy, and an offset that is a number rather than a column.
    const lag = String(qb().selectFrom('users').lag('amount', { offset: 2, partitionBy: ['team_id', 'id'] }).toSQL())
    expect(lag).toContain('LAG(amount, 2) OVER (PARTITION BY team_id, id)')

    // over()'s expression is not a column reference and must stay raw.
    const over = String(qb().selectFrom('users').over('ROW_NUMBER()', 'rn', { partitionBy: 'team_id' }).toSQL())
    expect(over).toContain('ROW_NUMBER() OVER (PARTITION BY team_id) AS rn')
  })
})
