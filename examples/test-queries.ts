import { join } from 'node:path'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { executeMigration, generateMigration, resetDatabase } from '../src/actions/migrate'
import User from './models/User'

// Define models with proper structure
const models = {
  User,
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)
const db = createQueryBuilder<typeof schema>({ schema, meta })

// Example 1: Basic SELECT query
async function basicSelectQuery() {
  console.warn('=== Basic SELECT Query ===')

  await db
    .selectFrom('users')
    .where({ email: 'john@example.com' })
    .orderBy('created_at', 'desc')
    .limit(10)
    .get()

  // console.warn('Query SQL:', q.toSQL().toString())
  // const rows = await q.get()
  // console.warn('Results:', rows)
}

/**
 * For fresh database setup: drops everything and recreates from current models
 */
async function freshMigration() {
  const modelsPath = join(import.meta.dir, 'models')
  await resetDatabase(modelsPath, { dialect: 'postgres' })
  await generateMigration(modelsPath, { dialect: 'postgres', full: true })
  await executeMigration()
}

/**
 * For incremental migrations: detects changes and generates ALTER/DROP migrations
 * NOTE: Don't call resetDatabase before this, or tables won't exist!
 */
async function simpleMigration() {
  const modelsPath = join(import.meta.dir, 'models')
  // Comment out resetDatabase to test incremental migrations
  // await resetDatabase(modelsPath, { dialect: 'postgres' })

  await generateMigration(modelsPath, { dialect: 'postgres' })
  await executeMigration()
}

export async function freshDatabase() {
  const modelsPath = join(import.meta.dir, 'models')
  await resetDatabase(modelsPath, { dialect: 'postgres' })
}

async function simpleSelectQuery() {
  const q = await db.selectFrom('users').executeTakeFirst()

  console.warn('Results:', q)
}

async function simpleInsertQuery() {
  // TODO: execute after insertion must return ids
  const q = await db.create('users', { name: 'John Doe', email: 'john123.doe@example.com', created_at: new Date() })

  console.warn('Results:', q)
}

// Export for use in other files
export {
  basicSelectQuery,
  db,
  freshMigration,
  meta,
  schema,
  simpleInsertQuery,
  simpleMigration,
  simpleSelectQuery,
}

// Run fresh migration first to set up database, then switch to simpleMigration for incremental changes
freshMigration()
// simpleMigration()
