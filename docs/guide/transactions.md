# Transactions

Learn how to manage database transactions for atomic operations.

## Basic Transactions

Wrap multiple operations in a transaction to ensure they all succeed or all fail:

```typescript
import { transaction } from 'bun-query-builder'

await transaction(async (trx) => {
  // All operations use the transaction connection
  await trx
    .insertInto('accounts')
    .values({ user_id: 1, balance: 1000 })
    .execute()

  await trx
    .updateTable('users')
    .set({ has_account: true })
    .where({ id: 1 })
    .execute()
})
// Transaction is automatically committed on success
// or rolled back on error
```

## Transaction Options

Configure transaction behavior:

```typescript
await transaction(
  async (trx) => {
    // Your operations
  },
  {
    // Retry configuration
    retries: 3,
    retryDelay: 100,           // Base delay in ms
    retryDelayMultiplier: 2,   // Exponential backoff

    // Isolation level
    isolationLevel: 'serializable',

    // Callbacks
    onRetry: (error, attempt) => {
      console.log(`Retry ${attempt} after error:`, error.message)
    },
    afterCommit: async () => {
      console.log('Transaction committed successfully')
    }
  }
)
```

## Isolation Levels

Control transaction isolation:

```typescript
// Read uncommitted (fastest, least safe)
await transaction(fn, { isolationLevel: 'read uncommitted' })

// Read committed (default for most databases)
await transaction(fn, { isolationLevel: 'read committed' })

// Repeatable read
await transaction(fn, { isolationLevel: 'repeatable read' })

// Serializable (slowest, most safe)
await transaction(fn, { isolationLevel: 'serializable' })
```

## Savepoints

Create savepoints within a transaction:

`savepoint()` takes a callback, like `transaction()` does — there is no
`rollbackToSavepoint()`. The savepoint is released when the callback returns and
rolled back if it throws, so "roll back to the savepoint" means "let the
callback throw and catch it outside".

```typescript
await db.transaction(async (trx) => {
  await trx.insertInto('logs').values({ message: 'Step 1' }).execute()

  try {
    await trx.savepoint(async (sp) => {
      await sp.insertInto('logs').values({ message: 'Step 2' }).execute()
      // Something fails — only the savepoint's work is undone
      throw new Error('Step 2 failed')
    })
  }
  catch {
    // Step 1 is preserved; the transaction itself is still alive
    await trx.insertInto('logs').values({ message: 'Step 2 fallback' }).execute()
  }

  await trx.insertInto('logs').values({ message: 'Step 3' }).execute()
})
```

`savepoint()` must be called inside a transaction; calling it outside throws.

## Commit and rollback

There is no manual `beginTransaction()` / `commit()` / `rollback()` API. The
callback form owns the lifecycle: return normally and the transaction commits,
throw and it rolls back.

```typescript
await db.transaction(async (tx) => {
  await tx.insertInto('users').values({ name: 'Test' }).execute()
  await tx.updateTable('counters').set({ value: db.raw('value + 1') }).execute()
  // committed when this callback returns
})
```

To roll back deliberately, throw — then handle the error outside:

```typescript
try {
  await db.transaction(async (tx) => {
    await tx.insertInto('users').values({ name: 'Test' }).execute()
    if (!ok)
      throw new Error('rolling back')
  })
}
catch (error) {
  // the transaction has already rolled back by the time you get here
}
```

Use `tx`, not `db`, for every statement inside the callback. `db` holds a
different connection, so work issued through it is not part of the transaction
and will not be rolled back with it.

## Nested Transactions

Handle nested transactions with savepoints:

```typescript
await transaction(async (trx) => {
  await trx.insertInto('orders').values(order).execute()

  // Nested transaction creates a savepoint
  await trx.transaction(async (innerTrx) => {
    for (const item of items) {
      await innerTrx.insertInto('order_items').values(item).execute()
    }
  })

  await trx.updateTable('inventory').set(/* ... */).execute()
})
```

## Error Handling

```typescript
try {
  await transaction(async (trx) => {
    await trx.insertInto('accounts').values({ balance: 1000 }).execute()

    // This will cause the transaction to rollback
    if (someCondition) {
      throw new Error('Business logic error')
    }

    await trx.updateTable('accounts').set({ balance: 500 }).execute()
  })
} catch (error) {
  console.error('Transaction failed:', error.message)
  // All operations have been rolled back
}
```

