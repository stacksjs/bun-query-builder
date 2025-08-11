# CLI

Utilities for introspecting models, previewing queries, executing SQL/scripts, and checking database readiness.

## Table of Contents

- Overview
- Installation
- Commands
  - introspect
  - sql
  - ping
  - wait-ready
  - file
  - unsafe
  - explain
- Examples
- Best Practices
- Exit Codes
- Troubleshooting

## Overview

The CLI ships with the package (binary and npm script compatible). It leverages the same `createQueryBuilder` API under the hood and reads your configuration the same way as the library.

## Installation

See Install docs for binary downloads or add via your package manager.

## Commands

### introspect

Scan a models directory and print derived schema and meta information.

```
query-builder introspect <dir> [--json]
```

Options:

- `--json` output machine-readable JSON

### sql

Build and print a query for a given table.

```
query-builder sql <dir> <table> [--limit <n>] [--where <json>]
```

Examples:

```
query-builder sql ./app/Models users --limit 5
query-builder sql ./app/Models orders --where '{"status":"paid"}'
```

### ping

Check database connectivity.

```
query-builder ping
```

Exit code 0 if ready, 1 otherwise.

### wait-ready

Wait until the database is ready, retrying.

```
query-builder wait-ready [--attempts <n>] [--delay <ms>]
```

### file

Execute a SQL file with optional parameters.

```
query-builder file <path> [--params <json>]
```

### unsafe

Execute raw SQL with optional parameters. Use with caution.

```
query-builder unsafe <sql> [--params <json>]
```

### explain

Run EXPLAIN on a SQL statement and print the plan.

```
query-builder explain <sql>
```

## Examples

```bash
query-builder introspect ./app/Models --json
query-builder sql ./app/Models users --limit 5
query-builder ping
query-builder wait-ready --attempts 30 --delay 250
query-builder file ./migrations/seed.sql --params "[1,2,3]"
query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[1]"
query-builder explain "SELECT * FROM users WHERE active = true"
```

## Best Practices

- Keep CLI in CI/CD to smoke test connectivity
- Prefer `file` for scripts; use `unsafe` cautiously
- Use `wait-ready` in integration test setup to reduce flakiness

## Exit Codes

- 0: success
- 1: failure (e.g., DB not ready)

## Troubleshooting

- If `ping` fails, verify connectivity, credentials, and environment variables
- For `file`/`unsafe`, check parameter JSON is valid and matches placeholders

---

## Additional Examples and Variants

### CI healthcheck

```bash
query-builder ping || exit 1
```

### Wait for DB before running migrations

```bash
query-builder wait-ready --attempts 60 --delay 500 && bun run migrate
```

### Build a sample query and show text

```bash
export QB_CAPTURE_TEXT=1
query-builder sql ./app/Models users --limit 3
```

### Execute seed file with parameters

```bash
query-builder file ./migrations/seed.sql --params "[\"role\", \"admin\"]"
```

### Explain a complex statement

```bash
query-builder explain "SELECT * FROM users WHERE active = true ORDER BY created_at DESC LIMIT 10"
```
