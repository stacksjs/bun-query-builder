# CLI

Utilities for introspecting models, printing queries, and checking DB readiness.

## Commands

- `query-builder introspect <dir>`
- `query-builder sql <dir> <table> [--limit <n>]`
- `query-builder ping`
- `query-builder wait-ready [--attempts <n>] [--delay <ms>]`
- `query-builder file <path> [--params <json>]`
- `query-builder unsafe <sql> [--params <json>]`
- `query-builder explain <sql>`

## Examples

```bash
query-builder introspect ./app/Models --verbose
query-builder sql ./app/Models users --limit 5
query-builder ping
query-builder wait-ready --attempts 30 --delay 250
query-builder file ./migrations/seed.sql
query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[1]"
query-builder explain "SELECT * FROM users WHERE active = true"
```

## Best Practices

- Keep CLI in CI/CD to smoke test connectivity
- Prefer `file` for scripts; use `unsafe` cautiously
