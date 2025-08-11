# Distributed Transactions

Two-phase commit helpers that map to Bun’s distributed APIs. Useful when coordinating state changes across services or processes where a standard single-connection transaction is insufficient.

## Table of Contents

- Overview
- When to Use Distributed Transactions
- API
- Examples
- Idempotency and Retry Safety
- Failure Handling
- Best Practices
- FAQ

## Overview

Distributed transactions decouple the begin/commit steps and allow coordination across boundaries. They are an advanced feature and should be used sparingly.

## When to Use

- Multi-service workflows where each service must confirm before global commit
- Long-running processes where you need to stage changes and commit later

## API

```ts
await db.beginDistributed('txn_name', async tx => {
  await tx.insertInto('users').values({ name: 'Alice' }).execute()
})

await db.commitDistributed('txn_name')
// or
await db.rollbackDistributed('txn_name')
```

`txn_name` must be globally unique for the time window where it’s active.

## Examples

### Orchestrated multi-step process

```ts
// stage
await db.beginDistributed('provision_user_123', async tx => {
  await tx.insertInto('users').values({ id: 123, status: 'pending' }).execute()
})

// verify external systems
await provisionExternalResources()

// commit
await db.commitDistributed('provision_user_123')
```

### Rollback on failure

```ts
try {
  await db.beginDistributed('batch_txn', async tx => {
    await tx.insertInto('jobs').values({ id: 1 }).execute()
  })
  await runWorker()
  await db.commitDistributed('batch_txn')
} catch (e) {
  await db.rollbackDistributed('batch_txn')
}
```

## Idempotency and Retry Safety

- Make operations idempotent where possible (e.g., use `insertOrIgnore`)
- Use application-level de-duplication keys for external calls

## Failure Handling

- Always pair `beginDistributed` with either `commitDistributed` or `rollbackDistributed`
- Consider timeouts and compensating actions if external systems fail

## Best Practices

- Use meaningful transaction names
- Ensure idempotency of operations when possible
- Prefer regular transactions unless coordination requires distributed semantics

## FAQ

### Is this the same as XA or Sagas?

This provides primitives similar to two-phase commit; for complex workflows, consider a Saga orchestrator.

### What happens if the process crashes before commit?

On restart, decide whether to commit or rollback based on your orchestration state.
