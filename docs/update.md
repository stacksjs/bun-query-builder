---
title: Update Queries
description: Update records in your database with type-safe queries.
---

# Update Queries

Update records with type-safe queries and automatic timestamp handling.

## Basic Update

```typescript
import { createQueryBuilder } from 'bun-query-builder'

const db = createQueryBuilder<typeof schema>({ schema, meta })

// Update a single record by ID
await db.update('users', 1, {
  name: 'Updated Name',
})

// Update with where clause
await db
  .updateFrom('users')
  .set({ active: false })
  .where({ email: 'old@example.com' })
  .execute()
```

## Update Multiple Records

```typescript
// Update all matching records
await db
  .updateFrom('users')
  .set({ status: 'inactive' })
  .where('last_login', '<', '2024-01-01')
  .execute()

// Update with multiple conditions
await db
  .updateFrom('users')
  .set({ verified: true })
  .where({ active: true })
  .andWhere({ email_verified: true })
  .execute()
```

## Update Many by Condition

```typescript
// Update many records matching conditions
await db.updateMany('users', { active: false }, { status: 'archived' })
// Updates all users where active = false, setting status = 'archived'
```

## Increment and Decrement

```typescript
// Increment a column value
await db
  .updateFrom('posts')
  .increment('views', 1)
  .where({ id: 123 })
  .execute()

// Decrement a column value
await db
  .updateFrom('products')
  .decrement('stock', 5)
  .where({ id: 456 })
  .execute()
```

## Update with Timestamps

If your model has timestamps enabled, `updated_at` is automatically updated:

```typescript
// updated_at is automatically set
await db.update('users', 1, {
  name: 'New Name',
})
// Equivalent to: SET name = 'New Name', updated_at = NOW()
```

## Update with Returning

Get the updated record back:

```typescript
const updated = await db
  .updateFrom('users')
  .set({ name: 'Updated Name' })
  .where({ id: 1 })
  .returning(['id', 'name', 'updated_at'])
  .execute()

console.log(updated)
// { id: 1, name: 'Updated Name', updated_at: '2024-01-15T...' }
```

## Conditional Updates

Update only if conditions are met:

```typescript
// Update only active users
const result = await db
  .updateFrom('users')
  .set({ newsletter_sent: true })
  .where({ active: true })
  .where({ newsletter_sent: false })
  .execute()

console.log(`Updated ${result.changes} records`)
```

## Model Hooks

Hooks are triggered on update operations:

```typescript
const db = createQueryBuilder<typeof schema>({
  schema,
  meta,
  hooks: {
    beforeUpdate: async ({ table, data, where }) => {
      console.log(`Updating ${table} where:`, where)
      // Modify data, validate, or throw to prevent update
      return data
    },
    afterUpdate: async ({ table, data, where, result }) => {
      console.log(`Updated ${table}:`, result)
      // Clear caches, send webhooks, etc.
    },
  },
})
```

## Update with JSON Columns

```typescript
// Update a JSON column
await db.update('users', 1, {
  preferences: {
    theme: 'dark',
    notifications: true,
  },
})

// Update nested JSON (if supported by your database)
await db
  .updateFrom('users')
  .set({
    'preferences.theme': 'light',
  })
  .where({ id: 1 })
  .execute()
```

## Bulk Updates

Efficiently update multiple records:

```typescript
// Update many records with the same values
await db
  .updateFrom('posts')
  .set({ published: true, published_at: new Date() })
  .where('id', 'IN', [1, 2, 3, 4, 5])
  .execute()
```

## Update with Transaction

```typescript
await db.transaction(async (trx) => {
  // Update user
  await trx.update('users', userId, {
    status: 'premium',
  })

  // Update related subscription
  await trx
    .updateFrom('subscriptions')
    .set({ active: true, upgraded_at: new Date() })
    .where({ user_id: userId })
    .execute()
})
```

## Update or Create (Upsert)

```typescript
// Insert or update if exists
await db.upsert('users', {
  email: 'user@example.com',
  name: 'Updated Name',
  active: true,
}, {
  conflictColumns: ['email'],
  updateColumns: ['name', 'active'],
})
```

## Complete Example

```typescript
import { createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from 'bun-query-builder'

// Setup
const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    timestamps: true,
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
      active: { validation: { rule: {} } },
      status: { validation: { rule: {} } },
      login_count: { validation: { rule: {} } },
    },
  },
}

const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

const db = createQueryBuilder<typeof schema>({
  schema,
  meta,
  hooks: {
    beforeUpdate: async ({ table, data }) => {
      console.log(`Updating ${table}`)
      return data
    },
    afterUpdate: async ({ table, result }) => {
      console.log(`Updated successfully`)
    },
  },
})

// Various update operations
async function updateUsers() {
  // Update single record
  await db.update('users', 1, {
    name: 'John Smith',
  })

  // Update with conditions
  await db
    .updateFrom('users')
    .set({ status: 'inactive' })
    .where('last_login', '<', '2024-01-01')
    .execute()

  // Increment login count
  await db
    .updateFrom('users')
    .increment('login_count', 1)
    .where({ id: 1 })
    .execute()

  // Batch update
  await db.updateMany('users', { status: 'pending' }, { status: 'active' })

  console.log('Updates completed')
}

updateUsers()
```
