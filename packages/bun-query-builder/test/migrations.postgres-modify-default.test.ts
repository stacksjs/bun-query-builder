/**
 * Changing a column's type when it already has a default.
 *
 * Postgres checks the existing default against the new type and refuses the
 * whole statement when it cannot cast it. Turning a `varchar` column that
 * defaults to `'pending'` into an enum fails with "default for column cannot be
 * cast automatically", naming the type rather than the default - which is the
 * part that actually has to move first.
 *
 * The column was then left as it was, so the same migration was proposed again
 * on the next run, and the run before that, indefinitely.
 */

import { describe, expect, it } from 'bun:test'
import { PostgresDriver } from '../src/drivers/postgres'

const driver = new PostgresDriver()

function column(overrides: Record<string, any> = {}) {
  return {
    name: 'status',
    type: 'string',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    hasDefault: false,
    ...overrides,
  } as any
}

function lines(sql: string): string[] {
  return sql.split('\n').map(line => line.trim()).filter(Boolean)
}

describe('PostgresDriver.modifyColumn', () => {
  it('drops the default before changing the type', () => {
    const emitted = lines(driver.modifyColumn('notification_deliveries', column({ hasDefault: true, defaultValue: 'pending' })))

    const dropIndex = emitted.findIndex(line => line.includes('DROP DEFAULT'))
    const typeIndex = emitted.findIndex(line => line.includes('TYPE'))

    expect(dropIndex).toBeGreaterThanOrEqual(0)
    expect(dropIndex).toBeLessThan(typeIndex)
  })

  it('sets the new default after the type has changed', () => {
    const emitted = lines(driver.modifyColumn('t', column({ hasDefault: true, defaultValue: 'pending' })))

    const typeIndex = emitted.findIndex(line => line.includes('TYPE'))
    const setIndex = emitted.findIndex(line => line.includes('SET default') || line.includes('SET DEFAULT'))

    expect(setIndex).toBeGreaterThan(typeIndex)
  })

  /** No default in the model means the column ends up with none, as before. */
  it('leaves a column with no default without one', () => {
    const emitted = lines(driver.modifyColumn('t', column()))

    expect(emitted.filter(line => line.includes('DROP DEFAULT'))).toHaveLength(1)
    expect(emitted.some(line => /SET\s+default/i.test(line))).toBe(false)
  })

  it('still emits the nullability change', () => {
    const emitted = lines(driver.modifyColumn('t', column({ isNullable: true })))

    expect(emitted.some(line => line.includes('DROP NOT NULL'))).toBe(true)
  })

  /** A primary key carries NOT NULL through the constraint; saying it again fights with it. */
  it('says nothing about nullability for a primary key', () => {
    const emitted = lines(driver.modifyColumn('t', column({ isPrimaryKey: true })))

    expect(emitted.some(line => line.includes('NOT NULL'))).toBe(false)
  })

  it('drops the default exactly once even when a new one is set', () => {
    const emitted = lines(driver.modifyColumn('t', column({ hasDefault: true, defaultValue: 'x' })))

    expect(emitted.filter(line => line.includes('DROP DEFAULT'))).toHaveLength(1)
  })

  /** The order is the whole point, so assert the shape end to end. */
  it('emits drop, type, nullability, set - in that order', () => {
    const emitted = lines(driver.modifyColumn('t', column({ hasDefault: true, defaultValue: 'x' })))

    expect(emitted).toHaveLength(4)
    expect(emitted[0]).toContain('DROP DEFAULT')
    expect(emitted[1]).toContain('TYPE')
    expect(emitted[2]).toContain('NOT NULL')
    expect(emitted[3]).toMatch(/SET\s+default/i)
  })
})
