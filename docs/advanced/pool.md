# Pool & Readiness

Utilities to work with Bun’s connection pool: readiness checks, reserving dedicated connections, and graceful shutdown.

## Table of Contents

- Overview
- Readiness: ping and waitForReady
- Reserving Connections
- Graceful Shutdown
- Health Checks and CI
- Best Practices
- FAQ

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

- Use `waitForReady` in environments where DB readiness is delayed
- Release reserved connections promptly
- Always close the pool on shutdown in long-running processes

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
