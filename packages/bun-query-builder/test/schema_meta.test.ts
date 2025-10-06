import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, defineModels, resetDatabase } from '../src'
import { config } from '../src/config'
import { setupDatabase } from './setup'

const models = defineModels({
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: { id: { validation: { rule: {} } }, email: { validation: { rule: {} } } },
  },
  Project: {
    name: 'Project',
    table: 'projects',
    primaryKey: 'pid',
    attributes: { pid: { validation: { rule: {} } }, user_id: { validation: { rule: {} } } },
  },
} as const)

beforeAll(async () => {
  if (config.debug)
    config.debug.captureText = true
  config.softDeletes = { enabled: true, column: 'deleted_at', defaultFilter: true }

  await setupDatabase()
})

afterAll(async () => {
  await resetDatabase('../../examples/models', { dialect: 'postgres' })
})

describe('schema and meta builders', () => {
  it('buildDatabaseSchema maps attributes and primary keys', () => {
    const schema = buildDatabaseSchema(models)

    expect(Object.keys(schema)).toEqual(['users', 'projects'])
    expect(Object.keys(schema.users.columns)).toEqual(['id', 'email'])
    expect(schema.users.primaryKey).toBe('id')
    expect(Object.keys(schema.projects.columns)).toEqual(['pid', 'user_id'])
    expect(schema.projects.primaryKey).toBe('pid')
  })

  it('buildSchemaMeta maps model<->table and primary keys', () => {
    const meta = buildSchemaMeta(models as any)
    expect(meta.modelToTable.User).toBe('users')
    expect(meta.tableToModel.users).toBe('User')
    expect(meta.primaryKeys.users).toBe('id')
    expect(meta.modelToTable.Project).toBe('projects')
    expect(meta.tableToModel.projects).toBe('Project')
    expect(meta.primaryKeys.projects).toBe('pid')
  })
})
