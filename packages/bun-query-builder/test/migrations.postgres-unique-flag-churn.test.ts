/**
 * A column's unique flag is not something an ALTER can move, so it must not
 * ask for one.
 *
 * The other half of why `generateMigration({ fromDb: true })` never converged
 * on Postgres (stacksjs/bun-query-builder#1210): on tables the generator had
 * itself just created, six columns were re-emitted every run as
 *
 *   ALTER TABLE "usage_events" ALTER COLUMN "idempotency_key" DROP DEFAULT;
 *   ALTER TABLE "usage_events" ALTER COLUMN "idempotency_key" TYPE varchar(255)
 *     USING "idempotency_key"::varchar(255);
 *   ALTER TABLE "usage_events" ALTER COLUMN "idempotency_key" SET NOT NULL;
 *
 * though the live column was already `character varying(255) NOT NULL`.
 *
 * `columnsAreDifferent` counted `isUnique` as a column difference. Introspection
 * sets it from a single-column unique index, so a model that spells the same
 * uniqueness as a table-level index rather than `unique: true` disagreed with
 * the database about the flag while agreeing about the column. `modifyColumn`
 * was then asked for a statement, found none of its own three facets changed,
 * and fell through to restating the column as it already was - an ACCESS
 * EXCLUSIVE lock for no change, and the same statements again next run, because
 * no ALTER can move the flag that triggered them.
 *
 * Uniqueness lives in the plan's indexes on both sides - a model's
 * `unique: true` becomes `<table>_<column>_unique` - and that is what creates
 * and drops it.
 */

import type { ColumnPlan, MigrationPlan, TableIndex } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan, generateDiffOperations } from '../src/migrations'

function plan(isUnique: boolean, indexes: TableIndex[] = []): MigrationPlan {
  const column: ColumnPlan = {
    name: 'idempotency_key',
    type: 'string',
    maxLength: 255,
    isPrimaryKey: false,
    isUnique,
    isNullable: false,
    hasDefault: false,
  }
  return { dialect: 'postgres', tables: [{ table: 'usage_events', columns: [column], indexes }] }
}

const uniqueIndex: TableIndex = {
  name: 'usage_events_idempotency_key_unique',
  columns: ['idempotency_key'],
  type: 'unique',
}

describe('the unique flag never drives a column ALTER', () => {
  /** The live side reads the flag off its index; the model side does not set it. */
  it('says nothing when only the flag disagrees', () => {
    const { operations } = generateDiffOperations(plan(true, [uniqueIndex]), plan(false, [uniqueIndex]))

    expect(operations).toEqual([])
  })

  it('says nothing the other way round either', () => {
    const { operations } = generateDiffOperations(plan(false, [uniqueIndex]), plan(true, [uniqueIndex]))

    expect(operations).toEqual([])
  })

  it('does not restate an unchanged varchar column', () => {
    const { operations } = generateDiffOperations(plan(true, [uniqueIndex]), plan(false, [uniqueIndex]))

    expect(operations.some(op => op.sql.includes('TYPE varchar(255)'))).toBe(false)
    expect(operations.some(op => op.sql.includes('NOT NULL'))).toBe(false)
  })
})

/** The uniqueness itself still moves - through the index diff, as it always did. */
describe('uniqueness changes still migrate', () => {
  const modelPlan = (unique: boolean) => buildMigrationPlan({
    UsageEvent: {
      name: 'UsageEvent',
      table: 'usage_events',
      attributes: {
        idempotency_key: {
          validation: { rule: { name: 'string', rules: [{ name: 'max', params: { max: 255 } }] } },
          ...(unique ? { unique: true } : {}),
        },
      },
    },
  } as any, { dialect: 'postgres' })

  it('adding unique: true creates the index', () => {
    const { operations } = generateDiffOperations(modelPlan(false), modelPlan(true))

    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('create_index')
    expect(operations[0].sql).toContain('CREATE UNIQUE INDEX')
    expect(operations[0].sql).toContain('"idempotency_key"')
  })

  it('removing it drops the index', () => {
    const { operations } = generateDiffOperations(modelPlan(true), modelPlan(false))

    expect(operations).toHaveLength(1)
    expect(operations[0].kind).toBe('drop_index')
    expect(operations[0].sql).toContain('DROP INDEX')
  })

  it('and neither emits an ALTER COLUMN', () => {
    const added = generateDiffOperations(modelPlan(false), modelPlan(true)).operations
    const removed = generateDiffOperations(modelPlan(true), modelPlan(false)).operations

    expect([...added, ...removed].some(op => op.sql.includes('ALTER COLUMN'))).toBe(false)
  })

  it('an unchanged plan stays silent', () => {
    expect(generateDiffOperations(modelPlan(true), modelPlan(true)).operations).toEqual([])
  })
})
