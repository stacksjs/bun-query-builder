/**
 * Regression coverage for stacksjs/bun-query-builder#1034.
 *
 * Each having() emitted a fresh HAVING keyword, so two calls produced
 * `HAVING a HAVING b` — invalid. Chained calls now join with AND.
 */

import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

function qb() {
  const models = { sales: { columns: { id: { type: 'integer', isPrimaryKey: true }, amount: { type: 'integer' } } } } as any
  return createQueryBuilder<ReturnType<typeof buildDatabaseSchema>>({
    schema: buildDatabaseSchema(models),
    meta: buildSchemaMeta(models),
    autoMigration: { enabled: false } as any,
  })
}

describe('chained having() (#1034)', () => {
  it('joins two having() calls with AND, single HAVING keyword', () => {
    const sql = String((qb() as any).selectFrom('sales')
      .groupBy('id')
      .having(['COUNT(id)', '>', 3])
      .having(['SUM(amount)', '<', 100])
      .toSQL())
    expect((sql.match(/HAVING/gi) || []).length).toBe(1)
    expect(sql).toMatch(/HAVING COUNT\(id\) > .+ AND SUM\(amount\) < /)
  })

  it('raw-form having() after an array having() also uses AND (single HAVING)', () => {
    const sql = String((qb() as any).selectFrom('sales')
      .groupBy('id')
      .having(['COUNT(id)', '>', 3])
      .having({ raw: 'SUM(amount) < 100' })
      .toSQL())
    expect((sql.match(/HAVING/gi) || []).length).toBe(1)
    expect(sql).toContain('AND SUM(amount) < 100')
  })
})
