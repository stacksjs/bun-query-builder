/**
 * A decimal column's precision and scale come from the model.
 *
 * Every driver hard-coded `decimal(10,2)`, so a price needing four places or
 * a total over 99,999,999.99 could not be declared at all, and a model that
 * tried got the same column regardless. The attribute now takes `precision`
 * and `scale` (or `type: 'decimal(p,s)'`), every driver renders them, and the
 * diff treats a change as a type change. Unset keeps (10,2), so existing
 * plans and snapshots produce no diff.
 */
import type { MigrationPlan } from '../src/migrations'
import { describe, expect, it } from 'bun:test'
import { decimalFacets, mysqlDecimalFacets } from '../src/actions/introspect-db'
import { decimalPrecision } from '../src/drivers/decimal'
import { buildMigrationPlan, canonicalStorageType, generateDiffOperations, generateSql, hashMigrationPlan } from '../src/migrations'

type Dialect = 'postgres' | 'mysql' | 'sqlite'

function planFor(attr: Record<string, unknown>, dialect: Dialect = 'postgres'): MigrationPlan {
  return buildMigrationPlan({
    Product: { name: 'Product', table: 'products', attributes: { price: { validation: { rule: { name: 'decimal' } }, ...attr } } },
  } as any, { dialect })
}

const price = (plan: MigrationPlan) => plan.tables[0].columns.find(c => c.name === 'price')!

describe('declaring precision and scale', () => {
  it('defaults to decimal(10,2) and stamps nothing on the plan', () => {
    const plan = planFor({})
    expect(price(plan).type).toBe('decimal')
    expect(price(plan).precision).toBeUndefined()
    expect(price(plan).scale).toBeUndefined()
    expect(generateSql(plan).join('\n')).toContain('"price" decimal(10,2)')
  })

  it('reads precision/scale from the attribute', () => {
    const plan = planFor({ precision: 12, scale: 4 })
    expect(price(plan)).toMatchObject({ type: 'decimal', precision: 12, scale: 4 })
  })

  it('reads them from a decimal(p,s) type', () => {
    expect(price(planFor({ type: 'decimal(14, 3)' }))).toMatchObject({ type: 'decimal', precision: 14, scale: 3 })
    expect(price(planFor({ type: 'numeric(8)' }))).toMatchObject({ type: 'decimal', precision: 8 })
  })

  it('reads them from a validator that exposes them', () => {
    const rule = { name: 'decimal', rules: [{ name: 'precision', params: { precision: 9, scale: 3 } }] }
    expect(price(planFor({ validation: { rule } }))).toMatchObject({ precision: 9, scale: 3 })
  })

  it('makes a number() column a decimal when precision is declared', () => {
    expect(price(planFor({ validation: { rule: { name: 'number' } }, precision: 12, scale: 2 })).type).toBe('decimal')
  })

  it('keeps an explicit non-decimal type', () => {
    expect(price(planFor({ type: 'integer', precision: 12 })).type).toBe('integer')
  })

  it('refuses values no engine accepts, naming the attribute', () => {
    expect(() => planFor({ precision: 4, scale: 6 })).toThrow(/"price".*scale \(6\) cannot exceed precision \(4\)/)
    expect(() => planFor({ precision: 0 })).toThrow(/"price".*precision/)
    expect(() => planFor({ scale: -1 })).toThrow(/"price".*scale/)
  })

  it('fills in the undeclared half sensibly', () => {
    expect(decimalPrecision({})).toEqual({ precision: 10, scale: 2 })
    expect(decimalPrecision({ precision: 14 })).toEqual({ precision: 14, scale: 2 })
    expect(decimalPrecision({ precision: 1 })).toEqual({ precision: 1, scale: 1 })
    expect(decimalPrecision({ scale: 4 })).toEqual({ precision: 10, scale: 4 })
    expect(decimalPrecision({ scale: 12 })).toEqual({ precision: 12, scale: 12 })
  })
})

describe('every driver renders it', () => {
  it('postgres and mysql emit decimal(p,s); sqlite keeps its REAL affinity', () => {
    expect(generateSql(planFor({ precision: 12, scale: 4 }, 'postgres')).join('\n')).toContain('"price" decimal(12,4)')
    expect(generateSql(planFor({ precision: 12, scale: 4 }, 'mysql')).join('\n')).toContain('`price` decimal(12,4)')
    expect(generateSql(planFor({ precision: 12, scale: 4 }, 'sqlite')).join('\n')).toMatch(/"price" REAL/i)
  })
})

describe('diffing it', () => {
  it('a precision change is an ALTER ... TYPE on postgres', () => {
    const { operations } = generateDiffOperations(planFor({}), planFor({ precision: 12, scale: 4 }))
    const change = operations.find(op => op.kind === 'modify_column')
    expect(change?.sql).toContain('ALTER COLUMN "price" TYPE decimal(12,4)')
    expect(change?.destructive).toBe(false)
  })

  it('a MODIFY COLUMN on mysql', () => {
    const { operations } = generateDiffOperations(planFor({}, 'mysql'), planFor({ precision: 12, scale: 4 }, 'mysql'))
    expect(operations.find(op => op.kind === 'modify_column')?.sql).toContain('MODIFY COLUMN `price` decimal(12,4)')
  })

  it('losing scale or integer digits is destructive', () => {
    const fewerPlaces = generateDiffOperations(planFor({ precision: 12, scale: 4 }), planFor({ precision: 12, scale: 2 }))
    expect(fewerPlaces.operations.find(op => op.kind === 'modify_column')?.destructive).toBe(true)
    const fewerDigits = generateDiffOperations(planFor({}), planFor({ precision: 8, scale: 2 }))
    expect(fewerDigits.operations.find(op => op.kind === 'modify_column')?.destructive).toBe(true)
  })

  it('declaring the default explicitly is not a change, nor is a pre-existing snapshot', () => {
    expect(generateDiffOperations(planFor({}), planFor({ precision: 10, scale: 2 })).operations).toEqual([])
    // A snapshot written before precision existed has the same plan shape.
    const legacy = planFor({})
    expect(hashMigrationPlan(legacy)).toBe(hashMigrationPlan(planFor({})))
    expect(canonicalStorageType(price(legacy), 'postgres')).toBe('decimal(10,2)')
    expect(canonicalStorageType(price(legacy), 'mysql')).toBe('DECIMAL(10,2)')
  })

  it('sqlite has nothing to change', () => {
    expect(generateDiffOperations(planFor({}, 'sqlite'), planFor({ precision: 12, scale: 4 }, 'sqlite')).operations).toEqual([])
  })
})

describe('introspection', () => {
  it('reads numeric precision and scale back', () => {
    expect(decimalFacets(12, 4)).toEqual({ precision: 12, scale: 4 })
    expect(decimalFacets(null, null)).toEqual({})
    expect(mysqlDecimalFacets('decimal(12,4)')).toEqual({ precision: 12, scale: 4 })
    expect(mysqlDecimalFacets('decimal(9)')).toEqual({ precision: 9, scale: 0 })
    expect(mysqlDecimalFacets('varchar(9)')).toEqual({})
  })
})
