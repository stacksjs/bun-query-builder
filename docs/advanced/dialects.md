# Dialects & Config

Configure behavior to match your database dialect and preferences. The global `config` controls defaults for timestamps, pagination, aliasing, relations, transaction behavior, SQL features, and debug.

## Table of Contents

- Overview
- Core Settings
- SQL Dialect Settings
- Relations and Aliasing
- Pagination Defaults
- Timestamps
- Transactions (Retries, Isolation, Backoff)
- Feature Flags
- Debugging
- Examples
- Best Practices
- FAQ

## Overview

The library reads config via bunfig at runtime. You can also tweak `config` directly at startup or call `db.configure()` per builder instance (lightweight overrides).

## Core Settings

```ts
import { config } from 'bun-query-builder'

config.verbose = true
config.dialect = 'postgres' // 'mysql' | 'sqlite'
```

## SQL Dialect Settings

Random function and shared lock syntax vary by dialect:

```ts
config.sql.randomFunction = 'RANDOM()' // PG
config.sql.sharedLockSyntax = 'FOR SHARE' // PG
config.sql.jsonContainsMode = 'operator' // PG uses @>

// MySQL
config.dialect = 'mysql'
config.sql.randomFunction = 'RAND()'
config.sql.sharedLockSyntax = 'LOCK IN SHARE MODE'
config.sql.jsonContainsMode = 'function' // JSON_CONTAINS
```

## Relations and Aliasing

```ts
config.relations = {
  foreignKeyFormat: 'singularParent_id',
  singularizeStrategy: 'stripTrailingS',
}

config.aliasing = {
  relationColumnAliasFormat: 'table_column', // or 'table.dot.column' | 'camelCase'
}
```

## Pagination Defaults

```ts
config.pagination = {
  defaultPerPage: 25,
  cursorColumn: 'id',
}
```

## Timestamps

```ts
config.timestamps = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  defaultOrderColumn: 'created_at',
}
```

## Transactions

```ts
config.transactionDefaults = {
  retries: 2,
  isolation: 'read committed',
  sqlStates: ['40001', '40P01'],
  backoff: { baseMs: 50, factor: 2, maxMs: 2000, jitter: true },
}
```

## Feature Flags

```ts
config.features = {
  distinctOn: true, // PG only
}
```

## Debugging

```ts
config.debug = {
  captureText: false,
}

// Optional lifecycle hooks and tracing
config.hooks = {
  onQueryStart: ({ sql, kind }) => logger.debug({ kind, sql }),
  onQueryEnd: ({ durationMs, rowCount }) => logger.info({ durationMs, rowCount }),
  onQueryError: ({ error }) => logger.error(error),
}
```

## Examples

```ts
// SQLite friendly defaults
config.dialect = 'sqlite'
config.sql.randomFunction = 'RANDOM()'
config.sql.sharedLockSyntax = 'FOR SHARE'

// project-specific alias preferences
config.aliasing.relationColumnAliasFormat = 'camelCase'

// heavier protection for critical flows
config.transactionDefaults.retries = 5
config.transactionDefaults.backoff = { baseMs: 100, factor: 2, maxMs: 5000, jitter: true }
```

## Best Practices

- Align SQL syntax to your dialect upfront
- Use `camelCase` aliasing when consuming results in JS-heavy layers
- Keep pagination defaults consistent across services
- Increase retries for hot-path operations prone to contention

## FAQ

### How do per-instance overrides work?

Call `db.configure(partialConfig)` to shallow-merge selected properties for that builder instance.

### Can I change config at runtime?

Yes. Changing `config` affects subsequently created queries. Prefer setting once during app boot.

---

## Postgres Notes

- DISTINCT ON supported (`config.features.distinctOn = true`)
- RETURNING supported on INSERT/UPDATE/DELETE
- JSON operators `@>`, `->`, `->>` are available; we use operator mode by default
- Shared lock syntax: `FOR SHARE`; row locking via `FOR UPDATE`
- Random function: `RANDOM()`

