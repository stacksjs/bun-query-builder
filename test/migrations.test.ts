import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan, generateSql } from '../src/migrations'
import { defineModels } from '../src/schema'

const models = defineModels({
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      email: { unique: true, validation: { rule: {} } },
      created_at: { validation: { rule: {} } },
    },
    indexes: [
      { name: 'created_at_idx', columns: ['created_at'] },
    ],
  },
  Project: {
    name: 'Project',
    table: 'projects',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
    },
  },
} as const)

describe('migration planner', () => {
  it('builds a plan from models with inferred types and indexes', () => {
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
    expect(plan.dialect).toBe('postgres')
    const users = plan.tables.find(t => t.table === 'users')!
    expect(users.columns.find(c => c.name === 'id')?.isPrimaryKey).toBeTrue()
    expect(users.columns.find(c => c.name === 'email')?.isUnique).toBeTrue()
    expect(users.indexes.find(i => i.name === 'created_at_idx')).toBeTruthy()
    // const projects = plan.tables.find(t => t.table === 'projects')!
    // const fk = projects.columns.find(c => c.name === 'user_id')?.references
    // expect(fk?.table).toBe('users')
  })

  it('generates SQL for the plan', () => {
    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
    const sql = generateSql(plan)
    expect(typeof sql).toBe('string')
    expect(sql.length).toBeGreaterThan(0)
  })
})
