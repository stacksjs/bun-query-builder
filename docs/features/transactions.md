# Transactions

Robust transaction helpers built on Bun’s `sql.begin`.

## Basics

```ts
await db.transaction(async tx => {
  await tx.insertInto('users').values({ name: 'Zed' }).execute()
}, {
  retries: 3,
  isolation: 'serializable',
  onRetry: (attempt, err) => console.warn('retry', attempt, err),
  afterCommit: () => console.log('committed'),
})
```

## Savepoints

```ts
await db.transaction(async tx => {
  await tx.savepoint(async sp => {
    await sp.updateTable('orders').set({ status: 'processing' }).where(['id', '=', 1]).execute()
  })
})
```

## Distributed

```ts
await db.beginDistributed('tx1', async tx => { /* ... */ })
await db.commitDistributed('tx1')
```

## Best Practices

- Use retries for serialization/deadlock-prone workloads
- Log retries and use exponential backoff (default)
- Keep transactions short and deterministic
