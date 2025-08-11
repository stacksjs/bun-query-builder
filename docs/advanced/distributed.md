# Distributed Transactions

Two-phase commit helpers that map to Bun’s distributed APIs.

```ts
await db.beginDistributed('tx1', async tx => {
  await tx.insertInto('users').values({ name: 'Alice' }).execute()
})

await db.commitDistributed('tx1')
// or
await db.rollbackDistributed('tx1')
```

## Best Practices

- Use meaningful transaction names
- Ensure idempotency of operations when possible
