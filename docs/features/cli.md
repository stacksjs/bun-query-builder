# CLI

Utilities for introspecting models, previewing queries, executing SQL/scripts, and checking database readiness.

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

### migrate

Generate SQL migrations from your models.

```
query-builder migrate <dir> [--dialect <d>] [--apply] [--full]
```

Options:

- `--dialect <d>` - Database dialect (postgres|mysql|sqlite), default: postgres
- `--apply` - Execute the generated SQL immediately
- `--full` - Force full migration SQL instead of incremental diff
- `--state <path>` - Path to migration state file

Examples:

```bash
query-builder migrate ./app/Models --dialect postgres
query-builder migrate ./app/Models --apply
query-builder migrate ./app/Models --full
```

### migrate:fresh

Reset database and run all migrations.

```
query-builder migrate:fresh <dir> [--dialect <d>]
```

### reset

Drop all tables and reset database.

```
query-builder reset <dir> [--dialect <d>]
```

### make:seeder

Create a new seeder file.

```
query-builder make:seeder <name>
```

Examples:

```bash
query-builder make:seeder User
query-builder make:seeder UserSeeder  # "Seeder" suffix is optional
```

### seed

Run database seeders.

```
query-builder seed [--dir <path>] [--class <name>] [--verbose]
```

Options:

- `--dir <path>` - Path to seeders directory (default: database/seeders)
- `--class <name>` - Run a specific seeder class
- `--verbose` - Enable verbose logging

Examples:

```bash
query-builder seed
query-builder seed --class UserSeeder
query-builder seed --dir ./custom/seeders
```

### db:seed

Alias for the `seed` command.

```
query-builder db:seed [--class <name>]
```

### db:fresh

Drop all tables, re-run migrations, and seed the database.

```
query-builder db:fresh [--models <path>] [--seeders <path>]
```

Options:

- `--models <path>` - Path to models directory (default: app/Models)
- `--seeders <path>` - Path to seeders directory (default: database/seeders)
- `--verbose` - Enable verbose logging

Example:

```bash
query-builder db:fresh
query-builder db:fresh --models ./app/Models --seeders ./database/seeders
```

### make:model

Create a new model file with proper structure and configuration.

```
query-builder make:model <name> [--table <name>] [--dir <path>]
```

Options:

- `--table <name>` - Custom table name (default: pluralized model name)
- `--dir <path>` - Output directory (default: app/Models)

Examples:

```bash
query-builder make:model User
query-builder make:model Post --table blog_posts
query-builder make:model Product --dir ./models
```

### model:show

Display detailed information about a specific model including attributes, relations, scopes, hooks, and indexes.

```
query-builder model:show <name> [--dir <path>] [--json] [--verbose]
```

Options:

- `--dir <path>` - Models directory (default: app/Models)
- `--json` - Output as JSON
- `--verbose` - Enable verbose output

Examples:

```bash
query-builder model:show User
query-builder model:show Post --json
query-builder model:show Product --dir ./models
```

### migrate:status

Show the status of all migrations (executed vs pending).

```
query-builder migrate:status
```

Shows which migrations have been executed and which are pending.

### migrate:list

Alias for `migrate:status`.

```
query-builder migrate:list
```

### migrate:rollback

Rollback the last batch of migrations.

```
query-builder migrate:rollback [--steps <n>]
```

Options:

- `--steps <n>` - Number of migration batches to rollback (default: 1)

Examples:

```bash
query-builder migrate:rollback
query-builder migrate:rollback --steps 2
```

### migrate:generate

Generate migration files from model changes (drift detection).

```
query-builder migrate:generate [dir] [--dialect <d>] [--apply] [--full]
```

Options:

- `--dialect <d>` - Database dialect (postgres|mysql|sqlite), default: postgres
- `--apply` - Execute the generated SQL immediately
- `--full` - Force full migration SQL instead of incremental diff
- `--state <path>` - Path to migration state file

Examples:

```bash
query-builder migrate:generate
query-builder migrate:generate ./app/Models --dialect postgres
query-builder migrate:generate --apply
```

### db:info

Display database information including tables, row counts, and statistics.

```
query-builder db:info
```

Shows:
- Database dialect
- Total tables
- Row counts per table
- Column and index counts

### db:stats

Alias for `db:info`.

```
query-builder db:stats
```

### db:wipe

Drop all tables from the database. Useful for testing and development.

