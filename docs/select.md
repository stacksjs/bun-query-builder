---
title: Select Queries
description: Build type-safe SELECT queries with the query builder.
---

# Select Queries

Build type-safe SELECT queries with full column and table inference.

## Basic Select

```typescript
import { createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from 'bun-query-builder'

const db = createQueryBuilder<typeof schema>({ schema, meta })

// Select all columns from a table
const users = await db.selectFrom('users').get()

// Select specific columns
const names = await db
  .selectFrom('users')
  .select(['name', 'email'])
  .get()

// Select with alias
const data = await db
  .selectFrom('users')
  .select(['name AS userName', 'email AS userEmail'])
  .get()
```

## Where Clauses

```typescript
// Simple where
const activeUsers = await db
  .selectFrom('users')
  .where({ active: true })
  .get()

// Where with operator
const adults = await db
  .selectFrom('users')
  .where('age', '>=', 18)
  .get()

// Multiple conditions (AND)
const activeAdults = await db
  .selectFrom('users')
  .where({ active: true })
  .andWhere('age', '>=', 18)
  .get()

// OR conditions
const results = await db
  .selectFrom('users')
  .where({ role: 'admin' })
  .orWhere({ role: 'moderator' })
  .get()
```

## Ordering Results

```typescript
// Order ascending (default)
const users = await db
  .selectFrom('users')
  .orderBy('name')
  .get()

// Order descending
const recentPosts = await db
  .selectFrom('posts')
  .orderByDesc('created_at')
  .get()

// Multiple order columns
const sorted = await db
  .selectFrom('users')
  .orderBy('last_name')
  .orderBy('first_name')
  .get()

// Get latest records
const latestUsers = await db
  .selectFrom('users')
  .latest()  // Orders by created_at desc
  .get()

// Get oldest records
const oldestUsers = await db
  .selectFrom('users')
  .oldest()  // Orders by created_at asc
  .get()

// Random order
const randomUsers = await db
  .selectFrom('users')
  .inRandomOrder()
  .get()
```

## Limiting Results

```typescript
// Limit results
const topTen = await db
  .selectFrom('users')
  .limit(10)
  .get()

// Offset for pagination
const page2 = await db
  .selectFrom('users')
  .limit(10)
  .offset(10)
  .get()
```

## Distinct Values

```typescript
// Get distinct values
const countries = await db
  .selectFrom('users')
  .distinct('country')
  .get()

// Distinct on multiple columns
const uniqueLocations = await db
  .selectFrom('users')
  .distinctOn(['city', 'country'])
  .get()
```

## First and Single Record

```typescript
// Get first record
const firstUser = await db
  .selectFrom('users')
  .first()

// Get a single record by ID
const user = await db
  .selectFrom('users')
  .where({ id: 1 })
  .first()
```

## Pluck Values

Get a single column as an array:

```typescript
// Get all email addresses
const emails = await db
  .selectFrom('users')
  .pluck('email')
// ['user1@example.com', 'user2@example.com', ...]
```

## Exists Check

```typescript
// Check if records exist
const hasAdmins = await db
  .selectFrom('users')
  .where({ role: 'admin' })
  .exists()
// true or false
```

## Where Column Comparison

Compare two columns:

```typescript
// Find users where created_at equals updated_at
const neverUpdated = await db
  .selectFrom('users')
  .whereColumn('created_at', '=', 'updated_at')
  .get()
```

## Raw Where Clauses

```typescript
// Raw SQL in where
const activeRecent = await db
  .selectFrom('users')
  .whereRaw('DATE(created_at) > DATE_SUB(NOW(), INTERVAL 30 DAY)')
  .get()
```

## Query Caching

Cache query results for improved performance:

```typescript
// Cache for 60 seconds (default)
const users = await db
  .selectFrom('users')
  .where({ active: true })
  .cache()
  .get()

// Cache with custom TTL (5 seconds)
const posts = await db
  .selectFrom('posts')
  .orderByDesc('created_at')
  .limit(10)
  .cache(5000)
  .get()

// Clear cache
clearQueryCache()

// Configure cache size
setQueryCacheMaxSize(500)
```

## Execute Methods

```typescript
// get() - Get all matching records
const allUsers = await db.selectFrom('users').get()

// first() - Get first record or null
const user = await db.selectFrom('users').first()

// execute() - Run the query
const results = await db.selectFrom('users').execute()

// toSQL() - Get the SQL string (for debugging)
const sql = db.selectFrom('users').where({ active: true }).toSQL()
console.log(sql)
```

## Complete Example

```typescript
import { createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from 'bun-query-builder'

// Define models
const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
      active: { validation: { rule: {} } },
      role: { validation: { rule: {} } },
      created_at: { validation: { rule: {} } },
    },
  },
}

// Build schema and meta
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

// Create query builder
const db = createQueryBuilder<typeof schema>({ schema, meta })

// Complex query
const results = await db
  .selectFrom('users')
  .select(['id', 'name', 'email'])
  .where({ active: true })
  .where('role', 'IN', ['admin', 'moderator'])
  .orderByDesc('created_at')
  .limit(20)
  .cache()
  .get()
```
