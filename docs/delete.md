---
title: Delete Queries
description: Delete records from your database with type-safe queries.
---

# Delete Queries

Delete records with type-safe queries, soft deletes, and cascade support.

## Basic Delete

```typescript
import { createQueryBuilder } from 'bun-query-builder'

const db = createQueryBuilder<typeof schema>({ schema, meta })

// Delete by ID
await db.delete('users', 1)

// Delete with where clause
await db
  .deleteFrom('users')
  .where({ active: false })
  .execute()
```

## Delete with Conditions

```typescript
// Delete records matching conditions
await db
  .deleteFrom('posts')
  .where('created_at', '<', '2023-01-01')
  .execute()

// Delete with multiple conditions
await db
  .deleteFrom('sessions')
  .where('expired', '=', true)
  .andWhere('last_activity', '<', '2024-01-01')
  .execute()
```

## Delete Many

```typescript
// Delete multiple records by IDs
await db.deleteMany('users', [1, 2, 3, 4, 5])

// Delete many with conditions
await db
  .deleteFrom('logs')
  .where('level', '=', 'debug')
  .where('created_at', '<', '2024-01-01')
  .execute()
```

## Soft Deletes

If your model supports soft deletes, records are marked as deleted instead of being removed:

```typescript
// Model with soft deletes enabled
const models = {
  User: {
    name: 'User',
    table: 'users',
    softDeletes: true,  // Enable soft deletes
    // ...
  },
}

// Soft delete a record
await db.delete('users', 1)
// Sets deleted_at = NOW() instead of removing the record

// Query excluding soft deleted records (default behavior)
const activeUsers = await db.selectFrom('users').get()

// Query including soft deleted records
const allUsers = await db
  .selectFrom('users')
  .withTrashed()
  .get()

// Query only soft deleted records
const deletedUsers = await db
  .selectFrom('users')
  .onlyTrashed()
  .get()
```

## Restore Soft Deleted Records

```typescript
// Restore a soft deleted record
await db.restore('users', 1)
// Sets deleted_at = NULL

// Restore with conditions
await db
  .restoreFrom('users')
  .where({ email: 'restored@example.com' })
  .execute()
```

## Force Delete (Permanently)

```typescript
// Permanently delete a soft deleted record
await db.forceDelete('users', 1)

// Force delete with conditions
await db
  .deleteFrom('users')
  .onlyTrashed()
  .forceDelete()
  .execute()
```

## Delete with Returning

```typescript
// Get deleted records data
const deleted = await db
  .deleteFrom('users')
  .where({ active: false })
  .returning(['id', 'email'])
  .execute()

console.log('Deleted users:', deleted)
```

## Model Hooks

Hooks are triggered on delete operations:

```typescript
const db = createQueryBuilder<typeof schema>({
  schema,
  meta,
  hooks: {
    beforeDelete: async ({ table, where }) => {
      console.log(`Deleting from ${table} where:`, where)
      // Check constraints, prevent deletion, etc.
    },
    afterDelete: async ({ table, where, result }) => {
      console.log(`Deleted from ${table}:`, result)
      // Clean up related data, update aggregates, etc.
    },
  },
})
```

## Truncate Table

Remove all records from a table:

```typescript
// Truncate entire table
await db.truncate('logs')

// With cascade (if foreign keys exist)
await db.truncate('users', { cascade: true })
```

## Delete with Transaction

```typescript
await db.transaction(async (trx) => {
  // Delete user's posts first
  await trx
    .deleteFrom('posts')
    .where({ user_id: userId })
    .execute()

  // Then delete the user
  await trx.delete('users', userId)

  // All or nothing - if any delete fails, all are rolled back
})
```

## Cascade Delete

Handle related records:

```typescript
// Manual cascade delete
async function deleteUserWithRelations(userId: number) {
  await db.transaction(async (trx) => {
    // Delete comments
    await trx.deleteFrom('comments').where({ user_id: userId }).execute()

    // Delete posts
    await trx.deleteFrom('posts').where({ user_id: userId }).execute()

    // Delete user
    await trx.delete('users', userId)
  })
}
```

## Complete Example

```typescript
import { createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from 'bun-query-builder'

// Setup with soft deletes
const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    timestamps: true,
    softDeletes: true,
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
      active: { validation: { rule: {} } },
      deleted_at: { validation: { rule: {} } },
    },
  },
  Post: {
    name: 'Post',
    table: 'posts',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      user_id: { validation: { rule: {} } },
      title: { validation: { rule: {} } },
    },
  },
}

const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

const db = createQueryBuilder<typeof schema>({
  schema,
  meta,
  hooks: {
    beforeDelete: async ({ table, where }) => {
      if (table === 'users') {
        // Prevent deleting admin users
        const user = await db.selectFrom('users').where(where).first()
        if (user?.role === 'admin') {
          throw new Error('Cannot delete admin users')
        }
      }
    },
    afterDelete: async ({ table, result }) => {
      console.log(`Deleted from ${table}`)
    },
  },
})

// Various delete operations
async function cleanupData() {
  // Soft delete inactive users
  await db
    .deleteFrom('users')
    .where({ active: false })
    .execute()

  // Delete old posts permanently
  await db
    .deleteFrom('posts')
    .where('created_at', '<', '2023-01-01')
    .execute()

  // Restore a user
  await db.restore('users', 1)

  // Query with trashed
  const allUsers = await db.selectFrom('users').withTrashed().get()
  const deletedOnly = await db.selectFrom('users').onlyTrashed().get()

  // Force delete
  await db.forceDelete('users', [2, 3, 4])

  console.log('Cleanup completed')
}

cleanupData()
```
