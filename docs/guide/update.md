# UPDATE Operations

Learn how to update existing data in your database using bun-query-builder.

## Basic Update

### Update with Conditions

```typescript
await db
  .update('users')
  .set({ active: false })
  .where({ id: 1 })
  .execute()
```

### Update Multiple Columns

```typescript
await db
  .update('users')
  .set({
    name: 'John Smith',
    email: 'john.smith@example.com',
    updated_at: new Date()
  })
  .where({ id: 1 })
  .execute()
```

## Update with Returning

Return the updated rows:

```typescript
const updated = await db
  .update('users')
  .set({ status: 'verified' })
  .where({ email_verified: true })
  .returning(['id', 'name', 'status'])
  .execute()

console.log(`Updated ${updated.length} users`)
```

## Conditional Updates

### Update with Multiple Conditions

```typescript
await db
  .update('users')
  .set({ subscription: 'expired' })
  .where('subscription_ends_at', '<', new Date())
  .andWhere('subscription', '!=', 'lifetime')
  .execute()
```

### Update with IN Clause

```typescript
await db
  .update('posts')
  .set({ status: 'archived' })
  .whereIn('id', [1, 2, 3, 4, 5])
  .execute()
```

## Increment and Decrement

### Increment Values

```typescript
// Increment a column
await db
  .update('posts')
  .increment('views', 1)
  .where({ id: 1 })
  .execute()

// Increment by custom amount
await db
  .update('users')
  .increment('points', 100)
  .where({ id: userId })
  .execute()
```

### Decrement Values

```typescript
// Decrement a column
await db
  .update('products')
  .decrement('stock', 1)
  .where({ id: productId })
  .execute()

// Ensure non-negative
await db
  .update('products')
  .decrement('stock', quantity)
  .where({ id: productId })
  .where('stock', '>=', quantity)
  .execute()
```

## Batch Updates

### updateMany

Update multiple records matching conditions:

```typescript
await db.updateMany(
  'users',
  { department: 'engineering' },  // where
  { manager_id: newManagerId }     // set
)
```

### Bulk Update with Different Values

```typescript
// Update multiple records with different values
for (const update of updates) {
  await db
    .update('products')
    .set({ price: update.newPrice })
    .where({ id: update.productId })
    .execute()
}

// Or use transaction for atomicity
await db.transaction(async (trx) => {
  for (const update of updates) {
    await trx
      .update('products')
      .set({ price: update.newPrice })
      .where({ id: update.productId })
      .execute()
  }
})
```

## Raw Updates

### Using SQL Expressions

```typescript
await db
  .update('users')
  .set({
    login_count: sql`login_count + 1`,
    last_login: sql`NOW()`
  })
  .where({ id: userId })
  .execute()
```

### JSON Updates

```typescript
// Update JSON field
await db
  .update('users')
  .set({
    preferences: sql`JSON_SET(preferences, '$.theme', 'dark')`
  })
  .where({ id: userId })
  .execute()
```

## Model Hooks

Hooks triggered during updates:

```typescript
const db = createQueryBuilder({
  schema,
  meta,
  hooks: {
    beforeUpdate: async ({ table, data, where }) => {
      // Add audit timestamp
      data.updated_at = new Date()

      // Validate data
      if (table === 'users' && data.email) {
        if (!isValidEmail(data.email)) {
          throw new Error('Invalid email format')
        }
      }

      return data
    },
    afterUpdate: async ({ table, data, where, result }) => {
      // Log changes
      await logChange(table, where, data)

      // Clear cache
      if (table === 'users') {
        await cache.invalidate(`user:${where.id}`)
      }
    }
  }
})
```

## Soft Deletes

### Soft Delete a Record

```typescript
await db
  .update('users')
  .set({ deleted_at: new Date() })
  .where({ id: 1 })
  .execute()
```

### Restore Soft Deleted

```typescript
await db
  .update('users')
  .set({ deleted_at: null })
  .where({ id: 1 })
  .execute()
```

## Examples

### Update User Profile

```typescript
async function updateProfile(userId: number, updates: ProfileUpdate) {
  const allowedFields = ['name', 'bio', 'avatar_url', 'website']

  const sanitized = Object.fromEntries(
    Object.entries(updates).filter(([key]) => allowedFields.includes(key))
  )

  if (Object.keys(sanitized).length === 0) {
    return null
  }

  const user = await db
    .update('users')
    .set(sanitized)
    .where({ id: userId })
    .returning(['id', 'name', 'bio', 'avatar_url', 'website'])
    .execute()

  return user
}
```

### Bulk Status Update

```typescript
async function archiveOldPosts(daysOld: number) {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysOld)

  const result = await db
    .update('posts')
    .set({
      status: 'archived',
      archived_at: new Date()
    })
    .where('created_at', '<', cutoffDate)
    .andWhere('status', '=', 'published')
    .returning(['id'])
    .execute()

  console.log(`Archived ${result.length} posts`)
  return result
}
```

### Inventory Management

```typescript
async function processOrder(orderId: number, items: OrderItem[]) {
  return db.transaction(async (trx) => {
    for (const item of items) {
      // Check stock
      const product = await trx
        .selectFrom('products')
        .where({ id: item.product_id })
        .first()

      if (product.stock < item.quantity) {
        throw new Error(`Insufficient stock for ${product.name}`)
      }

      // Decrement stock
      await trx
        .update('products')
        .decrement('stock', item.quantity)
        .where({ id: item.product_id })
        .execute()
    }

    // Update order status
    await trx
      .update('orders')
      .set({ status: 'processing' })
      .where({ id: orderId })
      .execute()
  })
}
```

### Optimistic Locking

```typescript
async function updateWithVersion(
  table: string,
  id: number,
  data: Record<string, any>,
  currentVersion: number
) {
  const result = await db
    .update(table)
    .set({
      ...data,
      version: currentVersion + 1
    })
    .where({ id })
    .andWhere('version', '=', currentVersion)
    .execute()

  if (result.rowsAffected === 0) {
    throw new Error('Concurrent modification detected')
  }

  return result
}
```

## Performance Tips

1. **Use Indexes**: Ensure WHERE clause columns are indexed
2. **Batch Updates**: Use updateMany for bulk operations
3. **Limit Scope**: Be specific with WHERE conditions
4. **Use Transactions**: Group related updates

```typescript
// Good: Targeted update with index
await db.update('users').set({ active: false }).where({ id: 1 }).execute()

// Avoid: Table scan
await db.update('users').set({ active: false }).where('name', 'LIKE', '%test%').execute()
```

## Next Steps

- Learn about [SELECT queries](./select.md)
- Explore [WHERE conditions](./where.md)
- Master [transactions](./transactions.md)
