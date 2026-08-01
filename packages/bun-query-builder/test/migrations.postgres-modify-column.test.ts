/**
 * Changing a column's nullability or default has to reach the database.
 *
 * Postgres needs one ALTER per facet, and only the type one was emitted. So a
 * model that dropped `.required()` from a column generated a migration that ran
 * cleanly, recorded itself as applied, and changed nothing - the column stayed
 * NOT NULL, every insert with a null still failed, and the next diff proposed
 * the identical no-op forever.
 *
 * MySQL never had this: `MODIFY COLUMN` restates the whole definition at once.
 */

import type { ColumnPlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { getDialectDriver } from '../src/drivers'

function column(over: Partial<ColumnPlan> = {}): ColumnPlan {
  return {
    name: 'author_id',
    type: 'integer',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    hasDefault: false,
    ...over,
  }
}

describe('postgres modifyColumn', () => {
  const pg = getDialectDriver('postgres')

  it('drops NOT NULL when the model made the column optional', () => {
    const sql = pg.modifyColumn('issues', column({ isNullable: true }))

    expect(sql).toContain('ALTER COLUMN "author_id" DROP NOT NULL')
  })

  it('sets NOT NULL when the model made the column required', () => {
    const sql = pg.modifyColumn('issues', column({ isNullable: false }))

    expect(sql).toContain('ALTER COLUMN "author_id" SET NOT NULL')
  })

  it('still changes the type, which is what it always did', () => {
    const sql = pg.modifyColumn('issues', column({ type: 'bigint' }))

    expect(sql).toContain('TYPE bigint')
  })

  it('sets a default the model declares', () => {
    const sql = pg.modifyColumn('issues', column({ hasDefault: true, defaultValue: 0 as any }))

    expect(sql).toContain('SET default 0')
  })

  /**
   * Dropping a default has to be stated. Leaving the old one in place means the
   * database keeps writing a value the model no longer asks for, which is the
   * same silent disagreement in the other direction.
   */
  it('drops a default the model no longer declares', () => {
    const sql = pg.modifyColumn('issues', column({ hasDefault: false }))

    expect(sql).toContain('DROP DEFAULT')
  })

  /**
   * A primary key already carries NOT NULL through its constraint, and
   * restating it here fights with that.
   */
  it('leaves a primary key nullability alone', () => {
    const sql = pg.modifyColumn('issues', column({ name: 'id', isPrimaryKey: true, isNullable: false }))

    expect(sql).not.toContain('NOT NULL')
  })
})

describe('mysql modifyColumn keeps carrying nullability', () => {
  it('states not null in the restated definition', () => {
    const sql = getDialectDriver('mysql').modifyColumn('issues', column({ isNullable: false }))

    expect(sql.toLowerCase()).toContain('not null')
  })

  it('omits it when the column is optional', () => {
    const sql = getDialectDriver('mysql').modifyColumn('issues', column({ isNullable: true }))

    expect(sql.toLowerCase()).not.toContain('not null')
  })
})
