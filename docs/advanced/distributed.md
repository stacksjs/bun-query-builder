# Distributed Transactions

Two-phase commit helpers that map to Bun’s distributed APIs. Useful when coordinating state changes across services or processes where a standard single-connection transaction is insufficient.

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

### User Onboarding Workflow

```ts
// Chris's team user onboarding with external service coordination
async function onboardNewUser(userData: { name: string, email: string, department: string }) {
  const txnId = `onboard_${userData.email}_${Date.now()}`

  try {
    // Stage 1: Create user record
    await db.beginDistributed(txnId, async (tx) => {
      await tx.insertInto('users').values({
        ...userData,
        status: 'onboarding',
        created_at: new Date()
      }).execute()

      await tx.insertInto('audit_logs').values({
        action: 'user_onboarding_started',
        user_email: userData.email,
        initiated_by: 'Chris',
        timestamp: new Date()
      }).execute()
    })

    // Stage 2: External service provisioning
    await provisionEmailAccount(userData.email)
    await createDirectoryEntry(userData)
    await assignToTeam(userData.email, userData.department)

    // Stage 3: Commit if all external operations succeed
    await db.commitDistributed(txnId)

    console.log(`User ${userData.email} successfully onboarded`)
  }
  catch (error) {
    console.error(`Onboarding failed for ${userData.email}:`, error)

    // Cleanup: rollback database changes
    await db.rollbackDistributed(txnId)

    // Cleanup: compensating actions for external services
    await cleanupExternalResources(userData.email)

    throw error
  }
}

// Usage
await onboardNewUser({
  name: 'Avery Johnson',
  email: 'avery@company.com',
  department: 'Engineering'
})
```

### E-commerce Order Processing

```ts
// Avery's e-commerce order processing with payment and inventory
async function processOrder(orderData: {
  customerId: number
  items: Array<{ productId: number, quantity: number, price: number }>
  paymentToken: string
}) {
  const orderId = `order_${orderData.customerId}_${Date.now()}`

  try {
    // Stage 1: Reserve inventory and create order
    await db.beginDistributed(orderId, async (tx) => {
      // Create order record
      const order = await tx.insertInto('orders').values({
        customer_id: orderData.customerId,
        status: 'processing',
        total: orderData.items.reduce((sum, item) => sum + (item.price * item.quantity), 0),
        created_at: new Date()
      }).returning('id').execute()

      // Reserve inventory for each item
      for (const item of orderData.items) {
        await tx.updateTable('products')
          .set({ reserved_stock: db.sql`reserved_stock + ${item.quantity}` })
          .where({ id: item.productId })
          .execute()

        await tx.insertInto('order_items').values({
          order_id: order[0].id,
          product_id: item.productId,
          quantity: item.quantity,
          price: item.price
        }).execute()
      }
    })

    // Stage 2: Process payment
    const paymentResult = await processPayment({
      token: orderData.paymentToken,
      amount: orderData.items.reduce((sum, item) => sum + (item.price * item.quantity), 0),
      orderId
    })

    if (!paymentResult.success) {
      throw new Error(`Payment failed: ${paymentResult.error}`)
    }

    // Stage 3: Commit order
    await db.commitDistributed(orderId)

    // Stage 4: Trigger fulfillment
    await triggerFulfillment(orderId)

    return { success: true, orderId, paymentId: paymentResult.paymentId }
  }
  catch (error) {
    console.error(`Order processing failed for ${orderId}:`, error)

    // Rollback database changes
    await db.rollbackDistributed(orderId)

    // Compensating actions
    if (paymentResult?.paymentId) {
      await refundPayment(paymentResult.paymentId)
    }

    return { success: false, error: error.message }
  }
}
```

### Batch Job Orchestration