```
query-builder db:wipe [--dialect <d>] [--force] [--verbose]
```

Options:

- `--dialect <d>` - Database dialect (postgres|mysql|sqlite), default: postgres
- `--force` - Skip confirmation prompt
- `--verbose` - Enable verbose output

Examples:

```bash
query-builder db:wipe
query-builder db:wipe --force
query-builder db:wipe --verbose
```

### db:optimize

Optimize database tables using VACUUM, ANALYZE (postgres), OPTIMIZE TABLE (mysql), or equivalent commands.

```
query-builder db:optimize [--dialect <d>] [--aggressive] [--tables <list>] [--verbose]
```

Options:

- `--dialect <d>` - Database dialect (postgres|mysql|sqlite), default: postgres
- `--aggressive` - Use aggressive optimization (VACUUM FULL for postgres)
- `--tables <list>` - Comma-separated list of tables to optimize
- `--verbose` - Enable verbose output

Examples:

```bash
query-builder db:optimize
query-builder db:optimize --aggressive
query-builder db:optimize --tables users,posts
```

### inspect

Inspect a specific table's structure, including columns, types, and indexes.

```
query-builder inspect <table>
```

Example:

```bash
query-builder inspect users
query-builder inspect projects
```

### table:info

Alias for `inspect`.

```
query-builder table:info <table>
```

### console

Start an interactive REPL for running queries and exploring your database.

```
query-builder console
```

Features:
- Execute queries interactively
- Access to full query builder API
- Built-in commands: `.help`, `.tables`, `.exit`

### tinker

Alias for `console`.

```
query-builder tinker
```

### cache:clear

Clear the query cache.

```
query-builder cache:clear
```

Removes all cached query results.

### cache:stats

Display cache statistics including size, hit rate, and entries.

```
query-builder cache:stats
```

### cache:config

Configure cache settings.

```
query-builder cache:config [--size <n>]
```

Options:

- `--size <n>` - Maximum cache size (number of entries)

Example:

```bash
query-builder cache:config --size 500
```

### benchmark

Run performance benchmarks on common database operations.

```
query-builder benchmark [--iterations <n>] [--operations <list>]
```

Options:

- `--iterations <n>` - Number of iterations per benchmark (default: 1000)
- `--operations <list>` - Comma-separated list of operations to benchmark (select, insert, update, delete, count)

Examples:

```bash
query-builder benchmark
query-builder benchmark --iterations 5000
query-builder benchmark --operations select,insert,count
```

### validate:schema

Validate that your models match the actual database schema.

```
query-builder validate:schema [<dir>]
```

Checks for:
- Missing tables
- Missing columns
- Type mismatches
- Extra tables/columns not in models

Example:

```bash
query-builder validate:schema ./app/Models
```

### check

Alias for `validate:schema`.

```
query-builder check [<dir>]
```

### export

Export table data to various formats.

```
query-builder export <table> [--format <type>] [--output <path>] [--limit <n>]
```

Options:

- `--format <type>` - Output format: json, csv, sql (default: json)
- `--output <path>` - Output file path
- `--limit <n>` - Limit number of rows

Examples:

```bash
query-builder export users --format json
query-builder export users --format csv --output users.csv
query-builder export posts --format sql --limit 100
```

### import

Import data from a file into a table.

```
query-builder import <table> <file> [--format <type>] [--truncate]
```

Options:

- `--format <type>` - Input format: json, csv (default: auto-detect from file extension)
- `--truncate` - Truncate table before importing

Examples:

```bash
query-builder import users users.json
query-builder import users users.csv --truncate
```

### dump

Export entire database to SQL format.

```
query-builder dump [--tables <list>] [--output <path>]
```

Options:

- `--tables <list>` - Comma-separated list of tables to dump (default: all tables)
- `--output <path>` - Output file path

Examples:

```bash
query-builder dump
query-builder dump --tables users,posts
query-builder dump --output backup.sql
```

### query:explain-all

Run EXPLAIN on all SQL files in a directory or a single SQL file. Useful for batch performance analysis.

```
query-builder query:explain-all <path> [--verbose] [--json]
```

Options:

- `--verbose` - Enable verbose output
- `--json` - Output as JSON

Examples:

```bash
query-builder query:explain-all ./queries
query-builder query:explain-all ./queries/users.sql
query-builder query:explain-all ./queries --json
```

### relation:diagram

