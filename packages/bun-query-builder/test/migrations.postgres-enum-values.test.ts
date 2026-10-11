/**
 * Changing an enum's values on Postgres actually changes the type.
 *
 * A Postgres enum is a named type, and an existing column's change was
 * rendered as `ALTER COLUMN ... TYPE "<t>_<c>_type"` - a cast to the type the
 * column already had. Nothing ever added the new value, so the first insert
 * using it failed with `invalid input value for enum`, after a migration that
 * had reported success.
 *
 * Added values are now `ALTER TYPE ... ADD VALUE IF NOT EXISTS`, in a file of
 * their own ahead of the table's alter file (a value added in a transaction
 * cannot be used until it commits). Removed values rebuild the type.
 */
import type { ColumnPlan, MigrationPlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { PostgresDriver } from '../src/drivers/postgres'
import { generateDiffOperations, generateDiffSql } from '../src/migrations'

function plan(dialect: 'postgres' | 'mysql' | 'sqlite', values: string[], extra: Partial<ColumnPlan> = {}): MigrationPlan {
  return {
    dialect,
    tables: [{
      table: 'bookings',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        { name: 'status', type: 'enum', enumValues: values, enumTypeName: 'bookings_status_type', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false, ...extra },
      ],
      indexes: [],
    }],
  }
}

describe('adding enum values on postgres', () => {
  it('emits ADD VALUE IF NOT EXISTS per new value, and no column retype', () => {
    const { operations, statements, files } = generateDiffOperations(
      plan('postgres', ['booked', 'cancelled']),
      plan('postgres', ['booked', 'cancelled', 'no_show', 'attended']),
    )
    expect(operations.map(op => op.kind)).toEqual(['add_enum_value'])
    expect(operations[0].destructive).toBe(false)
    expect(statements).toEqual([
      `ALTER TYPE "bookings_status_type" ADD VALUE IF NOT EXISTS 'no_show';\nALTER TYPE "bookings_status_type" ADD VALUE IF NOT EXISTS 'attended';`,
    ])
    expect(statements.join('\n')).not.toContain('ALTER COLUMN')
    expect(files.map(f => f.name)).toEqual(['alter-bookings_status_type-enum'])
  })

  it('puts the ADD VALUE in its own file ahead of the table change that uses the value', () => {
    const { files } = generateDiffOperations(
      plan('postgres', ['booked']),
      plan('postgres', ['booked', 'pending'], { hasDefault: true, defaultValue: 'pending' }),
    )
    expect(files.map(f => f.name)).toEqual(['alter-bookings_status_type-enum', 'alter-bookings-table'])
    expect(files[0].sql).toBe(`ALTER TYPE "bookings_status_type" ADD VALUE IF NOT EXISTS 'pending';`)
    expect(files[1].sql).toBe(`ALTER TABLE "bookings" ALTER COLUMN "status" SET default 'pending';`)
  })

  it('escapes quotes in values', () => {
    expect(new PostgresDriver().addEnumValues('t', ['it\'s'])).toBe(`ALTER TYPE "t" ADD VALUE IF NOT EXISTS 'it''s';`)
  })

  it('reordering values alone is not a change', () => {
    expect(generateDiffOperations(plan('postgres', ['a', 'b']), plan('postgres', ['b', 'a'])).operations).toEqual([])
  })
})

describe('removing enum values on postgres', () => {
  it('rebuilds the type and casts the column across, flagged destructive', () => {
    const { operations } = generateDiffOperations(plan('postgres', ['booked', 'legacy']), plan('postgres', ['booked', 'attended']))
    const change = operations.find(op => op.kind === 'modify_column')!
    expect(change.destructive).toBe(true)
    expect(change.sql.split('\n')).toEqual([
      `ALTER TYPE "bookings_status_type" RENAME TO "bookings_status_type__qb_old";`,
      `CREATE TYPE "bookings_status_type" AS ENUM ('booked', 'attended');`,
      `ALTER TABLE "bookings" ALTER COLUMN "status" DROP DEFAULT;`,
      `ALTER TABLE "bookings" ALTER COLUMN "status" TYPE "bookings_status_type" USING "status"::text::"bookings_status_type";`,
      `ALTER TABLE "bookings" ALTER COLUMN "status" SET NOT NULL;`,
      `DROP TYPE "bookings_status_type__qb_old";`,
    ])
  })
})

describe('turning an existing column into an enum', () => {
  it('creates the type the column change names', () => {
    const before = plan('postgres', [])
    before.tables[0].columns[1] = { name: 'status', type: 'string', isPrimaryKey: false, isUnique: false, isNullable: false, hasDefault: false }
    const sql = generateDiffSql(before, plan('postgres', ['booked'])).join('\n')
    expect(sql).toContain(`CREATE TYPE "bookings_status_type" AS ENUM ('booked');`)
    expect(sql.indexOf('CREATE TYPE')).toBeLessThan(sql.indexOf('ALTER COLUMN "status" TYPE "bookings_status_type"'))
  })
})

describe('dialects with inline enums are unchanged', () => {
  it('mysql restates the column with the new ENUM(...)', () => {
    const { operations } = generateDiffOperations(plan('mysql', ['a']), plan('mysql', ['a', 'b']))
    expect(operations.map(op => op.kind)).toEqual(['modify_column'])
    expect(operations[0].sql).toContain('ENUM(\'a\', \'b\')')
  })
})
