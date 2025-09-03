import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from '../src'
import { executeMigration } from '../src/actions/migrate'
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
    .where({ role: 'admin' })
    .orderBy('created_at', 'desc')
    .limit(10)
    .get()

  // console.warn('Query SQL:', q.toSQL().toString())
  // const rows = await q.get()
  // console.warn('Results:', rows)
}

async function simpleMigration() {
  // await generateMigration('./models', { dialect: 'postgres', apply: true, full: true })

  await executeMigration()
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
  meta,
  schema,
  simpleInsertQuery,
  simpleMigration,
  simpleSelectQuery,
}

simpleMigration()
