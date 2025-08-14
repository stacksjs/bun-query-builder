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

### Development and Debugging

```bash
# Introspect Chris's model directory
query-builder introspect ./app/Models --json

# Generate sample SQL for user queries
query-builder sql ./app/Models users --limit 5
query-builder sql ./app/Models projects --where '{"owner":"Chris","status":"active"}'

# Debug with different table scenarios
query-builder sql ./app/Models posts --where '{"author":"Avery","published":true}' --limit 10
query-builder sql ./app/Models teams --where '{"lead":"Buddy"}'
```

### Database Connectivity

```bash
# Check if database is ready
query-builder ping

# Wait for database in CI/Docker environments
query-builder wait-ready --attempts 30 --delay 250

# Kubernetes readiness probe
query-builder wait-ready --attempts 10 --delay 200
```

### Script Execution

```bash
# Execute SQL files safely
query-builder file ./migrations/seed.sql
query-builder file ./scripts/cleanup.sql --params "[30]"  # 30 days retention

# Execute parameterized queries (use with caution)
query-builder unsafe "SELECT * FROM users WHERE team = $1" --params "[\"Engineering\"]"
query-builder unsafe "SELECT * FROM projects WHERE owner = $1 AND status = $2" --params "[\"Chris\",\"active\"]"
```

### Performance Analysis

```bash
# Analyze query performance
query-builder explain "SELECT * FROM users WHERE active = true"
query-builder explain "SELECT u.*, p.name as project_name FROM users u JOIN projects p ON p.user_id = u.id WHERE u.role = 'admin'"

# Compare different query strategies
query-builder explain "SELECT * FROM users WHERE name LIKE '%Chris%'"
query-builder explain "SELECT * FROM users WHERE name ILIKE 'chris%'"  # PostgreSQL
```

## Best Practices

### Development Workflow

- **Model Introspection**: Use `introspect` to verify model definitions and catch configuration issues early
- **Query Validation**: Test complex queries with `sql` command before implementing in code
- **Performance Testing**: Use `explain` to identify performance bottlenecks during development
- **Safe Execution**: Prefer `file` over `unsafe` for any repeatable operations

```bash
# Good: Validate model setup
query-builder introspect ./app/Models --json | jq '.tables | keys'

# Good: Test query before coding
query-builder sql ./app/Models users --where '{"team":"Chris Team"}' --limit 5

# Good: Check performance impact
query-builder explain "SELECT * FROM users u JOIN projects p ON p.user_id = u.id WHERE u.active = true"

# Avoid: Direct SQL without parameterization
query-builder unsafe "SELECT * FROM users WHERE name = 'Chris'" # Risky!

# Better: Use parameters
query-builder unsafe "SELECT * FROM users WHERE name = $1" --params '["Chris"]'
```

### CI/CD Integration

- **Health Checks**: Include `ping` and `wait-ready` in deployment pipelines
- **Database Readiness**: Use `wait-ready` before running migrations or tests
- **Automated Testing**: Run `introspect` to catch schema drift
- **Performance Monitoring**: Set up automated `explain` checks for critical queries

```bash
#!/bin/bash
# deployment-health-check.sh

echo "Waiting for database..."
query-builder wait-ready --attempts 60 --delay 1000

echo "Checking database connectivity..."
if ! query-builder ping; then
  echo "Database health check failed"
  exit 1
fi

echo "Validating schema..."
query-builder introspect ./app/Models --json > /tmp/schema.json
if [ $? -ne 0 ]; then
  echo "Schema validation failed"
  exit 1
fi

echo "Database is ready!"
```

### Production Operations

- **Script Management**: Store frequently used scripts in version control
- **Parameter Safety**: Always use parameterized queries for dynamic values
- **Access Control**: Limit CLI access in production environments
- **Monitoring**: Log CLI usage for audit and debugging purposes

```bash
# Good: Parameterized cleanup script
# cleanup-old-sessions.sql
query-builder file ./scripts/cleanup-old-sessions.sql --params "[30]"  # 30 days

# Good: Safe data export
# export-user-data.sql with proper WHERE clauses
query-builder file ./scripts/export-user-data.sql --params "[\"2024-01-01\"]"

# Production deployment check
query-builder ping && echo "Database ready for deployment"
```

### Security Considerations

- **Environment Variables**: Use environment variables for sensitive connection parameters
- **Parameter Validation**: Validate all parameters before passing to CLI commands
- **Audit Logging**: Log all CLI operations in production environments
- **Access Restrictions**: Limit who can use `unsafe` command in production

```bash
# Good: Use environment variables for sensitive data
export DB_HOST=production.db.company.com
export DB_USER=readonly_user
query-builder ping

# Good: Validate parameters before use
if [[ ! "$USER_ID" =~ ^[0-9]+$ ]]; then
  echo "Invalid user ID"
  exit 1
fi
query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[\"$USER_ID\"]"

# Production audit logging
echo "$(date): CLI operation by $(whoami): $*" >> /var/log/query-builder.log
```

### Troubleshooting

- **Connection Issues**: Use `ping` to isolate connectivity problems
- **Performance Problems**: Use `explain` to analyze slow queries
- **Schema Issues**: Use `introspect` to verify model configuration
- **Script Debugging**: Test scripts in development before production use

```bash
# Debugging connectivity
query-builder ping || echo "Database unreachable - check network/credentials"

# Debugging slow queries
query-builder explain "SELECT * FROM large_table WHERE unindexed_column = 'value'"

# Debugging schema mismatches
query-builder introspect ./app/Models --json | jq '.errors'

# Testing script safety
query-builder file ./scripts/test-script.sql --params "[\"test_value\"]"
```

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
