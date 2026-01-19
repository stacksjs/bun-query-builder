# Getting Started

Learn how to install and set up bun-query-builder in your Bun project.

## Prerequisites

- [Bun](https://bun.sh) v1.0 or higher
- SQLite, PostgreSQL, or MySQL database

## Installation

```bash
bun add bun-query-builder
```

## Basic Setup

### Creating a Query Builder

```typescript
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from 'bun-query-builder'

// Define your models
const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
      active: { validation: { rule: {} } }
    }
  },
  Post: {
    name: 'Post',
    table: 'posts',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      title: { validation: { rule: {} } },
      body: { validation: { rule: {} } },
      userId: { validation: { rule: {} } }
    }
  }
}

// Build schema and create query builder
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)
const db = createQueryBuilder({ schema, meta })
```

### Configuration Options

```typescript
const db = createQueryBuilder({
  schema,
  meta,
  hooks: {
    beforeCreate: async ({ table, data }) => {
      console.log(`Creating ${table}:`, data)
    },
    afterCreate: async ({ table, data, result }) => {
      console.log(`Created ${table}:`, result)
    },
    beforeUpdate: async ({ table, data, where }) => {
      // Validation, logging, etc.
    },
    afterUpdate: async ({ table, data, where, result }) => {
      // Clear caches, send webhooks, etc.
    },
    beforeDelete: async ({ table, where }) => {
      // Check constraints, etc.
    },
    afterDelete: async ({ table, where, result }) => {
      // Clean up related data
    }
  }
})
```

## Basic Queries

### Select Queries

```typescript
// Select all users
const users = await db.selectFrom('users').get()

// Select with conditions
const activeUsers = await db
  .selectFrom('users')
  .where({ active: true })
  .get()

// Select specific columns
const userNames = await db
  .selectFrom('users')
  .select(['id', 'name'])
  .get()
```

### Insert Data

```typescript
// Insert single record
const user = await db
  .insertInto('users')
  .values({
    name: 'John Doe',
    email: 'john@example.com',
    active: true
  })
  .execute()

// Insert multiple records
await db.insertMany('users', [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' }
])
```

### Update Data

```typescript
// Update by condition
await db
  .update('users')
  .set({ active: false })
  .where({ id: 1 })
  .execute()
```

### Delete Data

```typescript
// Delete by condition
await db
  .deleteFrom('users')
  .where({ id: 1 })
  .execute()
```

## Aggregations

```typescript
// Count records
const count = await db.selectFrom('users').count()

// Average value
const avgAge = await db
  .selectFrom('users')
  .where({ active: true })
  .avg('age')

// Sum values
const totalBalance = await db.selectFrom('accounts').sum('balance')

// Max/Min
const maxScore = await db.selectFrom('users').max('score')
const minScore = await db.selectFrom('users').min('score')
```

## Query Caching

```typescript
// Cache query results for 60 seconds (default)
const users = await db
  .selectFrom('users')
  .where({ active: true })
  .cache()
  .get()

// Custom cache TTL (5 seconds)
const posts = await db
  .selectFrom('posts')
  .orderBy('created_at', 'desc')
  .limit(10)
  .cache(5000)
  .get()

// Clear all cached queries
clearQueryCache()

// Configure cache size
setQueryCacheMaxSize(500)
```

## Next Steps

- Learn about [select queries](./select.md)
- Understand [where clauses](./where.md)
- Explore [joins](./join.md)
- Master [transactions](./transactions.md)
