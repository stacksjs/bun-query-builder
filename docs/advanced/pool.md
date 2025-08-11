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
} finally {
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
