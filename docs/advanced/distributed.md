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
await db.beginDistributed('txn_name', async (tx) => {
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
await db.beginDistributed('provision_user_123', async (tx) => {
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
  await db.beginDistributed('batch_txn', async (tx) => {
    await tx.insertInto('jobs').values({ id: 1 }).execute()
  })
  await runWorker()
  await db.commitDistributed('batch_txn')
}
catch (e) {
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

---

## Patterns

### Coordinator Pattern

One service acts as a coordinator that begins a distributed transaction, informs participants, and commits when all participants signal readiness.

### Outbox Pattern

Pair DB changes with an outbox table entry in the same transaction; a background worker publishes events reliably.

## Sequence Outline

1. Begin distributed txn with name
2. Apply DB changes in participant A
3. Notify participant B
4. Participant B performs checks
5. Coordinator commits or rolls back

## Idempotency Keys

- Use a unique key (e.g., `operation_id`) to detect duplicates
- Store keys in a dedicated table with unique index

```sql
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Timeouts and Compensation

- Set a maximum time window for pending distributed transactions
- If exceeded, trigger compensating actions or rollbacks

## Recovery after Crash

- On boot, scan pending distributed transactions and decide commit/rollback

```ts
const pending = await db.selectFrom('distributed_jobs').where(['status', '=', 'pending']).execute()
for (const job of pending) {
  // decide commit/rollback
}
```

## Auditing and Tracing

- Record each step with timestamps and correlation ids
- Emit tracing spans for begin/commit/rollback

```ts
import { trace } from '@opentelemetry/api'
const tracer = trace.getTracer('distributed')
const span = tracer.startSpan('beginDistributed')
span.setAttribute('txn', 'provision_user_123')
span.end()
```

## Security and Access Control

- Restrict who can begin/commit/rollback named distributed transactions
- Validate names to prevent collisions

## Testing Strategies

- Unit test coordinator logic with fakes
- Integration test end-to-end flows with a sandbox DB

## Anti-patterns

- Using distributed tx for every request (heavy, brittle)
- Long-running open transactions that hold locks

## Extended Examples

### Multi-service User Provisioning

```ts
// service A
await db.beginDistributed('user_123', async (tx) => {
  await tx.insertInto('users').values({ id: 123, status: 'provisioning' }).execute()
})

// service B does external work...

// coordinator
await db.commitDistributed('user_123')
```

### Rollback with compensation

```ts
try {
  await db.beginDistributed('order_1', async (tx) => {
    await tx.insertInto('orders').values({ id: 1, status: 'placed' }).execute()
  })
  await chargeCard()
  await db.commitDistributed('order_1')
}
catch (e) {
  await db.rollbackDistributed('order_1')
  await issueRefund()
}
```

## Operational Guidance

- Monitor number of open distributed transactions
- Alert on stuck transactions beyond SLA

## Checklist

- [ ] Unique, descriptive transaction names
- [ ] Idempotency keys for external operations
- [ ] Timeouts and compensations defined
- [ ] Recovery procedure after crashes
