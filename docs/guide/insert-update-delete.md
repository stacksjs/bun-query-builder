# Insert, Update, and Delete

Learn how to manipulate data in your database with bun-query-builder.

## Insert Operations

### Single Insert

```typescript
// Basic insert
const result = await db
  .insertInto('users')
  .values({
    name: 'John Doe',
    email: 'john@example.com',
    active: true
  })
  .execute()

console.log(result.insertId) // New record ID
```

### Insert with Returning

Get inserted data back:

```typescript
const user = await db
  .insertInto('users')
  .values({
    name: 'Jane Doe',
    email: 'jane@example.com'
  })
  .returning(['id', 'name', 'email', 'created_at'])
  .executeTakeFirst()
```

### Batch Insert

Insert multiple records efficiently:

```typescript
await db.insertMany('users', [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Charlie', email: 'charlie@example.com' }
])
```

### Insert or Ignore

Skip if duplicate key exists:

```typescript
await db
  .insertInto('users')
  .values({ email: 'existing@example.com', name: 'Test' })
  .onConflict('email')
  .doNothing()
  .execute()
```

### Upsert (Insert or Update)

Insert or update on conflict:

```typescript
await db
  .insertInto('users')
  .values({
    email: 'user@example.com',
    name: 'New Name',
    login_count: 1
  })
  .onConflict('email')
  .doUpdate({
    name: 'New Name',
    login_count: db.raw('login_count + 1')
  })
  .execute()
```

## Update Operations

### Basic Update

```typescript
await db
  .update('users')
  .set({ active: false })
  .where({ id: 1 })
  .execute()
```

### Update Multiple Fields

```typescript
await db
  .update('users')
  .set({
    name: 'Updated Name',
    email: 'new@example.com',
    updated_at: new Date()
  })
  .where({ id: 1 })
  .execute()
```

### Increment/Decrement

```typescript
// Increment a value
await db
  .update('products')
  .set({
    views: db.raw('views + 1')
  })
  .where({ id: productId })
  .execute()

// Decrement stock
await db
  .update('products')
  .set({
    stock: db.raw('stock - ?', [quantity])
  })
  .where({ id: productId })
  .execute()
```

### Batch Update

Update multiple records matching a condition:

```typescript
await db.updateMany(
  'users',
  { status: 'inactive' },       // Condition
  { active: false, notified: true }  // Values to set
)
```

### Update with Subquery

```typescript
await db
  .update('products')
  .set({
    category_id: db.subquery(
      db.selectFrom('categories')
        .select(['id'])
        .where({ name: 'Electronics' })
    )
  })
  .where({ type: 'gadget' })
  .execute()
```

## Delete Operations

### Basic Delete

```typescript
await db
  .deleteFrom('users')
  .where({ id: 1 })
  .execute()
```

### Delete with Multiple Conditions

```typescript
await db
  .deleteFrom('sessions')
  .where('created_at', '<', oneWeekAgo)
  .andWhere({ active: false })
  .execute()
```

### Batch Delete

Delete multiple records by IDs:

```typescript
await db.deleteMany('users', [1, 2, 3, 4, 5])
```

### Delete All

```typescript
// Delete all records (use with caution!)
await db.deleteFrom('temp_data').execute()

// Truncate table (faster, resets auto-increment)
await db.truncate('temp_data')
```

## Soft Deletes

### Soft Delete a Record

```typescript
// Instead of deleting, set deleted_at
await db
  .update('users')
  .set({ deleted_at: new Date() })
  .where({ id: 1 })
  .execute()
```

### Query Non-Deleted Records

```typescript
const activeUsers = await db
  .selectFrom('users')
  .whereNull('deleted_at')
  .get()
```

### Restore Soft-Deleted Record

```typescript
await db
  .update('users')
  .set({ deleted_at: null })
  .where({ id: 1 })
  .execute()
```

## Examples

### User Registration

```typescript
async function registerUser(data: UserRegistration) {
  return db.transaction(async (trx) => {
    // Create user
    const user = await trx
      .insertInto('users')
      .values({
        email: data.email,
        password_hash: await hashPassword(data.password),
        created_at: new Date()
      })
      .returning(['id', 'email'])
      .executeTakeFirst()

    // Create profile
    await trx
      .insertInto('profiles')
      .values({
        user_id: user.id,
        name: data.name,
        bio: data.bio || null
      })
      .execute()

    // Assign default role
    await trx
      .insertInto('user_roles')
      .values({
        user_id: user.id,
        role_id: 1 // Default user role
      })
      .execute()

    return user
  })
}
```

### Order Processing

```typescript
async function processOrder(orderId: number) {
  await db.transaction(async (trx) => {
    // Update order status
    await trx
      .update('orders')
      .set({
        status: 'processing',
        processed_at: new Date()
      })
      .where({ id: orderId })
      .execute()

    // Get order items
    const items = await trx
      .selectFrom('order_items')
      .where({ order_id: orderId })
      .get()

    // Decrement stock for each item
    for (const item of items) {
      await trx
        .update('products')
        .set({
          stock: db.raw('stock - ?', [item.quantity])
        })
        .where({ id: item.product_id })
        .execute()
    }

    // Create shipment record
    await trx
      .insertInto('shipments')
      .values({
        order_id: orderId,
        status: 'pending',
        created_at: new Date()
      })
      .execute()
  })
}
```

### Bulk Status Update

```typescript
async function deactivateInactiveUsers(daysInactive: number) {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - daysInactive)

  const result = await db
    .update('users')
    .set({
      active: false,
      deactivated_at: new Date(),
      deactivation_reason: 'inactivity'
    })
    .where('last_login_at', '<', cutoffDate)
    .andWhere({ active: true })
    .execute()

  console.log(`Deactivated ${result.rowCount} users`)
  return result.rowCount
}
```

## Model Hooks

Hooks are called during insert, update, and delete operations:

```typescript
const db = createQueryBuilder({
  schema,
  meta,
  hooks: {
    beforeCreate: async ({ table, data }) => {
      // Validate or modify data before insert
      if (table === 'users') {
        data.created_at = new Date()
      }
    },
    afterCreate: async ({ table, data, result }) => {
      // Log, notify, etc.
      if (table === 'orders') {
        await sendOrderConfirmation(result.id)
      }
    },
    beforeUpdate: async ({ table, data, where }) => {
      // Add updated_at timestamp
      data.updated_at = new Date()
    },
    beforeDelete: async ({ table, where }) => {
      // Prevent deletion of system records
      if (table === 'users' && where.role === 'admin') {
        throw new Error('Cannot delete admin users')
      }
    }
  }
})
```

## Next Steps

- Learn about [transactions](./transactions.md)
- Go back to [select queries](./select.md)
- Explore [joins](./join.md)
