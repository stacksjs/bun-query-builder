# Transactions

Robust transaction helpers built on Bun’s `sql.begin`, with retries, isolation levels, savepoints, distributed transactions, and configurable backoff.

## Table of Contents

- Overview
- Basic Usage
- Isolation Levels
- Retries and Backoff
- Savepoints
- Distributed Transactions
- Transaction-scoped Builder
- Transaction Defaults
- Transaction Decorator
- Error Handling and Logging
- Best Practices
- Recipes
- FAQ

## Overview

The builder wraps Bun’s transaction primitives and adds:

- Automatic retries on serialization/deadlock errors
- Configurable isolation (`read committed`, `repeatable read`, `serializable`)
- Exponential backoff with jitter
- Savepoints inside a transaction
- Two-phase distributed transactions

## Basic Usage

```ts
// Simple transaction with automatic rollback on error
await db.transaction(async (tx) => {
  const user = await tx.insertInto('users').values({
    name: 'Chris',
    email: 'chris@example.com',
    role: 'admin'
  }).returning('id').execute()

  await tx.insertInto('user_profiles').values({
    user_id: user[0].id,
    bio: 'Software engineer and team lead',
    location: 'San Francisco'
  }).execute()
})

// Multi-step business logic in a transaction
async function transferProjectOwnership(projectId: number, fromUserId: number, toUserId: number) {
  return await db.transaction(async (tx) => {
    // Verify current ownership
    const project = await tx
      .selectFrom('projects')
      .where({ id: projectId, owner_id: fromUserId })
      .first()

    if (!project) {
      throw new Error('Project not found or not owned by user')
    }

    // Transfer ownership
    await tx
      .updateTable('projects')
      .set({
        owner_id: toUserId,
        transferred_at: new Date(),
        transferred_by: fromUserId
      })
      .where({ id: projectId })
      .execute()

    // Log the transfer
    await tx.insertInto('audit_logs').values({
      action: 'project_transferred',
      project_id: projectId,
      from_user_id: fromUserId,
      to_user_id: toUserId,
      created_at: new Date()
    }).execute()

    return project
  })
}
```

**Key Benefits:**
- All operations within the callback run on the same transaction `tx`
- Automatic rollback if any operation throws an error
- Type-safe operations with full query builder API
- Configurable retry behavior for transient failures

## Isolation Levels

```ts
await db.transaction(async (tx) => {
  // work
}, { isolation: 'serializable' })
```

Use `read committed` (default), `repeatable read`, or `serializable` per workload resiliency.

## Retries and Backoff

```ts
await db.transaction(async (tx) => {
  await tx.updateTable('accounts').set({ balance: 10 }).where(['id', '=', 1]).execute()
}, {
  retries: 3,
  sqlStates: ['40001', '40P01'],
  backoff: { baseMs: 100, factor: 2, maxMs: 5_000, jitter: true },
  onRetry: (attempt, err) => console.warn('retry', attempt, err),
  afterCommit: () => console.log('committed'),
})
```

Retries trigger on common serialization/deadlock errors and when `sqlStates` match.

## Savepoints

```ts
await db.transaction(async (tx) => {
  await tx.savepoint(async (sp) => {
    await sp.updateTable('orders').set({ status: 'processing' }).where(['id', '=', 1]).execute()
  })
})
```

Use savepoints for partial rollbacks within a larger transaction.

## Distributed Transactions

```ts
await db.beginDistributed('tx1', async (tx) => {
  await tx.insertInto('users').values({ name: 'Alice' }).execute()
})
await db.commitDistributed('tx1')
// or
await db.rollbackDistributed('tx1')
```

Useful for workflows spanning services that coordinate commits.

## Transaction-scoped Builder

Within `transaction`, the `tx` object exposes the entire QueryBuilder API, scoped to the transaction.

```ts
await db.transaction(async (tx) => {
  const users = await tx.selectFrom('users').limit(5).execute()
  await tx.updateTable('users').set({ active: false }).where(['id', 'in', users.map(u => u.id)]).execute()
})
```

## Transaction Defaults

Set global defaults for transactions (retries, isolation, backoff):

```ts
db.setTransactionDefaults({ retries: 2, isolation: 'repeatable read' })
```

## Transaction Decorator

Wrap a function so it always executes in a transaction.

```ts
const createUser = db.transactional(async (tx, input: { name: string }) => {
  await tx.insertInto('users').values({ name: input.name }).execute()
})

await createUser({ name: 'Alice' })
```

You can pass options to override defaults:

