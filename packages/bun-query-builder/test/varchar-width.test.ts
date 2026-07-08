import { describe, expect, it } from 'bun:test'
import { getDialectDriver } from '../src/drivers'
import { buildMigrationPlan } from '../src/migrations'

// A bounded string column (`.max(n)`) should become `varchar(n)` instead of the
// default `varchar(255)`, so tight columns don't over-reserve. Values > 255 are
// promoted to `text` (existing behavior).
const mkStr = (max?: number) => ({
  validation: { rule: { name: 'string', rules: max ? [{ name: 'max', params: { max } }] : [] } },
})

const models = {
  T: {
    name: 'T',
    table: 't',
    attributes: {
      id: mkStr(32),
      country: mkStr(2),
      path: mkStr(), // unbounded → varchar(255)
      bio: mkStr(5000), // > 255 → text
    },
  },
}

function plan(dialect: string) {
  return buildMigrationPlan(models as any, { dialect } as any).tables.find(t => t.table === 't')!
}

describe('varchar width from .max()', () => {
  it('carries maxLength (≤255) onto the ColumnPlan for string columns', () => {
    const cols = Object.fromEntries(plan('singlestore').columns.map(c => [c.name, c]))
    expect(cols.id.maxLength).toBe(32)
    expect(cols.country.maxLength).toBe(2)
    expect(cols.path.maxLength).toBeUndefined() // unbounded
    expect(cols.bio.type).toBe('text') // promoted, so no varchar width
    expect(cols.bio.maxLength).toBeUndefined()
  })

  it('emits varchar(n) in MySQL/SingleStore DDL', () => {
    const ddl = getDialectDriver('singlestore' as any).createTable(plan('singlestore'))
    expect(ddl).toContain('`id` varchar(32)')
    expect(ddl).toContain('`country` varchar(2)')
    expect(ddl).toContain('`path` varchar(255)')
    expect(ddl).toContain('`bio` text')
  })

  it('emits varchar(n) in Postgres DDL', () => {
    const ddl = getDialectDriver('postgres' as any).createTable(plan('postgres'))
    expect(ddl).toContain('"id" varchar(32)')
    expect(ddl).toContain('"country" varchar(2)')
    expect(ddl).toContain('"path" varchar(255)')
  })
})