### Examples

```ts
await db.selectFrom('users').distinctOn('email').orderBy('email').execute()
await db.insertInto('users').values({ name: 'A' }).returning('id').execute()
await db.selectFrom('docs').whereJsonContains('content', { published: true }).execute()
```

## MySQL Notes

- Use `RAND()` for random ordering
- Shared lock syntax: `LOCK IN SHARE MODE`
- JSON containment via `JSON_CONTAINS` when `config.sql.jsonContainsMode = 'function'`
- Upsert via `ON DUPLICATE KEY UPDATE` (our `upsert` helper may emulate using `ON CONFLICT` style on PG)

### Examples

```ts
config.dialect = 'mysql'
config.sql.randomFunction = 'RAND()'
config.sql.sharedLockSyntax = 'LOCK IN SHARE MODE'
config.sql.jsonContainsMode = 'function'

await db.selectFrom('tips').inRandomOrder().execute()
await db.selectFrom('items').sharedLock().execute()
await db.selectFrom('docs').whereJsonContains('content', { published: true }).execute()
```

## SQLite Notes

- Random function: `RANDOM()`
- Locking semantics differ; `FOR UPDATE` may be a no-op
- RETURNING support exists in modern SQLite builds; verify your version
- JSON functions via the JSON1 extension

### Examples

```ts
config.dialect = 'sqlite'
config.sql.randomFunction = 'RANDOM()'
config.sql.sharedLockSyntax = 'FOR SHARE'
```

## Identifiers and Quoting

- We rely on Bun `sql` for identifier quoting; avoid interpolating raw identifiers without validation
- Prefer structured helpers over raw `sql``${table}.${column}``

## Pagination Differences

- All supported dialects use `LIMIT`/`OFFSET`; performance implications differ
- For deep pagination, prefer `cursorPaginate`
 - Composite cursors are supported by passing multiple columns (e.g., `['created_at', 'id']`)

## Timezones and Types

- Store timestamps in UTC; convert at the application edge
- Booleans may map to `tinyint(1)` in MySQL; ensure truthiness expectations

## Performance Tips Per Dialect

- Postgres: leverage `EXPLAIN (ANALYZE, BUFFERS)` during tuning; create appropriate indexes for JSON paths if needed
- MySQL: ensure proper collations and indexes on text columns; beware of implicit conversions
- SQLite: keep transactions short; consider WAL mode for concurrency

## Collations and Charsets

- Choose a consistent collation/charset (e.g., `utf8mb4` for MySQL) to avoid comparison surprises

## Prepared Statement Considerations

- Some dialects/drivers have limits on placeholders; batch operations accordingly

## Examples: Cross-dialect Random

```ts
// PG / SQLite
config.sql.randomFunction = 'RANDOM()'
await db.selectFrom('quotes').inRandomOrder().limit(1).execute()

// MySQL
config.sql.randomFunction = 'RAND()'
await db.selectFrom('quotes').inRandomOrder().limit(1).execute()
```

## Examples: JSON contains

```ts
// PG operator
config.sql.jsonContainsMode = 'operator'
await db.selectFrom('docs').whereJsonContains('meta', { a: 1 })

// MySQL function
config.sql.jsonContainsMode = 'function'
await db.selectFrom('docs').whereJsonContains('meta', { a: 1 })
```

## Troubleshooting

- Syntax error with `distinctOn`: ensure `config.features.distinctOn = true` and dialect is PG
- `sharedLock` no effect: dialect may not support; verify generated SQL
- JSON contains mismatch: switch mode between `operator` and `function` per dialect

## Migration Strategy

- Keep dialect-sensitive features behind config toggles
- Centralize dialect assumptions in one module for easy review

## Checklist

- [ ] Set dialect early in app boot
- [ ] Align random/lock/JSON settings to dialect
- [ ] Verify returning support before relying on it
- [ ] Prefer cursor-based pagination for deep pages
