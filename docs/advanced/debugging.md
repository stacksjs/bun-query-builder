# Debugging

Techniques for inspecting queries, printing SQL, and understanding performance characteristics.

## Table of Contents

- Overview
- Enabling toText
- Dump, DD, and Explain
- Logging Queries
- Snapshot Testing
- Common Pitfalls
- Best Practices

## Overview

By default, the builder returns Bun query objects rather than strings. This preserves parameterization and performance. For debugging and tests, enable `toText` to access a string representation.

## Enabling toText

```ts
import { config } from 'bun-query-builder'
config.debug = { captureText: true }

const q = db.selectFrom('users').where({ active: true })
console.log((q as any).toText?.())
```

Disable in production to avoid overhead and accidental logging of sensitive text.

## Dump, DD, and Explain

```ts
await db.selectFrom('users').dump().execute()   // prints SQL
await db.selectFrom('users').dd()                // prints SQL then throws
await db.selectFrom('users').explain()           // returns EXPLAIN rows
```

Use `explain` to understand query plans and add appropriate indexes.

## Logging Queries

Wrap builder calls and log `(q as any).toText?.()` when `captureText` is on.

## Snapshot Testing

Enable `captureText` in tests to snapshot SQL text for critical queries.

```ts
import { config } from 'bun-query-builder'
config.debug = { captureText: true }
const q = db.selectFrom('orders').where(['status', '=', 'paid']).toSQL() as any
expect(q.toText()).toContain('SELECT')
```

## Common Pitfalls

- Comparing query object directly to string (enable toText instead)
- Forgetting to disable `captureText` in production

## Best Practices

- Keep `captureText` disabled in production
- Prefer `toText` only for debugging/snapshots
- Use `explain` for performance tuning
