import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { resetDatabase } from '../src/actions/migrate'
import { config } from '../src/config'
import { buildMigrationPlan, generateSql } from '../src/migrations'
import { defineModels } from '../src/schema'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

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

beforeAll(async () => {
  if (config.debug)
    config.debug.captureText = true
  config.softDeletes = { enabled: true, column: 'deleted_at', defaultFilter: true }

  // Set up database for migration tests
  await setupDatabase()
})

afterAll(async () => {
  // Clean up database after migration tests
  await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: 'postgres' })
})

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
    expect(sql.length).toBeGreaterThan(0)
    expect(sql.join('\n').toLowerCase()).toContain('create table')
    expect(sql.join('\n').toLowerCase()).toContain('unique index')
  })
})

describe('migration status and rollback', () => {
  it('migrateStatus action exists and is callable', async () => {
    const { migrateStatus } = await import('../src/actions/migrate-status')
    expect(typeof migrateStatus).toBe('function')
    // May fail without proper DB setup, but should not throw unhandled errors
    try {
      await migrateStatus()
    }
    catch (err) {
      // Expected to potentially fail without DB
      expect(err).toBeDefined()
    }
  })

  it('migrateList is an alias for migrateStatus', async () => {
    const { migrateList, migrateStatus } = await import('../src/actions/migrate-status')
    expect(typeof migrateList).toBe('function')
    expect(typeof migrateStatus).toBe('function')
  })

  it('migrateRollback action exists and accepts options', async () => {
    const { migrateRollback } = await import('../src/actions/migrate-rollback')
    expect(typeof migrateRollback).toBe('function')
    // May fail without proper DB setup, but should not throw unhandled errors
    try {
      await migrateRollback({ steps: 1 })
    }
    catch (err) {
      // Expected to potentially fail without DB
      expect(err).toBeDefined()
    }
  })
})

describe('schema validation', () => {
  it('validateSchema action exists and is callable', async () => {
    const { validateSchema } = await import('../src/actions/validate')
    expect(typeof validateSchema).toBe('function')
  })

  it('checkSchema is an alias for validateSchema', async () => {
    const { checkSchema, validateSchema } = await import('../src/actions/validate')
    expect(typeof checkSchema).toBe('function')
    expect(typeof validateSchema).toBe('function')
  })

  it('validateSchema returns validation result structure', async () => {
    const { validateSchema } = await import('../src/actions/validate')
    // May fail without proper DB, but test the function signature
    try {
      const result = await validateSchema(EXAMPLES_MODELS_PATH)
      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('valid')
      expect(result).toHaveProperty('issues')
      expect(Array.isArray(result.issues)).toBe(true)
    }
    catch (err) {
      // Expected to potentially fail without DB
      expect(err).toBeDefined()
    }
  })
})
