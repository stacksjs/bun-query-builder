import { buildDatabaseSchema, buildMigrationPlan, buildSchemaMeta, createQueryBuilder } from 'bun-query-builder'

import User from './models/User'

// Define models with proper structure
const models = {
  User,
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)
const db = createQueryBuilder<typeof schema>({ schema, meta })
const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

console.log(plan)

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

// Export for use in other files
export {
  basicSelectQuery,
  db,
  meta,
  schema,
}

// Uncomment to run examples when this file is executed directly
await basicSelectQuery()