## Retry with Backoff

Handle transient failures with automatic retry:

```typescript
await transaction(
  async (trx) => {
    // This might fail due to lock contention
    await trx
      .updateTable('accounts')
      .set({ balance: db.raw('balance - ?', [100]) })
      .where({ id: 1 })
      .execute()
  },
  {
    retries: 5,
    retryDelay: 50,
    retryDelayMultiplier: 2,
    onRetry: (error, attempt) => {
      console.log(`Attempt ${attempt} failed, retrying...`)
    }
  }
)
```

## Examples

### Money Transfer

```typescript
async function transferMoney(
  fromAccountId: number,
  toAccountId: number,
  amount: number
) {
  await transaction(async (trx) => {
    // Deduct from source account
    const fromAccount = await trx
      .selectFrom('accounts')
      .where({ id: fromAccountId })
      .forUpdate() // Lock the row
      .executeTakeFirst()

    if (!fromAccount || fromAccount.balance < amount) {
      throw new Error('Insufficient funds')
    }

    await trx
      .updateTable('accounts')
      .set({ balance: fromAccount.balance - amount })
      .where({ id: fromAccountId })
      .execute()

    // Add to destination account
    await trx
      .updateTable('accounts')
      .set({ balance: db.raw('balance + ?', [amount]) })
      .where({ id: toAccountId })
      .execute()

    // Record the transfer
    await trx
      .insertInto('transfers')
      .values({
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        amount,
        created_at: new Date()
      })
      .execute()
  }, {
    isolationLevel: 'serializable',
    retries: 3
  })
}
```

### Order Placement with Inventory Check

```typescript
async function placeOrder(userId: number, items: OrderItem[]) {
  return transaction(async (trx) => {
    // Create order
    const order = await trx
      .insertInto('orders')
      .values({
        user_id: userId,
        status: 'pending',
        created_at: new Date()
      })
      .returning(['id'])
      .executeTakeFirst()

    let total = 0

    for (const item of items) {
      // Check and lock inventory
      const product = await trx
        .selectFrom('products')
        .where({ id: item.productId })
        .forUpdate()
        .executeTakeFirst()

      if (!product || product.stock < item.quantity) {
        throw new Error(`Insufficient stock for product ${item.productId}`)
      }

      // Create order item
      await trx
        .insertInto('order_items')
        .values({
          order_id: order.id,
          product_id: item.productId,
          quantity: item.quantity,
          price: product.price
        })
        .execute()

      // Reduce inventory
      await trx
        .updateTable('products')
        .set({ stock: product.stock - item.quantity })
        .where({ id: item.productId })
        .execute()

      total += product.price * item.quantity
    }

    // Update order total
    await trx
      .updateTable('orders')
      .set({ total, status: 'confirmed' })
      .where({ id: order.id })
      .execute()

    return order
  }, {
    afterCommit: async () => {
      // Send order confirmation email
      await sendOrderConfirmation(userId, order.id)
    }
  })
}
```

### Batch Processing with Checkpoints

Wrap each chunk in its own savepoint. A chunk that throws is undone on its own,
and the surrounding transaction — and every chunk before it — survives.

```typescript
async function processBatch(records: any[]) {
  const failed: number[] = []

  await db.transaction(async (trx) => {
    for (let i = 0; i < records.length; i += 100) {
      const chunk = records.slice(i, i + 100)

      try {
        await trx.savepoint(async (sp) => {
          for (const record of chunk)
            await processRecord(sp, record)
        })
      }
      catch (error) {
        // Only this chunk rolled back; earlier chunks are intact.
        console.error(`Failed in chunk starting at ${i}:`, error)
        failed.push(i)
      }
    }
  })

  return failed
}
```

## Best Practices

1. **Keep Transactions Short**: Long-running transactions can cause lock contention
2. **Use Appropriate Isolation**: Choose the lowest isolation level that ensures correctness
3. **Handle Errors**: Always catch and handle transaction errors appropriately
4. **Use Retries for Transient Failures**: Database locks can cause temporary failures
5. **Avoid User Interaction**: Don't wait for user input inside a transaction
6. **Test Rollback Scenarios**: Ensure your application handles rollbacks correctly

## Next Steps

- Go back to [select queries](./select.md)
- Learn about [where clauses](./where.md)
- Explore [joins](./join.md)
