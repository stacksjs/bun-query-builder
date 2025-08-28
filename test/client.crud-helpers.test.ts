import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'

const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      role: { validation: { rule: {} } },
      created_at: { validation: { rule: {} } },
    },
  },
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)

function qb() {
  return createQueryBuilder<typeof schema>({ schema, meta })
}

describe('query builder - CRUD-style helpers availability', () => {
  it('exposes helper functions on the builder', () => {
    const db = qb()
    expect(typeof db.create).toBe('function')
    expect(typeof db.createMany).toBe('function')
    expect(typeof db.firstOrCreate).toBe('function')
    expect(typeof db.updateOrCreate).toBe('function')
    expect(typeof db.save).toBe('function')
    expect(typeof db.remove).toBe('function')
    expect(typeof db.find).toBe('function')
    expect(typeof db.findOrFail).toBe('function')
    expect(typeof db.findMany).toBe('function')
    expect(typeof db.latest).toBe('function')
    expect(typeof db.oldest).toBe('function')
    expect(typeof db.skip).toBe('function')
    expect(typeof db.rawQuery).toBe('function')
  })

  it('skip(table, n) returns a composable select builder', () => {
    const db = qb()
    const q = db.skip('users', 10).limit(5).toSQL() as any
    expect(typeof q.execute).toBe('function')
  })
})
