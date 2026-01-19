---
title: Insert Queries
description: Insert records into your database with type-safe queries.
---

# Insert Queries

Insert single or multiple records with full type safety.

## Basic Insert

```typescript
import { createQueryBuilder } from 'bun-query-builder'

const db = createQueryBuilder<typeof schema>({ schema, meta })

// Insert a single record
await db.insert('users', {
  name: 'John Doe',
  email: 'john@example.com',
  active: true,
})

// Insert returns the inserted record (with auto-generated ID)
const newUser = await db.insert('users', {
  name: 'Jane Doe',
  email: 'jane@example.com',
})

console.log(newUser.id) // Auto-generated ID
```

## Insert Many Records

Insert multiple records efficiently:

```typescript
// Insert many records at once
await db.insertMany('users', [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Charlie', email: 'charlie@example.com' },
])
```

## Insert with Timestamps

Timestamps are automatically added if configured:

```typescript
// If your model has timestamps enabled
await db.insert('users', {
  name: 'John Doe',
  email: 'john@example.com',
})
// created_at and updated_at are auto-populated
```

## Insert or Ignore

Insert only if the record doesn't exist (based on unique constraints):

```typescript
// Insert or ignore on conflict
await db.insertOrIgnore('users', {
  email: 'existing@example.com',
  name: 'New Name',
})
```

## Upsert (Insert or Update)

Insert a record or update if it already exists:

```typescript
// Upsert - insert or update on conflict
await db.upsert('users', {
  email: 'user@example.com',
  name: 'Updated Name',
  active: true,
}, {
  conflictColumns: ['email'],
  updateColumns: ['name', 'active'],
})
```

## Insert with Returning

Get the inserted data back:

```typescript
// Insert and return the inserted record
const inserted = await db
  .insertInto('users')
  .values({
    name: 'John Doe',
    email: 'john@example.com',
  })
  .returning(['id', 'name', 'email'])
  .execute()

console.log(inserted)
// { id: 1, name: 'John Doe', email: 'john@example.com' }
```

## Model Hooks

Hooks are triggered on insert operations:

```typescript
const db = createQueryBuilder<typeof schema>({
  schema,
  meta,
  hooks: {
    beforeCreate: async ({ table, data }) => {
      console.log(`Creating ${table}:`, data)
      // Modify data, validate, or throw to prevent creation
      return data
    },
    afterCreate: async ({ table, data, result }) => {
      console.log(`Created ${table}:`, result)
      // Trigger notifications, update caches, etc.
    },
  },
})

// Hooks are called automatically
await db.insert('users', {
  name: 'John Doe',
  email: 'john@example.com',
})
```

## Batch Insert Performance

For large datasets, batch insert is highly optimized:

```typescript
// Generate test data
const users = Array.from({ length: 1000 }, (_, i) => ({
  name: `User ${i}`,
  email: `user${i}@example.com`,
  active: true,
}))

// Insert all at once - highly efficient
await db.insertMany('users', users)
```

## Insert with Relations

Insert related records:

```typescript
// First insert the user
const user = await db.insert('users', {
  name: 'John Doe',
  email: 'john@example.com',
})

// Then insert related posts
await db.insertMany('posts', [
  { user_id: user.id, title: 'First Post', content: 'Hello world' },
  { user_id: user.id, title: 'Second Post', content: 'More content' },
])
```

## Insert with Transaction

Wrap inserts in a transaction for atomicity:

```typescript
await db.transaction(async (trx) => {
  const user = await trx.insert('users', {
    name: 'John Doe',
    email: 'john@example.com',
  })

  await trx.insertMany('posts', [
    { user_id: user.id, title: 'Post 1' },
    { user_id: user.id, title: 'Post 2' },
  ])

  // All or nothing - if any insert fails, all are rolled back
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
    },
  },
}

const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

const db = createQueryBuilder<typeof schema>({
  schema,
  meta,
  hooks: {
    beforeCreate: async ({ table, data }) => {
      // Validate email format
      if (data.email && !data.email.includes('@')) {
        throw new Error('Invalid email format')
      }
      return data
    },
    afterCreate: async ({ table, result }) => {
      console.log(`New ${table} created with ID: ${result.id}`)
    },
  },
})

// Insert operations
async function createUsers() {
  // Single insert
  const admin = await db.insert('users', {
    name: 'Admin User',
    email: 'admin@example.com',
    active: true,
  })

  // Batch insert
  await db.insertMany('users', [
    { name: 'User 1', email: 'user1@example.com', active: true },
    { name: 'User 2', email: 'user2@example.com', active: true },
    { name: 'User 3', email: 'user3@example.com', active: false },
  ])

  console.log('Users created successfully')
}

createUsers()
```
