# INSERT Operations

Learn how to insert data into your database using bun-query-builder.

## Basic Insert

### Single Record

```typescript
const user = await db
  .insertInto('users')
  .values({
    name: 'John Doe',
    email: 'john@example.com',
    active: true
  })
  .execute()
```

### With Returning

Return the inserted row:

```typescript
const user = await db
  .insertInto('users')
  .values({
    name: 'Jane Doe',
    email: 'jane@example.com'
  })
  .returning(['id', 'name', 'email'])
  .execute()

console.log(user.id) // Auto-generated ID
```

## Multiple Records

### insertMany

Insert multiple records efficiently:

```typescript
await db.insertMany('users', [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Charlie', email: 'charlie@example.com' }
])
```

### Batch Insert with Values

```typescript
const users = await db
  .insertInto('users')
  .values([
    { name: 'User 1', email: 'user1@example.com' },
    { name: 'User 2', email: 'user2@example.com' },
    { name: 'User 3', email: 'user3@example.com' }
  ])
  .execute()
```

## Insert with Timestamps

Automatic timestamp handling:

```typescript
// If your model has timestamps enabled
const user = await db
  .insertInto('users')
  .values({
    name: 'John',
    email: 'john@example.com'
  })
  .execute()

// created_at and updated_at are automatically set
```

## Insert or Update (Upsert)

### On Conflict Do Update

```typescript
const user = await db
  .insertInto('users')
  .values({
    email: 'john@example.com',
    name: 'John Doe',
    login_count: 1
  })
  .onConflict('email')
  .doUpdate({
    name: 'John Doe',
    login_count: sql`login_count + 1`
  })
  .execute()
```

### On Conflict Do Nothing

```typescript
await db
  .insertInto('users')
  .values({
    email: 'john@example.com',
    name: 'John'
  })
  .onConflict('email')
  .doNothing()
  .execute()
```

## Insert from Select

Insert data from another query:

```typescript
await db
  .insertInto('archived_orders')
  .columns(['user_id', 'total', 'created_at'])
  .select(
    db.selectFrom('orders')
      .select(['user_id', 'total', 'created_at'])
      .where('status', '=', 'completed')
      .where('created_at', '<', '2023-01-01')
  )
  .execute()
```

## Model Hooks

Hooks are triggered during insert operations:

```typescript
const db = createQueryBuilder({
  schema,
  meta,
  hooks: {
    beforeCreate: async ({ table, data }) => {
      // Modify data before insert
      if (table === 'users') {
        data.slug = slugify(data.name)
      }
      return data
    },
    afterCreate: async ({ table, data, result }) => {
      // Trigger side effects
      if (table === 'users') {
        await sendWelcomeEmail(result.email)
      }
    }
  }
})
```

## Examples

### User Registration

```typescript
async function registerUser(userData: UserInput) {
  // Hash password before insert
  const hashedPassword = await hashPassword(userData.password)

  const user = await db
    .insertInto('users')
    .values({
      name: userData.name,
      email: userData.email,
      password: hashedPassword,
      email_verified_at: null,
      active: true
    })
    .returning(['id', 'name', 'email'])
    .execute()

  // Create default settings
  await db
    .insertInto('user_settings')
    .values({
      user_id: user.id,
      theme: 'light',
      notifications: true
    })
    .execute()

  return user
}
```

### Bulk Import with Transaction

```typescript
async function importUsers(csvData: UserRow[]) {
  return db.transaction(async (trx) => {
    const batchSize = 100
    const results = []

    for (let i = 0; i < csvData.length; i += batchSize) {
      const batch = csvData.slice(i, i + batchSize)

      const inserted = await trx
        .insertInto('users')
        .values(batch.map(row => ({
          name: row.name,
          email: row.email,
          department: row.department
        })))
        .returning(['id'])
        .execute()

      results.push(...inserted)
    }

    return results
  })
}
```

### Insert with Default Values

```typescript
// Model with defaults
const Post = {
  name: 'Post',
  table: 'posts',
  attributes: {
    status: { default: 'draft' },
    views: { default: 0 },
    published_at: { default: null }
  }
}

// Only required fields
const post = await db
  .insertInto('posts')
  .values({
    title: 'My First Post',
    body: 'Hello, World!',
    user_id: 1
  })
  .execute()

// status defaults to 'draft', views to 0
```

## Performance Tips

1. **Use insertMany for Bulk Operations**: More efficient than individual inserts
2. **Batch Large Imports**: Process in chunks of 100-1000 records
3. **Use Transactions**: Group related inserts in transactions
4. **Avoid N+1**: Insert related data in batches

```typescript
// Good: Batch insert
await db.insertMany('items', items)

// Avoid: Individual inserts in loop
for (const item of items) {
  await db.insertInto('items').values(item).execute()
}
```

## Next Steps

- Learn about [UPDATE operations](./update.md)
- Explore [WHERE conditions](./where.md)
- Master [transactions](./transactions.md)
