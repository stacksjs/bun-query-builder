/**
 * Coverage for generalized window functions (stacksjs/bun-query-builder#1050):
 * over/lag/lead/sumOver/avgOver/countOver/min-maxOver/first-lastValue.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb() {
  const models = { sales: { columns: { id: { type: 'integer', isPrimaryKey: true }, region: { type: 'string' }, amount: { type: 'integer' } } } } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

describe('window functions (#1050)', () => {
  it('sumOver emits SUM(...) OVER (PARTITION BY ...) aliased', () => {
    const sql = String((qb() as any).selectFrom('sales')
      .sumOver('amount', { partitionBy: 'region', alias: 'region_total' }).toSQL())
    expect(sql).toContain('SUM(amount) OVER (PARTITION BY region) AS region_total')
  })

  it('lag/lead include offset, default alias, and ORDER BY', () => {
    const lag = String((qb() as any).selectFrom('sales').lag('amount', { offset: 2, orderBy: [['id', 'asc']] }).toSQL())
    expect(lag).toContain('LAG(amount, 2) OVER (ORDER BY id ASC) AS amount_lag')
    const lead = String((qb() as any).selectFrom('sales').lead('amount', { defaultValue: 0 }).toSQL())
    expect(lead).toContain('LEAD(amount, 1, 0) OVER () AS amount_lead')
  })

  it('avgOver/countOver/minOver/maxOver/first-lastValue', () => {
    expect(String((qb() as any).selectFrom('sales').avgOver('amount').toSQL())).toContain('AVG(amount) OVER ()')
    expect(String((qb() as any).selectFrom('sales').countOver().toSQL())).toContain('COUNT(*) OVER () AS count_over')
    expect(String((qb() as any).selectFrom('sales').maxOver('amount', { partitionBy: ['region'] }).toSQL())).toContain('MAX(amount) OVER (PARTITION BY region)')
    expect(String((qb() as any).selectFrom('sales').firstValue('amount', { orderBy: [['id', 'desc']] }).toSQL())).toContain('FIRST_VALUE(amount) OVER (ORDER BY id DESC)')
  })

  it('over() is a generic escape hatch', () => {
    const sql = String((qb() as any).selectFrom('sales')
      .over('NTILE(4)', 'quartile', { orderBy: [['amount', 'desc']] }).toSQL())
    expect(sql).toContain('NTILE(4) OVER (ORDER BY amount DESC) AS quartile')
  })
})