```ts
const createWithRetry = db.transactional(async (tx) => { /* ... */ }, { retries: 3 })
```

## Error Handling and Logging

Use `onRetry` and `logger` to observe transaction lifecycle.

```ts
await db.transaction(async (tx) => { /* ... */ }, {
  logger: (e) => {
    if (e.type === 'retry')
      console.warn('retry', e.attempt)
    if (e.type === 'commit')
      console.log('commit in', e.durationMs)
  },
})
```

## Best Practices

### Transaction Design

- **Keep Transactions Short**: Minimize the time between BEGIN and COMMIT to reduce lock contention
- **Atomic Operations**: Group related operations that must succeed or fail together
- **Avoid User Interaction**: Never wait for user input inside a transaction
- **Database Operations Only**: Keep business logic outside transactions when possible

```ts
// Good: Short, focused transaction
async function createTeamMember(userData: any) {
  // Validate data BEFORE transaction
  if (!userData.email || !userData.team_id) {
    throw new Error('Invalid user data')
  }

  return await db.transaction(async (tx) => {
    const user = await tx.create('users', userData)
    await tx.create('team_memberships', {
      user_id: user.id,
      team_id: userData.team_id,
      role: 'member'
    })
    return user
  })
}

// Avoid: Long-running operations in transaction
async function badExample() {
  await db.transaction(async (tx) => {
    const user = await tx.create('users', { name: 'Chris' })

    // BAD: External API call inside transaction
    await sendWelcomeEmail(user.email) // This might timeout!

    // BAD: User interaction
    const confirmed = await promptUser('Continue?') // Don't do this!

    if (confirmed) {
      await tx.create('profiles', { user_id: user.id })
    }
  })
}
```

### Isolation and Performance

- **Choose Appropriate Isolation**: Use the lowest isolation level that maintains data integrity
- **Read Committed**: Default; good for most applications
- **Repeatable Read**: Use when you need consistent reads within the transaction
- **Serializable**: Only when strict consistency is required; highest overhead

```ts
// Financial transactions need serializable isolation
async function transferFunds(fromAccount: number, toAccount: number, amount: number) {
  return await db.transaction(async (tx) => {
    const fromBalance = await tx
      .selectFrom('accounts')
      .where({ id: fromAccount })
      .select('balance')
      .first()

    if (fromBalance.balance < amount) {
      throw new Error('Insufficient funds')
    }

    await tx.updateTable('accounts')
      .set({ balance: db.sql`balance - ${amount}` })
      .where({ id: fromAccount })
      .execute()

    await tx.updateTable('accounts')
      .set({ balance: db.sql`balance + ${amount}` })
      .where({ id: toAccount })
      .execute()
  }, { isolation: 'serializable', retries: 3 })
}

// Regular business operations can use default isolation
async function updateUserProfile(userId: number, profileData: any) {
  return await db.transaction(async (tx) => {
    await tx.updateTable('users')
      .set({ updated_at: new Date() })
      .where({ id: userId })
      .execute()

    await tx.updateOrCreate('profiles', { user_id: userId }, profileData)
  }) // Uses default 'read committed'
}
```

### Error Handling and Retries

- **Configure Retries**: Set appropriate retry counts for transient failures
- **Exponential Backoff**: Use jitter to avoid thundering herd problems
- **Specific Error Handling**: Handle business logic errors vs database errors differently
- **Logging**: Log retry attempts and transaction metrics

```ts
// Configure retries for high-contention operations
async function highContentionOperation(data: any) {
  return await db.transaction(async (tx) => {
    // Operations that might conflict with other transactions
    await tx.updateTable('counters')
      .set({ value: db.sql`value + 1` })
      .where({ name: 'page_views' })
      .execute()
  }, {
    retries: 5,
    backoff: { baseMs: 100, factor: 2, maxMs: 2000, jitter: true },
    onRetry: (attempt, error) => {
      console.warn(`Transaction retry ${attempt}:`, error.message)
    }
  })
}

// Separate business logic errors from retryable database errors
async function processOrder(orderData: any) {
  try {
    return await db.transaction(async (tx) => {
      // Business validation INSIDE transaction for data consistency
      const inventory = await tx
        .selectFrom('products')
        .where({ id: orderData.product_id })
        .select('stock_quantity')
        .first()

      if (inventory.stock_quantity < orderData.quantity) {
        // Business logic error - don't retry
        throw new BusinessError('Insufficient stock')
      }

      // Update inventory
      await tx.updateTable('products')
        .set({ stock_quantity: db.sql`stock_quantity - ${orderData.quantity}` })
        .where({ id: orderData.product_id })
        .execute()

      // Create order
      return await tx.create('orders', orderData)
    }, { retries: 3 })
  }
  catch (error) {
    if (error instanceof BusinessError) {
      // Don't retry business logic errors
      throw error
    }
    // Database errors will be retried automatically
    throw error
  }
}

class BusinessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BusinessError'
  }
}
```

