# Usage

There are two ways to use bun-query-builder: as a library and via the CLI.

## Library

```ts
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from 'bun-query-builder'

const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } }, active: { validation: { rule: {} } } },
  },
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)
const db = createQueryBuilder<typeof schema>({ schema, meta })

// SELECT * FROM users WHERE active = true LIMIT 10
const users = await db.selectFrom('users').where({ active: true }).limit(10).execute()

// Insert
await db.insertInto('users').values({ name: 'Alice' }).execute()

// Update
await db.updateTable('users').set({ name: 'Bob' }).where(['id', '=', 1]).execute()

// Delete
await db.deleteFrom('users').where({ id: 2 }).execute()

// Transactions with retries
await db.transaction(async (tx) => {
  await tx.insertInto('users').values({ name: 'Zed' }).execute()
}, { retries: 3, isolation: 'serializable' })

// Relations
const rows = await db
  .selectFrom('users')
  .with('Project')
  .selectAllRelations()
  .limit(10)
  .execute()
```

### Best Practices

- Keep model attribute keys in snake_case to align with SQL defaults.
- Prefer `where({})` for simple equality, and tuples for explicit operators.
- Use `paginate/simplePaginate/cursorPaginate` instead of manual LIMIT/OFFSET when building UIs.

## CLI

```bash
# Print inferred schema from model dir
query-builder introspect ./app/Models --verbose

# Print a sample SQL (text) for a table
query-builder sql ./app/Models users --limit 5

# Connectivity:
query-builder ping
query-builder wait-ready --attempts 30 --delay 250

# Execute a file or unsafe string (be careful!)
query-builder file ./migrations/seed.sql
query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[1]"

# Explain a query
query-builder explain "SELECT * FROM users WHERE active = true"
```

### Best Practices

- Keep CLI in CI to smoke-test DB readiness with `wait-ready`.
- Prefer `file` for SQL scripts and `unsafe` only for trusted strings.