Generate relationship diagrams from models in Mermaid or Graphviz DOT format.

```
query-builder relation:diagram [--dir <path>] [--format <fmt>] [--output <path>]
```

Options:

- `--dir <path>` - Models directory (default: app/Models)
- `--format <fmt>` - Output format: mermaid or dot (default: mermaid)
- `--output <path>` - Output file path (prints to stdout if not specified)
- `--verbose` - Enable verbose output

Examples:

```bash
query-builder relation:diagram
query-builder relation:diagram --format dot --output schema.dot
query-builder relation:diagram --output schema.mmd
query-builder relation:diagram --dir ./app/Models
```

## Examples

### Development and Debugging

```bash
# Introspect model directory
query-builder introspect ./app/Models --json

# Generate sample SQL for user queries
query-builder sql ./app/Models users --limit 5
query-builder sql ./app/Models projects --where '{"owner":"Chris","status":"active"}'

# Debug with different table scenarios
query-builder sql ./app/Models posts --where '{"author":"Avery","published":true}' --limit 10
query-builder sql ./app/Models teams --where '{"lead":"Buddy"}'
```

### Model and Schema Management

```bash
# Create a new model
query-builder make:model User
query-builder make:model Post --table blog_posts

# Validate schema matches models
query-builder validate:schema ./app/Models
query-builder check ./app/Models  # alias

# Inspect database structure
query-builder db:info
query-builder inspect users
```

### Migrations and Seeding

```bash
# Generate migrations
query-builder migrate ./app/Models --dialect postgres

# Apply migrations immediately
query-builder migrate ./app/Models --apply

# Check migration status
query-builder migrate:status
query-builder migrate:list  # alias

# Rollback migrations
query-builder migrate:rollback
query-builder migrate:rollback --steps 2

# Create a new seeder
query-builder make:seeder User

# Run all seeders
query-builder seed

# Run specific seeder
query-builder seed --class UserSeeder

# Fresh database with migrations and seeds
query-builder db:fresh
```

### Interactive Console

```bash
# Start interactive REPL
query-builder console
query-builder tinker  # alias

# Inside the console, you can run:
# > await qb.selectFrom('users').where({ active: true }).get()
# > .tables  # list all tables
# > .help    # show available commands
# > .exit    # exit the console
```

### Cache Management

```bash
# Clear query cache
query-builder cache:clear

# View cache statistics
query-builder cache:stats

# Configure cache size
query-builder cache:config --size 500
```

### Data Export and Import

```bash
# Export data to different formats
query-builder export users --format json
query-builder export users --format csv --output users.csv
query-builder export posts --format sql --limit 1000

# Import data from files
query-builder import users users.json
query-builder import users users.csv --truncate

# Dump entire database
query-builder dump
query-builder dump --tables users,posts
query-builder dump --output backup.sql
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
# Run performance benchmarks
query-builder benchmark
query-builder benchmark --iterations 5000
query-builder benchmark --operations select,insert,count

# Analyze query performance
query-builder explain "SELECT * FROM users WHERE active = true"
query-builder explain "SELECT u.*, p.name as project_name FROM users u JOIN projects p ON p.user_id = u.id WHERE u.role = 'admin'"

# Compare different query strategies
query-builder explain "SELECT * FROM users WHERE name LIKE '%Chris%'"
query-builder explain "SELECT * FROM users WHERE name ILIKE 'chris%'"  # PostgreSQL
```

## Best Practices

### Development Workflow

- **Model Generation**: Use `make:model` to scaffold new models with correct structure
- **Model Introspection**: Use `introspect` to verify model definitions and catch configuration issues early
- **Schema Validation**: Use `validate:schema` regularly to detect schema drift
- **Interactive Development**: Use `console` for exploring data and testing queries interactively
- **Query Validation**: Test complex queries with `sql` command before implementing in code
- **Performance Testing**: Use `benchmark` and `explain` to identify performance bottlenecks during development
- **Cache Management**: Use `cache:clear` when testing query changes
- **Safe Execution**: Prefer `file` over `unsafe` for any repeatable operations

