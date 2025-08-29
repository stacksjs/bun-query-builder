import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from 'bun-query-builder'
import { executeMigration, generateMigration } from '../src/actions/migrate'
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

  db
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
  const migration = await generateMigration('./models', { dialect: 'postgres', apply: true, full: true })

  const sqlScript = migration.sqlStatements

  console.log(sqlScript)

  await executeMigration(sqlScript)
}

// Export for use in other files
export {
  basicSelectQuery,
  db,
  meta,
  schema,
  simpleMigration,
}

await simpleMigration()
