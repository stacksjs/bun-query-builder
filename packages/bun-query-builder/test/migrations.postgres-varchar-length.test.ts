/**
 * A varchar's length is part of the schema on Postgres too.
 *
 * `canonicalStorageType` compared bare plan types for Postgres, so a model's
 * `max(50)` becoming `max(100)` diffed as `string` against `string` — no
 * change. The column stayed varchar(50) while the validator accepted 100
 * characters, and every longer write failed in production with "value too
 * long for type character varying(50)". MySQL already compared VARCHAR(n).
 */
import type { ColumnPlan, MigrationPlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { pgColumnMaxLength } from '../src/actions/introspect-db'
import { buildMigrationPlan, canonicalStorageType, generateDiffOperations } from '../src/migrations'

const rule = (max?: number) => ({ name: 'string', rules: max ? [{ name: 'max', params: { max } }] : [] })

function modelPlan(max?: number): MigrationPlan {
  return buildMigrationPlan({
    Coach: { name: 'Coach', table: 'coaches', attributes: { handle: { validation: { rule: rule(max) } } } },
  } as any, { dialect: 'postgres' })
}

const handle = (plan: MigrationPlan): ColumnPlan => plan.tables[0].columns.find(c => c.name === 'handle')!

describe('postgres varchar length', () => {
  it('carries the bound into the canonical storage type', () => {
    expect(canonicalStorageType(handle(modelPlan(50)), 'postgres')).toBe('varchar(50)')
    expect(canonicalStorageType(handle(modelPlan()), 'postgres')).toBe('varchar(255)')
  })

  it('widening max(50) -> max(100) emits ALTER COLUMN ... TYPE varchar(100), non-destructively', () => {
    const { operations } = generateDiffOperations(modelPlan(50), modelPlan(100))
    const change = operations.find(op => op.kind === 'modify_column' && op.column === 'handle')
    expect(change).toBeDefined()
    expect(change!.sql).toContain('ALTER COLUMN "handle" TYPE varchar(100)')
    expect(change!.destructive).toBe(false)
  })

  it('narrowing max(100) -> max(50) is flagged destructive', () => {
    const { operations } = generateDiffOperations(modelPlan(100), modelPlan(50))
    const change = operations.find(op => op.kind === 'modify_column' && op.column === 'handle')
    expect(change!.sql).toContain('TYPE varchar(50)')
    expect(change!.destructive).toBe(true)
  })

  it('an unchanged bound produces no change', () => {
    const { operations } = generateDiffOperations(modelPlan(50), modelPlan(50))
    expect(operations).toEqual([])
  })

  it('an unbounded string and varchar(255) are the same column', () => {
    const { operations } = generateDiffOperations(modelPlan(), modelPlan(255))
    expect(operations).toEqual([])
  })

  it('introspection reads the live bound so a live diff compares lengths too', () => {
    expect(pgColumnMaxLength(50)).toBe(50)
    expect(pgColumnMaxLength('120')).toBe(120)
    expect(pgColumnMaxLength(null)).toBeUndefined()
  })
})
