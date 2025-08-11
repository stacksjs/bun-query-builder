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