```ts
// Buddy's batch processing with checkpoint recovery
class BatchJobOrchestrator {
  private jobId: string
  private processingStarted = false

  constructor(jobId: string) {
    this.jobId = `batch_${jobId}_${Date.now()}`
  }

  async executeJob(items: any[], batchSize: number = 100) {
    try {
      // Stage 1: Initialize job tracking
      await db.beginDistributed(this.jobId, async (tx) => {
        await tx.insertInto('batch_jobs').values({
          job_id: this.jobId,
          status: 'initializing',
          total_items: items.length,
          processed_items: 0,
          started_by: 'Buddy',
          started_at: new Date()
        }).execute()
      })

      this.processingStarted = true

      // Stage 2: Process items in batches
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize)
        await this.processBatch(batch, i)

        // Update progress in distributed transaction
        await this.updateProgress(i + batch.length)
      }

      // Stage 3: Mark as complete and commit
      await this.completeJob()
    }
    catch (error) {
      console.error(`Batch job ${this.jobId} failed:`, error)
      await this.handleJobFailure(error)
      throw error
    }
  }

  private async processBatch(items: any[], startIndex: number) {
    // Process batch items
    for (const item of items) {
      await this.processItem(item)
    }
  }

  private async processItem(item: any) {
    // Individual item processing logic
    console.log(`Processing item: ${item.id}`)

    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  private async updateProgress(processedCount: number) {
    const progressTxnId = `${this.jobId}_progress_${processedCount}`

    await db.beginDistributed(progressTxnId, async (tx) => {
      await tx.updateTable('batch_jobs')
        .set({
          processed_items: processedCount,
          updated_at: new Date()
        })
        .where({ job_id: this.jobId })
        .execute()
    })

    await db.commitDistributed(progressTxnId)
  }

  private async completeJob() {
    const completionTxnId = `${this.jobId}_complete`

    await db.beginDistributed(completionTxnId, async (tx) => {
      await tx.updateTable('batch_jobs')
        .set({
          status: 'completed',
          completed_at: new Date()
        })
        .where({ job_id: this.jobId })
        .execute()
    })

    await db.commitDistributed(completionTxnId)
    await db.commitDistributed(this.jobId)

    console.log(`Batch job ${this.jobId} completed successfully`)
  }

  private async handleJobFailure(error: Error) {
    if (this.processingStarted) {
      // Mark job as failed
      const failureTxnId = `${this.jobId}_failed`

      try {
        await db.beginDistributed(failureTxnId, async (tx) => {
          await tx.updateTable('batch_jobs')
            .set({
              status: 'failed',
              error_message: error.message,
              failed_at: new Date()
            })
            .where({ job_id: this.jobId })
            .execute()
        })

        await db.commitDistributed(failureTxnId)
      }
      catch (updateError) {
        console.error('Failed to update job status:', updateError)
      }

      // Rollback main job transaction
      await db.rollbackDistributed(this.jobId)
    }
  }
}

// Usage
const orchestrator = new BatchJobOrchestrator('data_migration_2024')
await orchestrator.executeJob(migrationItems, 500)
```

## Idempotency and Retry Safety

- Make operations idempotent where possible (e.g., use `insertOrIgnore`)
- Use application-level de-duplication keys for external calls

## Failure Handling

- Always pair `beginDistributed` with either `commitDistributed` or `rollbackDistributed`
- Consider timeouts and compensating actions if external systems fail

## Best Practices

### Transaction Design

- **Meaningful Names**: Use descriptive, unique transaction names that include context
- **Idempotency**: Design operations to be safely retryable
- **Minimize Scope**: Keep distributed transactions as small as possible
- **Timeout Management**: Set reasonable timeouts for all external operations

