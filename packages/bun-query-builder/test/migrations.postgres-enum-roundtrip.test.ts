/**
 * An enum column introspected out of Postgres and compared against the model it
 * came from must produce no change.
 *
 * Postgres reports an enum column as `data_type = 'USER-DEFINED'`, with the
 * type name in `udt_name` and the values nowhere in `information_schema` at
 * all. Introspection used to normalize that to `string`, so a schema that was
 * already exactly right came back as one `modify_column` per enum column, on
 * every run. In an application with a few dozen enums that is seventy-five
 * "possible data loss" operations, and `migrate` refuses to apply destructive
 * changes without `--force` - so a correct schema became one that could not be
 * migrated at all.
 *
 * The catalogue lookup that fixes it needs a live Postgres, so what is pinned
 * here is the property that made the bug visible: given the values, the two
 * sides compare equal, and no `--force` is needed to change nothing.
 */

import type { MigrationPlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { pgColumnType, sqlTypeToNormalized } from '../src/actions/introspect-db'
import { generateDiffOperations } from '../src/migrations'

function planWith(column: Record<string, unknown>): MigrationPlan {
  return {
    dialect: 'postgres',
    tables: [{
      table: 'issues',
      columns: [
        { name: 'id', type: 'bigint', isPrimaryKey: true, isUnique: false, isNullable: false, hasDefault: false },
        column as any,
      ],
      indexes: [],
    }],
  } as MigrationPlan
}

const modelSide = {
  name: 'state',
  type: 'enum',
  enumValues: ['open', 'closed'],
  isPrimaryKey: false,
  isUnique: false,
  isNullable: true,
  hasDefault: true,
  defaultValue: 'open',
}

describe('sqlTypeToNormalized on a Postgres enum', () => {
  it('is an enum when the values are known', () => {
    expect(sqlTypeToNormalized('USER-DEFINED', 'postgres', { enumValues: ['open', 'closed'] })).toBe('enum')
  })

  /**
   * What the bug was. `USER-DEFINED` on its own carries no hint that the column
   * is an enum, so without the catalogue lookup it lands in the fallback.
   */
  it('is not an enum without them, which is why the values have to be read', () => {
    expect(sqlTypeToNormalized('USER-DEFINED', 'postgres')).not.toBe('enum')
  })
})

describe('pgColumnType', () => {
  const enums = new Map([['issues_state_type', ['open', 'closed']]])

  it('recovers the enum from the catalogue, values and type name included', () => {
    expect(pgColumnType('USER-DEFINED', 'issues_state_type', enums)).toEqual({
      type: 'enum',
      enumValues: ['open', 'closed'],
      enumTypeName: 'issues_state_type',
    })
  })

  it('leaves an ordinary column alone', () => {
    expect(pgColumnType('character varying', 'varchar', enums)).toEqual({ type: 'string' })
    expect(pgColumnType('bigint', 'int8', enums)).toEqual({ type: 'bigint' })
  })

  /**
   * A user-defined type that is not an enum - a composite, a domain, PostGIS -
   * has no labels, and must not be claimed as an enum on the strength of its
   * `data_type` alone.
   */
  it('does not claim a user-defined type it has no labels for', () => {
    expect(pgColumnType('USER-DEFINED', 'geometry', enums).type).not.toBe('enum')
    expect(pgColumnType('USER-DEFINED', 'geometry', enums).enumValues).toBeUndefined()
  })
})

describe('reconciling an introspected enum against its model', () => {
  it('proposes nothing when the values match', () => {
    const introspected = planWith({
      ...modelSide,
      enumTypeName: 'issues_state_type',
      // Postgres reports the default with its cast, and in catalogue order
      // rather than the model's.
      defaultValue: '\'open\'::issues_state_type',
      enumValues: ['closed', 'open'],
    })

    const result = generateDiffOperations(introspected, planWith(modelSide))

    expect(result.operations.filter(op => op.kind === 'modify_column')).toEqual([])
  })

  it('still proposes a change when a value was actually added', () => {
    const introspected = planWith({ ...modelSide, enumValues: ['open'] })

    const result = generateDiffOperations(introspected, planWith(modelSide))

    expect(result.operations.some(op => op.kind === 'modify_column' && op.column === 'state')).toBe(true)
  })

  /** The one that stopped `migrate` running at all. */
  it('does not report a destructive change for a schema that already matches', () => {
    const introspected = planWith({ ...modelSide, enumValues: ['closed', 'open'], enumTypeName: 'issues_state_type' })

    const result = generateDiffOperations(introspected, planWith(modelSide))

    expect(result.operations.filter(op => op.destructive)).toEqual([])
  })
})
