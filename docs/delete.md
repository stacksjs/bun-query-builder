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
await db.remove('users', 1)

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

A soft-deleted row stays in the table with its `deleted_at` column set. The
query builder does not mark rows for you: every `deleteFrom()` and
`db.remove()` is a real `DELETE`. What it does is hide marked rows from reads,
once the filter is switched on in your config:

```typescript
import { setConfig } from 'bun-query-builder'

setConfig({
  softDeletes: {
    enabled: true,
    column: 'deleted_at',
    defaultFilter: true, // add `WHERE deleted_at IS NULL` to every selectFrom()
  },
})
```

```typescript
// Soft delete a record: mark it
await db
  .updateTable('users')
  .set({ deleted_at: new Date().toISOString() })
  .where({ id: 1 })
  .execute()

// Query excluding soft deleted records (with defaultFilter on)
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

On a model, `traits: { useSoftDeletes: true }` adds the column in migrations,
and `User.delete(id)`, `User.destroy(id)` and `user.delete()` mark the row
instead of removing it (see [Deleting by id on a Model](#deleting-by-id-on-a-model)).

## Restore Soft Deleted Records

```typescript

// Restoring is a model-layer operation: load the trashed row, then restore it.
const user = await User.withTrashed().find(1)
await user.restore()
// Sets deleted_at = NULL

// From the query builder, clear the soft-delete column directly
await db
  .updateTable('users')
  .set({ deleted_at: null })
  .where({ email: 'restored@example.com' })
  .execute()

```

## Force Delete (Permanently)

```typescript

// `remove()` issues a real DELETE, so it removes the row whether or not it
// was already soft-deleted.
await db.remove('users', 1)

// Purge every soft-deleted row
await db
  .deleteFrom('users')
  .whereNotNull('deleted_at')
  .execute()

// The same from a model: a delete on an onlyTrashed() query purges
await User.onlyTrashed().delete()

```

## Deleting by id on a Model

`Model.delete(id)` and `Model.destroy(id)` both delete the row the way an
instance does: a model with `useSoftDeletes` is marked rather than removed, and
`beforeDelete`/`afterDelete` run. Both answer `false` when there is no such row — including one that is already
trashed, which they no longer see. Use `Model.forceDelete(id)` to purge that.

```typescript
await Post.delete(1) // or Post.destroy(1) — the same call
await Post.onlyTrashed().first() // the row is still there, marked
```

`Model.forceDelete(id)` removes it for good, soft deletes or not, and finds a
row that is already trashed. `Model.remove(id)` is the same call, matching what
`db.remove(table, id)` means above. Delete hooks run either way.

```typescript
await Post.forceDelete(1) // or Post.remove(1)
```

An instance has the same pair: `post.delete()` marks a soft-deletable row,
`post.forceDelete()` removes it.

## Deleting with a Model Query

A model query has the same pair. `delete()` marks the matching rows on a model
with `useSoftDeletes` and removes them on any other; `forceDelete()` removes
them either way. Both resolve to the number of rows affected.

```typescript
await Post.where('views', 0).delete() // marks them
await Post.where('views', 0).forceDelete() // removes them
await Post.onlyTrashed().delete() // purges the trash
```

`beforeDelete` and `afterDelete` run once per row. To give each hook its row,
the query reads the matching rows first, then deletes them by primary key, so
the hooks and the delete cover the same rows. Every `beforeDelete` runs before
anything is written, so one that throws cancels the whole delete. A model with
no delete hooks skips the read and sends a single statement.

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

// Truncate entire table — a model-layer static
await Log.truncate()

// From the query builder, issue the statement directly.
// TRUNCATE is not supported by SQLite; use DELETE there.
await db.unsafe('TRUNCATE TABLE logs')

// With cascade (if foreign keys exist)
await db.unsafe('TRUNCATE TABLE users CASCADE')

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
  await trx.remove('users', userId)

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
    await trx.remove('users', userId)
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

  // Restore a user (clear the soft-delete column)
  await db.updateTable('users').set({ deleted_at: null }).where({ id: 1 }).execute()

  // Query with trashed
  const allUsers = await db.selectFrom('users').withTrashed().get()
  const deletedOnly = await db.selectFrom('users').onlyTrashed().get()

  // Permanently delete — a real DELETE, regardless of soft-delete state
  await db.deleteMany('users', [2, 3, 4])

  console.log('Cleanup completed')
}

cleanupData()

```
