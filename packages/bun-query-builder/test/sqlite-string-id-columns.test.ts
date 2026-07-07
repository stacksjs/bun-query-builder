/**
 * Regression test: the `_id` INTEGER safety net must not trample declared
 * string ids.
 *
 * The SQLite driver forces `*_id` columns to INTEGER so float storage can't
 * corrupt numeric foreign keys (11.0 instead of 11). But external ids are
 * frequently strings — Kalshi tickers, wallet addresses, transaction hashes,
 * ULIDs — and the unconditional coercion rendered `external_id TEXT` plans
 * as INTEGER columns. Worse, `canonicalStorageType` mirrored the coercion,
 * so a correct TEXT column in the live database diffed as "type changed"
 * against its own model on every `migrate` run (permanent destructive
 * rebuild warnings).
 */

import { describe, expect, it } from 'bun:test'
import { SQLiteDriver, isNumericPlanType } from '../src/drivers/sqlite'
import { canonicalStorageType } from '../src/migrations'
import type { ColumnPlan, TablePlan } from '../src/migrations'

function col(name: string, type: string): ColumnPlan {
  return { name, type: type as any, isPrimaryKey: false, isUnique: false, isNullable: true, hasDefault: false }
}

describe('isNumericPlanType', () => {
  it('accepts the numeric family', () => {
    for (const t of ['integer', 'bigint', 'float', 'double', 'decimal'])
      expect(isNumericPlanType(t)).toBe(true)
  })

  it('rejects textual and structured types', () => {
    for (const t of ['string', 'text', 'json', 'enum', 'date', 'datetime', 'boolean', undefined])
      expect(isNumericPlanType(t as any)).toBe(false)
  })
})

describe('SQLiteDriver — _id column rendering', () => {
  const driver = new SQLiteDriver()

  function createSql(columns: ColumnPlan[]): string {
    const table: TablePlan = { table: 't', columns, indexes: [] }
    return driver.createTable(table)
  }

  it('keeps declared string _id columns as TEXT', () => {
    const sql = createSql([col('external_id', 'string')])
    expect(sql).toContain('"external_id" TEXT')
  })

  it('keeps declared text _id columns as TEXT', () => {
    const sql = createSql([col('condition_id', 'text')])
    expect(sql).toContain('"condition_id" TEXT')
  })

  it('still coerces numeric _id columns to INTEGER', () => {
    const sql = createSql([col('user_id', 'float'), col('order_id', 'bigint')])
    expect(sql).toContain('"user_id" INTEGER')
    expect(sql).toContain('"order_id" INTEGER')
  })
})

describe('canonicalStorageType — _id columns on sqlite', () => {
  it('string _id columns canonicalize to TEXT (matches the driver)', () => {
    expect(canonicalStorageType(col('external_id', 'string'), 'sqlite')).toBe('TEXT')
  })

  it('numeric _id columns canonicalize to INTEGER (matches the driver)', () => {
    expect(canonicalStorageType(col('user_id', 'float'), 'sqlite')).toBe('INTEGER')
    expect(canonicalStorageType(col('user_id', 'bigint'), 'sqlite')).toBe('INTEGER')
  })

  it('a TEXT external_id introspected from the live DB no longer diffs against its own model', () => {
    // The introspected live column and the model column must agree — this is
    // the exact drift that flagged tables for destructive rebuilds.
    const model = col('external_id', 'string')
    const live = col('external_id', 'text')
    expect(canonicalStorageType(model, 'sqlite')).toBe(canonicalStorageType(live, 'sqlite'))
  })
})
