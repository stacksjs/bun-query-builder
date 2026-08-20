/**
 * MySQL's `MODIFY COLUMN` restates the whole definition, so anything the new
 * definition leaves out is dropped.
 *
 * That is normally the convenient half - one statement changes type,
 * nullability and default together, which is why the Postgres driver needs
 * three and this one needs one. It is also a trap on a primary key: a modify
 * that does not repeat `auto_increment` removes it. The column keeps its type
 * and keeps being the primary key, and the table quietly stops generating ids.
 *
 * The first insert afterwards fails with `Field 'id' doesn't have a default
 * value`, a long way from the migration that caused it - which reported
 * success, because it did exactly what it was asked. A drift repair as small as
 * `MODIFY COLUMN id bigint` disabled password resets on an application whose
 * schema was otherwise right.
 */

import type { ColumnPlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { getDialectDriver } from '../src/drivers'

function column(over: Partial<ColumnPlan> = {}): ColumnPlan {
  return {
    name: 'id',
    type: 'bigint',
    isPrimaryKey: true,
    isUnique: false,
    isNullable: false,
    hasDefault: false,
    ...over,
  }
}

describe('mysql modifyColumn', () => {
  const mysql = getDialectDriver('mysql')

  it('keeps auto_increment on an integer primary key', () => {
    const sql = mysql.modifyColumn('password_resets', column({ type: 'integer' }))

    expect(sql).toContain('MODIFY COLUMN `id` integer auto_increment')
  })

  it('and on a bigint one', () => {
    const sql = mysql.modifyColumn('password_resets', column())

    expect(sql).toContain('auto_increment')
  })

  it('matches what the same column is given at create time', () => {
    // The two statements describe one column. They disagreed: `createTable`
    // emitted `auto_increment` and `modifyColumn` did not, so a table was
    // correct until the first time anything modified its key.
    const plan = column()
    const created = mysql.createTable({ table: 'password_resets', columns: [plan], indexes: [] })
    const modified = mysql.modifyColumn('password_resets', plan)

    expect(created.includes('auto_increment')).toBe(modified.includes('auto_increment'))
  })

  it('leaves an ordinary column alone', () => {
    // Only a primary key of an integral type auto-increments; adding the
    // clause anywhere else would be a syntax error rather than a repair.
    const sql = mysql.modifyColumn('issues', column({ name: 'author_id', isPrimaryKey: false }))

    expect(sql).not.toContain('auto_increment')
  })

  it('and a primary key that cannot carry one', () => {
    const sql = mysql.modifyColumn('sessions', column({ name: 'token', type: 'string' }))

    expect(sql).not.toContain('auto_increment')
  })
})
