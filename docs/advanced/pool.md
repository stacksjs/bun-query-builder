# Pool & Readiness

Utilities to work with Bun’s connection pool: readiness checks, reserving dedicated connections, and graceful shutdown.

## Overview

The builder proxies useful pool operations so you can:

- Verify connectivity (`ping`)
- Block until the pool is usable (`waitForReady`)
- Reserve a dedicated connection for a sequence of operations
- Close the pool on shutdown

## Readiness: ping and waitForReady

```ts
const ok = await db.ping()
await db.waitForReady({ attempts: 30, delayMs: 250 })
```

Use `waitForReady` at app boot or in CI before running migrations/tests.

### Tuning

- `attempts`: number of tries
- `delayMs`: delay between attempts

## Reserving Connections

```ts
const reserved = await db.reserve()
try {
  await reserved.selectFrom('users').limit(1).execute()
}
finally {
  reserved.release()
}
```

Reserved connections avoid pool contention for critical operations like seeding, bulk imports, or per-request transaction scoping.

## Graceful Shutdown

```ts
await db.close({ timeout: 5000 })
```

Call on process exit to close idle/active connections gracefully.

## Health Checks and CI

- Use `query-builder ping` in container healthchecks
- Run `wait-ready` before integration tests to reduce flakes

## Best Practices

### Connection Management

- **Prompt Release**: Always release reserved connections in finally blocks to prevent leaks
- **Scope Management**: Reserve connections only for operations that truly need isolation
- **Pool Sizing**: Size pools based on application concurrency and database limits
- **Graceful Shutdown**: Always close pools during application shutdown

```ts
// Good: Proper connection lifecycle management
async function handleCriticalOperation() {
  const conn = await db.reserve()
  try {
    // Critical operations that need isolation
    await conn.transaction(async (tx) => {
      await tx.insertInto('audit_logs').values({
        action: 'critical_operation',
        user: 'Chris',
        timestamp: new Date()
      }).execute()

      await tx.updateTable('system_state').set({
        last_critical_operation: new Date()
      }).where({ id: 1 }).execute()
    })
  }
  finally {
    // Always release in finally block
    conn.release()
  }
}

// Good: Proper shutdown handling
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...')

  // Close database connections
  await db.close({ timeout: 10000 })

  console.log('Database connections closed')
  process.exit(0)
})
```

### Performance Optimization

- **Right-Size Pools**: Start with CPU count * 2, adjust based on monitoring
- **Monitor Metrics**: Track pool utilization, wait times, and connection lifetimes
- **Load Testing**: Test pool behavior under realistic load conditions
- **Resource Limits**: Respect database connection limits and system resources

```ts
// Pool configuration based on environment
function configurePoolForEnvironment() {
  const environment = process.env.NODE_ENV
  const cpuCount = require('node:os').cpus().length

  switch (environment) {
    case 'production':
      // Avery's production e-commerce setup
      return {
        minConnections: cpuCount,
        maxConnections: cpuCount * 4, // Higher for web traffic
        idleTimeoutMs: 30000,
        acquireTimeoutMs: 10000
      }

    case 'development':
      // Buddy's local development setup
      return {
        minConnections: 1,
        maxConnections: cpuCount,
        idleTimeoutMs: 60000,
        acquireTimeoutMs: 5000
      }

    case 'test':
      // Chris's test environment
      return {
        minConnections: 1,
        maxConnections: 2, // Keep tests lightweight
        idleTimeoutMs: 10000,
        acquireTimeoutMs: 3000
      }

    default:
      throw new Error(`Unknown environment: ${environment}`)
  }
}

// Apply configuration
const poolConfig = configurePoolForEnvironment()
console.log(`Pool configured for ${process.env.NODE_ENV}:`, poolConfig)
```

### Error Handling and Resilience

- **Timeout Handling**: Set appropriate timeouts for connection acquisition
- **Retry Logic**: Implement exponential backoff for connection failures
- **Circuit Breakers**: Protect against cascading failures
- **Health Monitoring**: Continuous health checks and alerting

```ts
// Robust connection handling with retry
async function withConnectionRetry<T>(
  operation: (conn: any) => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: Error

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let conn: any = null

    try {
      conn = await db.reserve()
      const result = await operation(conn)
      return result
    }
    catch (error) {
      lastError = error as Error

      // Log attempt
      console.warn(`Connection attempt ${attempt} failed:`, error.message)

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10000)
        await new Promise(resolve => setTimeout(resolve, delayMs))
      }
    }
    finally {
      if (conn) {
        conn.release()
      }
    }
  }

  throw new Error(`Operation failed after ${maxRetries} attempts: ${lastError.message}`)
}

// Usage example
const result = await withConnectionRetry(async (conn) => {
  return await conn.selectFrom('users').where({ name: 'Chris' }).execute()
})
```