### Resource Management

- **Connection Pooling**: Configure appropriate pool sizes for your transaction load
- **Timeout Configuration**: Set reasonable timeouts for long-running transactions
- **Memory Usage**: Be mindful of result set sizes in transactions
- **Deadlock Prevention**: Order table access consistently to prevent deadlocks

```ts
// Configure transaction defaults globally
db.setTransactionDefaults({
  retries: 2,
  isolation: 'read committed',
  backoff: { baseMs: 50, factor: 2, maxMs: 1000, jitter: true }
})

// Consistent table access order to prevent deadlocks
async function updateUserAndTeam(userId: number, teamId: number, updates: any) {
  return await db.transaction(async (tx) => {
    // Always access tables in the same order (users before teams)
    await tx.updateTable('users')
      .set(updates.user)
      .where({ id: userId })
      .execute()

    await tx.updateTable('teams')
      .set(updates.team)
      .where({ id: teamId })
      .execute()
  })
}
```

## Recipes

### Idempotent operations with retries

```ts
await db.transaction(async (tx) => {
  await tx.insertOrIgnore('events', { id: 'evt_1', payload: {} })
}, { retries: 5 })
```

### Batch updates with savepoints

```ts
await db.transaction(async (tx) => {
  for (const id of [1, 2, 3, 4]) {
    await tx.savepoint(async (sp) => {
      await sp.updateTable('jobs').set({ status: 'done' }).where(['id', '=', id]).execute()
    })
  }
})
```

### Saga-style partial commits (distributed)

```ts
await db.beginDistributed('stage_a', async (tx) => {
  await tx.insertInto('orders').values({ id: 1, status: 'created' }).execute()
})
// later
await db.commitDistributed('stage_a')
```

## FAQ

### Why did my transaction retry?

Detected a retriable error (deadlock/serialization or matching `sqlStates`).

### How can I set isolation per operation?

Pass `isolation` in the transaction options.

### Can I run read-only transactions?

Yes. Pass `{ readOnly: true }` to `transaction` when your database supports it (e.g., PostgreSQL).

```ts
await db.transaction(async (tx) => {
  await tx.selectFrom('users').limit(10).execute()
}, { readOnly: true })
```

### Can I nest transactions?

Use `savepoint` within a transaction. Starting a new top-level transaction inside another is not supported.

---

## Additional Examples and Variants

### Transaction-scoped selects and updates

```ts
await db.transaction(async (tx) => {
  const toDisable = await tx.selectFrom('users').where({ active: true }).limit(100).execute()
  await tx.updateTable('users').set({ active: false }).where(['id', 'in', toDisable.map(u => u.id)]).execute()
})
```

### Serializable reads with retries

```ts
await db.transaction(async (tx) => {
  const totals = await tx
    .selectFrom('orders')
    .groupBy('customer_id')
    .selectRaw(db.sql`SUM(total) as total`)
    .execute()
  // ...work with totals
}, { isolation: 'serializable', retries: 2 })
```

### Savepoint rollbacks on partial failures

```ts
await db.transaction(async (tx) => {
  for (const id of [10, 11, 12]) {
    await tx.savepoint(async (sp) => {
      await sp.updateTable('jobs').set({ status: 'done' }).where(['id', '=', id]).execute()
    })
  }
})
```

### Distributed transaction orchestration

```ts
await db.beginDistributed('orchestrate_1', async (tx) => {
  await tx.insertInto('workflows').values({ id: 1, status: 'pending' }).execute()
})
// do external work
await db.commitDistributed('orchestrate_1')
```

### Decorator usage with options

```ts
const critical = db.transactional(async (tx, payload: any) => {
  await tx.insertInto('events').values(payload).execute()
}, { retries: 3, isolation: 'repeatable read' })

await critical({ type: 'signup', user_id: 1 })
```

### Logging and metrics

```ts
await db.transaction(async (tx) => {
  // ...work
}, {
  logger: (e) => {
    if (e.type === 'retry')
      console.warn('[tx] retry', e.attempt)
    if (e.type === 'commit')
      console.info('[tx] committed in', e.durationMs, 'ms')
  },
})
```