```bash
# Good: Create new models with proper structure
query-builder make:model User
query-builder make:model Post --table blog_posts

# Good: Validate schema regularly
query-builder validate:schema ./app/Models

# Good: Explore data interactively
query-builder console
# > await qb.selectFrom('users').where({ active: true }).get()

# Good: Validate model setup
query-builder introspect ./app/Models --json | jq '.tables | keys'

# Good: Test query before coding
query-builder sql ./app/Models users --where '{"team":"Chris Team"}' --limit 5

# Good: Check performance impact
query-builder explain "SELECT * FROM users u JOIN projects p ON p.user_id = u.id WHERE u.active = true"
query-builder benchmark --operations select,join

# Good: Manage cache during development
query-builder cache:clear
query-builder cache:stats

# Avoid: Direct SQL without parameterization
query-builder unsafe "SELECT * FROM users WHERE name = 'Chris'" # Risky!

# Better: Use parameters
query-builder unsafe "SELECT * FROM users WHERE name = $1" --params '["Chris"]'
```

### CI/CD Integration

- **Health Checks**: Include `ping` and `wait-ready` in deployment pipelines
- **Database Readiness**: Use `wait-ready` before running migrations or tests
- **Schema Validation**: Run `validate:schema` to catch schema drift
- **Migration Status**: Check `migrate:status` before applying new migrations
- **Performance Monitoring**: Set up automated `benchmark` and `explain` checks
- **Cache Management**: Clear cache after deployments with `cache:clear`

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
query-builder validate:schema ./app/Models
if [ $? -ne 0 ]; then
  echo "Schema validation failed - drift detected"
  exit 1
fi

echo "Checking migration status..."
query-builder migrate:status

echo "Running benchmarks..."
query-builder benchmark --iterations 100

echo "Database is ready!"
```

### Production Operations

- **Data Backups**: Use `dump` for regular database backups
- **Data Migration**: Use `export` and `import` for data transfers
- **Script Management**: Store frequently used scripts in version control
- **Parameter Safety**: Always use parameterized queries for dynamic values
- **Migration Tracking**: Use `migrate:status` to track deployment state
- **Access Control**: Limit CLI access in production environments
- **Monitoring**: Log CLI usage for audit and debugging purposes

```bash
# Good: Regular database backups
query-builder dump --output /backups/db-$(date +%Y%m%d).sql
query-builder dump --tables users,orders --output /backups/critical-$(date +%Y%m%d).sql

# Good: Data migration between environments
query-builder export users --format json --output users-export.json
query-builder import users users-export.json --truncate

# Good: Table inspection before changes
query-builder inspect users
query-builder db:info

# Good: Parameterized cleanup script
query-builder file ./scripts/cleanup-old-sessions.sql --params "[30]"  # 30 days

# Good: Safe data export with proper filtering
query-builder file ./scripts/export-user-data.sql --params "[\"2024-01-01\"]"

# Production deployment check
query-builder ping && echo "Database ready for deployment"
query-builder migrate:status  # Verify migration state
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
- **Performance Problems**: Use `benchmark` and `explain` to analyze slow queries
- **Schema Issues**: Use `validate:schema` and `inspect` to verify schema configuration
- **Migration Problems**: Use `migrate:status` to check migration state
- **Cache Issues**: Use `cache:stats` and `cache:clear` to diagnose caching problems
- **Data Issues**: Use `console` for interactive debugging
- **Script Debugging**: Test scripts in development before production use

```bash
# Debugging connectivity
query-builder ping || echo "Database unreachable - check network/credentials"

# Debugging performance issues
query-builder benchmark --iterations 100
query-builder explain "SELECT * FROM large_table WHERE unindexed_column = 'value'"

# Debugging schema mismatches
query-builder validate:schema ./app/Models
query-builder inspect users
query-builder db:info

# Debugging migration issues
query-builder migrate:status
query-builder migrate:list

# Debugging cache issues
query-builder cache:stats
query-builder cache:clear

# Interactive debugging
query-builder console
# > await qb.selectFrom('users').where({ id: 123 }).get()
# > .tables

# Testing script safety
query-builder file ./scripts/test-script.sql --params "[\"test_value\"]"
```

## Exit Codes

- 0: success
- 1: failure (e.g., DB not ready)

## Common Issues

- If `ping` fails, verify connectivity, credentials, and environment variables
- For `file`/`unsafe`, check parameter JSON is valid and matches placeholders
- If `validate:schema` reports drift, run `migrate` to sync schema with models
- If `benchmark` fails, ensure database is accessible and has test data
- If `console` commands fail, check that query syntax is correct and tables exist
- For cache issues, use `cache:clear` to reset and `cache:stats` to inspect state

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