### Monitoring and Observability

- **Pool Metrics**: Track active, idle, and waiting connection counts
- **Performance Monitoring**: Monitor connection acquisition times
- **Alert Thresholds**: Set up alerts for pool exhaustion or high wait times
- **Health Dashboards**: Visualize pool health in monitoring dashboards

```ts
// Pool monitoring setup
class PoolMonitor {
  private metrics = {
    activeConnections: 0,
    idleConnections: 0,
    waitingRequests: 0,
    acquisitionTime: [] as number[],
    errors: 0
  }

  startMonitoring() {
    // Emit metrics every 30 seconds
    setInterval(() => {
      this.emitMetrics()
    }, 30000)

    // Health check every 10 seconds
    setInterval(() => {
      this.healthCheck()
    }, 10000)
  }

  private async healthCheck() {
    try {
      const start = Date.now()
      const isHealthy = await db.ping()
      const duration = Date.now() - start

      if (!isHealthy || duration > 5000) {
        console.error('Database health check failed', { isHealthy, duration })
        this.metrics.errors++
      }
    }
    catch (error) {
      console.error('Health check error:', error)
      this.metrics.errors++
    }
  }

  private emitMetrics() {
    // Send to monitoring system (Prometheus, DataDog, etc.)
    const metrics = {
      'db.pool.active': this.metrics.activeConnections,
      'db.pool.idle': this.metrics.idleConnections,
      'db.pool.waiting': this.metrics.waitingRequests,
      'db.pool.acquisition_time_avg': this.getAverageAcquisitionTime(),
      'db.pool.errors': this.metrics.errors
    }

    console.log('Pool metrics:', metrics)

    // Reset counters
    this.metrics.acquisitionTime = []
    this.metrics.errors = 0
  }

  private getAverageAcquisitionTime(): number {
    const times = this.metrics.acquisitionTime
    return times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0
  }
}

// Start monitoring
const monitor = new PoolMonitor()
monitor.startMonitoring()
```

## FAQ

### Why does ping sometimes return true then fail later?

Network partitions or credential changes may occur after the ping. Always handle errors at query time.

### Can I reserve multiple connections?

Yes, but prefer reserving only when necessary to avoid starving the pool.

---

## Pool Sizing and Tuning

- Start small and increase based on throughput and DB limits
- Consider CPU cores, workload concurrency, and DB max connections

## Connection Timeouts and Cancellations

```ts
const q = db.selectFrom('heavy').where({ flag: true }).toSQL() as any
const controller = new AbortController()
const t = setTimeout(() => controller.abort(), 5000)
try {
  await q.execute({ signal: controller.signal })
}
finally {
  clearTimeout(t)
}
```

## Leak Detection

- Track reserved connections and ensure `release()` in finally blocks
- Wrap helpers to assert release in tests

## Heartbeat Queries

Run periodic lightweight queries to keep connections warm (if needed) and detect failures early.

```ts
setInterval(async () => {
  try {
    await db.ping()
  }
  catch {
    // ignore
  }
}, 30_000)
```

## Graceful Shutdown in Servers

```ts
process.on('SIGTERM', async () => {
  await db.close({ timeout: 10_000 })
  process.exit(0)
})
```

## K8s/Containers Healthchecks

```yaml
livenessProbe:
  exec:
    command:
      - /bin/sh
      - -lc
      - query-builder ping
  initialDelaySeconds: 10
  periodSeconds: 15
readinessProbe:
  exec:
    command:
      - /bin/sh
      - -lc
      - query-builder wait-ready --attempts 10 --delay 200
  initialDelaySeconds: 5
  periodSeconds: 10
```

## Error Classification

- Distinguish network failures vs SQL errors; retry appropriately
- Backoff when DB is under load

## Observability

- Emit metrics: pool size, idle, busy, wait time, ping latency

## Troubleshooting

- Frequent timeouts: increase pool size or optimize queries
- Connection refused: check DB address/auth and network policies
- Idle in transaction: ensure transactions are closed promptly

## Recipes

### Per-request reserved connection

```ts
async function handler(req: any) {
  const conn = await db.reserve()
  try {
    const rows = await conn.selectFrom('users').limit(5).execute()
    return rows
  }
  finally {
    conn.release()
  }
}
```

### Pre-warm connections on boot

```ts
await db.waitForReady({ attempts: 20, delayMs: 250 })
```

### Bulk import with reserved connection

```ts
const conn = await db.reserve()
try {
  for (const batch of makeBatches(rows, 1000)) {
    await conn.insertInto('items').values(batch).execute()
  }
}
finally {
  conn.release()
}
```

## Checklist

- [ ] Use waitForReady at startup/CI
- [ ] Size pool according to workload and DB limits
- [ ] Reserve connections for critical sections only
- [ ] Implement graceful shutdown handlers
