import { describe, expect, it } from 'bun:test'
import { getDialectDriver } from '../src/drivers'
import { buildMigrationPlan } from '../src/migrations'

// A bounded string column (`.max(n)`) should become `varchar(n)` instead of the
// default `varchar(255)`, so tight columns don't over-reserve. Indexable
// bounded identifiers may exceed 255; content-sized values become `text`.
//
// An UNBOUNDED string splits by dialect, which is the contrast the two DDL
// tests below draw: `varchar(255)` on MySQL, where TEXT cannot be indexed
// without a prefix length, and `text` on Postgres, which stores and indexes
// both the same way and so gains nothing from a bound the model never set.
const mkStr = (max?: number) => ({
  validation: { rule: { name: 'string', rules: max ? [{ name: 'max', params: { max } }] : [] } },
})

const mkTypedStr = (max: number) => ({
  type: 'string',
  validation: { rule: { name: 'string', rules: [{ name: 'max', params: { max } }] } },
})

const models = {
  T: {
    name: 'T',
    table: 't',
    attributes: {
      id: mkStr(32),
      country: mkStr(2),
      mailbox: mkStr(320),
      path: mkStr(), // unbounded → varchar(255) on MySQL, text on Postgres
      bio: mkStr(5000), // > 255 → text
      payload: mkTypedStr(16_000), // explicit type must not hide validator width
    },
  },
}

function plan(dialect: string) {
  return buildMigrationPlan(models as any, { dialect } as any).tables.find(t => t.table === 't')!
}

describe('varchar width from .max()', () => {
  it('carries indexable maxLength values onto string columns', () => {
    const cols = Object.fromEntries(plan('singlestore').columns.map(c => [c.name, c]))
    expect(cols.id.maxLength).toBe(32)
    expect(cols.country.maxLength).toBe(2)
    expect(cols.mailbox.maxLength).toBe(320)
    expect(cols.path.maxLength).toBeUndefined() // unbounded
    expect(cols.bio.type).toBe('text') // promoted, so no varchar width
    expect(cols.bio.maxLength).toBeUndefined()
    expect(cols.payload.type).toBe('text')
    expect(cols.payload.maxLength).toBeUndefined()
  })

  it('emits varchar(n) in MySQL/SingleStore DDL', () => {
    const ddl = getDialectDriver('singlestore' as any).createTable(plan('singlestore'))
    expect(ddl).toContain('`id` varchar(32)')
    expect(ddl).toContain('`country` varchar(2)')
    expect(ddl).toContain('`mailbox` varchar(320)')
    expect(ddl).toContain('`path` varchar(255)')
    expect(ddl).toContain('`bio` text')
    expect(ddl).toContain('`payload` text')
  })

  it('emits varchar(n) in Postgres DDL, and text for an unbounded column', () => {
    const ddl = getDialectDriver('postgres' as any).createTable(plan('postgres'))
    expect(ddl).toContain('"id" varchar(32)')
    expect(ddl).toContain('"country" varchar(2)')
    expect(ddl).toContain('"mailbox" varchar(320)')
    // Not varchar(255): nothing bounded this column, and a Postgres varchar
    // rejects its own writes past the bound while text would have taken them.
    expect(ddl).toContain('"path" text')
    expect(ddl).toContain('"bio" text')
    expect(ddl).toContain('"payload" text')
  })
})
