/**
 * A column change writes only the facets that changed, when the differ knows
 * what the column was.
 *
 * Postgres restated type, nullability and default for every modified column.
 * In effect that is harmless; in cost it is not: `ALTER COLUMN ... TYPE` takes
 * an ACCESS EXCLUSIVE lock even when the type is unchanged. When the managed
 * `created_at` default moved from CURRENT_TIMESTAMP to the UTC clock, every
 * table with timestamps got a full retype — seven of an app's largest tables
 * locked in turn during a deploy, to change a default.
 */

import type { ColumnPlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { PostgresDriver } from '../src/drivers/postgres'
import { generateDiffOperations, UTC_CLOCK_DEFAULT } from '../src/migrations'

const driver = new PostgresDriver()

const createdAt = (defaultValue: string): ColumnPlan => ({
  name: 'created_at',
  type: 'datetime',
  isPrimaryKey: false,
  isUnique: false,
  isNullable: false,
  hasDefault: true,
  defaultValue,
})

const lines = (sql: string): string[] => sql.split('\n').map(l => l.trim()).filter(Boolean)

describe('PostgresDriver.modifyColumn with the previous column', () => {
  it('changes only the default when only the default changed', () => {
    const sql = lines(driver.modifyColumn('page_views', createdAt(UTC_CLOCK_DEFAULT), createdAt('CURRENT_TIMESTAMP')))
    expect(sql).toEqual([`ALTER TABLE "page_views" ALTER COLUMN "created_at" SET default (now() AT TIME ZONE 'utc');`])
  })

  it('changes only nullability when only nullability changed', () => {
    const before = { ...createdAt(UTC_CLOCK_DEFAULT), isNullable: true }
    const sql = lines(driver.modifyColumn('page_views', createdAt(UTC_CLOCK_DEFAULT), before))
    expect(sql).toEqual([`ALTER TABLE "page_views" ALTER COLUMN "created_at" SET NOT NULL;`])
  })

  it('drops a default the model no longer declares', () => {
    const now = { ...createdAt(UTC_CLOCK_DEFAULT), hasDefault: false, defaultValue: undefined }
    expect(lines(driver.modifyColumn('t', now, createdAt(UTC_CLOCK_DEFAULT)))).toEqual([`ALTER TABLE "t" ALTER COLUMN "created_at" DROP DEFAULT;`])
  })

  it('still restates everything when the type changes', () => {
    const text: ColumnPlan = { name: 'type', type: 'text', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false }
    const sql = lines(driver.modifyColumn('subscriptions', { ...text, type: 'string', maxLength: 512 } as ColumnPlan, text))
    expect(sql.some(l => l.includes('TYPE varchar(512)'))).toBe(true)
    expect(sql.some(l => l.includes('DROP DEFAULT'))).toBe(true)
  })

  it('still restates everything with no previous column to compare', () => {
    const sql = lines(driver.modifyColumn('page_views', createdAt(UTC_CLOCK_DEFAULT)))
    expect(sql.some(l => l.includes(' TYPE '))).toBe(true)
  })

  it('reaches the driver through the differ', () => {
    const plan = (defaultValue: string) => ({
      dialect: 'postgres' as const,
      tables: [{ table: 'sites', columns: [
        { name: 'id', type: 'string' as const, isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        createdAt(defaultValue),
      ], indexes: [] }],
    })
    const { operations } = generateDiffOperations(plan('CURRENT_TIMESTAMP') as any, plan(UTC_CLOCK_DEFAULT) as any)
    const change = operations.find(op => op.kind === 'modify_column')
    expect(change?.destructive).toBe(false)
    expect(lines(change!.sql)).toEqual([`ALTER TABLE "sites" ALTER COLUMN "created_at" SET default (now() AT TIME ZONE 'utc');`])
  })
})
