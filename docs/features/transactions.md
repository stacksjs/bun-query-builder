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
await db.transaction(async (tx) => {
  await tx.insertInto('users').values({ name: 'Zed' }).execute()
})
```

All operations within the callback run on the same transaction `tx`.

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

- Keep transactions short to reduce contention
- Prefer higher isolation only when needed; it’s more expensive
- Use retries for workloads prone to deadlocks/serialization failures
- Avoid user interaction inside transactions

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