```ts
// Good: Meaningful transaction naming
function generateTransactionId(operation: string, entityId: string): string {
  return `${operation}_${entityId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

// Chris's user provisioning example
const txnId = generateTransactionId('provision_user', userData.email)

// Avery's order processing example
const orderId = generateTransactionId('process_order', `customer_${customerId}`)

// Buddy's batch job example
const batchId = generateTransactionId('batch_migration', `job_${jobType}`)
```

### Error Handling and Recovery

- **Comprehensive Cleanup**: Always implement compensating actions for external operations
- **State Tracking**: Maintain detailed logs of transaction state changes
- **Recovery Procedures**: Have clear procedures for manual intervention when needed
- **Alerting**: Set up monitoring and alerts for failed distributed transactions

```ts
// Robust error handling pattern
async function executeDistributedOperation<T>(
  txnId: string,
  dbOperations: (tx: any) => Promise<void>,
  externalOperations: () => Promise<T>,
  compensatingActions: () => Promise<void>
): Promise<T> {
  let result: T
  let dbCommitted = false

  try {
    // Stage 1: Database operations
    await db.beginDistributed(txnId, dbOperations)

    // Stage 2: External operations
    result = await externalOperations()

    // Stage 3: Commit database changes
    await db.commitDistributed(txnId)
    dbCommitted = true

    return result
  }
  catch (error) {
    console.error(`Distributed transaction ${txnId} failed:`, error)

    // Rollback database if not committed
    if (!dbCommitted) {
      try {
        await db.rollbackDistributed(txnId)
      }
      catch (rollbackError) {
        console.error(`Failed to rollback ${txnId}:`, rollbackError)
      }
    }

    // Execute compensating actions
    try {
      await compensatingActions()
    }
    catch (compensationError) {
      console.error(`Compensation failed for ${txnId}:`, compensationError)
      // Alert operations team
      await alertOperationsTeam(txnId, compensationError)
    }

    throw error
  }
}
```

### Monitoring and Observability

- **Transaction Tracking**: Log all transaction lifecycle events
- **Performance Metrics**: Monitor transaction duration and success rates
- **Failure Analysis**: Collect detailed information about failures
- **Business Metrics**: Track business-level success rates

```ts
// Transaction monitoring system
class DistributedTransactionMonitor {
  private activeTransactions = new Map<string, TransactionState>()

  startTransaction(txnId: string, type: string, metadata: any) {
    const state: TransactionState = {
      id: txnId,
      type,
      metadata,
      startTime: Date.now(),
      status: 'started',
      events: []
    }

    this.activeTransactions.set(txnId, state)
    this.emitMetric('distributed_txn.started', { type })

    console.log(`📊 Started distributed transaction: ${txnId}`)
  }

  recordEvent(txnId: string, event: string, data?: any) {
    const state = this.activeTransactions.get(txnId)
    if (state) {
      state.events.push({
        event,
        timestamp: Date.now(),
        data
      })

      console.log(`📊 Transaction ${txnId}: ${event}`)
    }
  }

  completeTransaction(txnId: string, success: boolean, error?: Error) {
    const state = this.activeTransactions.get(txnId)
    if (state) {
      const duration = Date.now() - state.startTime
      state.status = success ? 'completed' : 'failed'
      state.duration = duration

      this.emitMetric('distributed_txn.completed', {
        type: state.type,
        success,
        duration
      })

      if (!success && error) {
        this.emitMetric('distributed_txn.failed', {
          type: state.type,
          error: error.message,
          duration
        })
      }

      console.log(`📊 Transaction ${txnId} ${success ? 'completed' : 'failed'} in ${duration}ms`)

      // Archive transaction state
      this.archiveTransaction(state)
      this.activeTransactions.delete(txnId)
    }
  }

  private emitMetric(name: string, tags: any) {
    // Send to monitoring system (Prometheus, DataDog, etc.)
    console.log(`Metric: ${name}`, tags)
  }

  private archiveTransaction(state: TransactionState) {
    // Store for analysis and debugging
    // Could be database, log aggregation system, etc.
  }

  getActiveTransactions() {
    return Array.from(this.activeTransactions.values())
  }
}

// Global monitor instance
const txnMonitor = new DistributedTransactionMonitor()

// Usage in Chris's onboarding flow
async function monitoredOnboarding(userData: any) {
  const txnId = generateTransactionId('onboard_user', userData.email)

  txnMonitor.startTransaction(txnId, 'user_onboarding', { email: userData.email })

  try {
    txnMonitor.recordEvent(txnId, 'db_operations_start')
    await db.beginDistributed(txnId, async (tx) => {
      // Database operations...
    })

    txnMonitor.recordEvent(txnId, 'external_services_start')
    await provisionExternalResources(userData)

    txnMonitor.recordEvent(txnId, 'commit_start')
    await db.commitDistributed(txnId)

    txnMonitor.completeTransaction(txnId, true)
  }
  catch (error) {
    txnMonitor.completeTransaction(txnId, false, error as Error)
    throw error
  }
}
```

### Operational Procedures

- **Manual Intervention**: Have documented procedures for manual transaction resolution
- **Cleanup Jobs**: Implement background jobs to clean up stale transactions
- **Disaster Recovery**: Plan for scenarios where coordination state is lost
- **Testing**: Regularly test failure scenarios and recovery procedures

```ts
// Cleanup job for stale transactions
class TransactionCleanupJob {
  async cleanupStaleTransactions() {
    const staleThreshold = Date.now() - (24 * 60 * 60 * 1000) // 24 hours

    const staleTransactions = await db
      .selectFrom('distributed_transactions')
      .where(['created_at', '<', new Date(staleThreshold)])
      .where(['status', 'in', ['started', 'pending']])
      .execute()

    for (const txn of staleTransactions) {
      console.log(`Cleaning up stale transaction: ${txn.id}`)

      try {
        // Attempt rollback
        await db.rollbackDistributed(txn.id)

        // Mark as cleaned up
        await db.updateTable('distributed_transactions')
          .set({
            status: 'cleaned_up',
            cleaned_up_at: new Date(),
            cleaned_up_reason: 'stale_timeout'
          })
          .where({ id: txn.id })
          .execute()
      }
      catch (error) {
        console.error(`Failed to cleanup transaction ${txn.id}:`, error)

        // Mark for manual intervention
        await db.updateTable('distributed_transactions')
          .set({
            status: 'requires_manual_intervention',
            error_message: error.message
          })
          .where({ id: txn.id })
          .execute()
      }
    }
  }
}

// Run cleanup job periodically
setInterval(async () => {
  const cleanup = new TransactionCleanupJob()
  await cleanup.cleanupStaleTransactions()
}, 60 * 60 * 1000) // Every hour
```

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
