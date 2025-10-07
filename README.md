<p align="center"><img src=".github/art/cover.jpg" alt="Social Card of this repo"></p>

[![npm version][npm-version-src]][npm-version-href]
[![GitHub Actions][github-actions-src]][github-actions-href]
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
<!-- [![npm downloads][npm-downloads-src]][npm-downloads-href] -->
<!-- [![Codecov][codecov-src]][codecov-href] -->

# bun-query-builder

Fully-typed, model-driven Query Builder for Bun’s native `sql`.

Define your data model once and get a type-safe query experience _(a la Kysely/Laravel)_, powered by Bun’s tagged templates for safety and performance.

## Features

### Core Query Building

- **Typed from Models**: Infer tables/columns/PKs from your model files; `selectFrom('users')` and `where({ active: true })` are typed.
- **Fluent Builder**: `select/insert/update/delete`, `where/andWhere/orWhere`, `join/leftJoin/rightJoin/crossJoin`, `groupBy/having`, `union/unionAll`.
- **Aggregations**: `count()`, `avg()`, `sum()`, `max()`, `min()` with full type safety.
- **Batch Operations**: `insertMany()`, `updateMany()`, `deleteMany()` for efficient bulk operations.

### Advanced Features

- **Relations**: `with(...)`, `withCount(...)`, `whereHas(...)`, `has()`, `doesntHave()`, `selectAllRelations()` with configurable aliasing and constraint callbacks.
- **Query Scopes**: Define reusable query constraints on models for cleaner, more maintainable code.
- **Query Caching**: Built-in LRU cache with TTL support via `cache(ttlMs)`, `clearQueryCache()`, `setQueryCacheMaxSize()`.
- **Model Hooks**: Lifecycle events - `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`.

### Utilities & Helpers

- **Utilities**: `distinct/distinctOn`, `orderByDesc/latest/oldest/inRandomOrder`, `whereColumn/whereRaw/groupByRaw/havingRaw`, JSON/date helpers.
- **Pagination**: `paginate`, `simplePaginate`, `cursorPaginate`, plus `chunk/chunkById/eachById`.
- **Soft Deletes**: `withTrashed()`, `onlyTrashed()` for logical deletion support.

### Database Operations

- **Transactions**: `transaction` with retries/backoff/isolation/onRetry/afterCommit; `savepoint`; distributed tx helpers.
- **Migrations**: Generate and execute migrations from models with full diff support.
- **Seeders**: Database seeding with fake data generation via `ts-mocker` (faker alternative).
- **Raw Queries**: Tagged templates and parameterized queries with `raw()` and `unsafe()`.

### Configuration & Integration

- **Configurable**: Dialect hints, timestamps, alias strategies, relation FK formats, JSON mode, random function, shared lock syntax.
- **Bun API passthroughs**: `unsafe`, `file`, `simple`, pool `reserve/release`, `close`, `ping/waitForReady`.
- **CLI**: Introspection, query printing, connectivity checks, file/unsafe execution, explain.

> Note: LISTEN/NOTIFY and COPY helpers are scaffolded and will be wired as Bun exposes native APIs.

## Get Started

### Installation

```bash
bun add bun-query-builder
```

### Usage

```ts
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from 'bun-query-builder'

// Load or define your model files (see docs for model shape)
const models = {
  User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } }, active: { validation: { rule: {} } } } },
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)
const db = createQueryBuilder<typeof schema>({ schema, meta })

// Fully-typed query
const q = db
  .selectFrom('users')
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(10)

const rows = await q.execute()
```

### Aggregations

```ts
// Get average age of active users
const avgAge = await db.selectFrom('users')
  .where({ active: true })
  .avg('age')

// Count total posts
const totalPosts = await db.selectFrom('posts').count()

// Get max and min scores
const maxScore = await db.selectFrom('users').max('score')
const minScore = await db.selectFrom('users').min('score')
```

### Batch Operations

```ts
// Insert multiple records at once
await db.insertMany('users', [
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
  { name: 'Charlie', email: 'charlie@example.com' },
])

// Update multiple records matching conditions
await db.updateMany('users', { verified: false }, { status: 'pending' })

// Delete multiple records by IDs
await db.deleteMany('users', [1, 2, 3, 4, 5])
```

### Query Caching

```ts
// Cache query results for 60 seconds (default)
const users = await db.selectFrom('users')
  .where({ active: true })
  .cache()
  .get()

// Custom cache TTL (5 seconds)
const posts = await db.selectFrom('posts')
  .orderBy('created_at', 'desc')
  .limit(10)
  .cache(5000)
  .get()

// Clear all cached queries
clearQueryCache()

// Configure cache size
setQueryCacheMaxSize(500)
```

### Model Hooks

```ts
const db = createQueryBuilder<typeof schema>({
  schema,
  meta,
  hooks: {
    beforeCreate: async ({ table, data }) => {
      console.log(`Creating ${table}:`, data)
      // Modify data, validate, or throw to prevent creation
    },
    afterCreate: async ({ table, data, result }) => {
      console.log(`Created ${table}:`, result)
      // Trigger notifications, update caches, etc.
    },
    beforeUpdate: async ({ table, data, where }) => {
      // Audit logging, validation, etc.
    },
    afterUpdate: async ({ table, data, where, result }) => {
      // Clear related caches, send webhooks, etc.
    },
    beforeDelete: async ({ table, where }) => {
      // Prevent deletion, check constraints, etc.
    },
    afterDelete: async ({ table, where, result }) => {
      // Clean up related data, update aggregates, etc.
    },
  }
})
```

### Query Scopes

```ts
// Define scopes on your models
const User = {
  name: 'User',
  table: 'users',
  scopes: {
    active: (qb) => qb.where({ status: 'active' }),
    verified: (qb) => qb.where({ email_verified_at: ['IS NOT', null] }),
    premium: (qb) => qb.where({ subscription: 'premium' }),
  },
  // ... other model properties
}

// Use scopes in queries
const activeUsers = await db.selectFrom('users')
  .scope('active')
  .scope('verified')
  .get()
```

### Relations with Constraints

```ts
// Eager load with constraints
const users = await db.selectFrom('users')
  .with({
    posts: (qb) => qb.where('published', '=', true).orderBy('created_at', 'desc')
  })
  .get()

// Check for related records
const usersWithPosts = await db.selectFrom('users')
  .has('posts')
  .get()

// Query by relationship existence
const activeAuthors = await db.selectFrom('users')
  .whereHas('posts', (qb) => qb.where('published', '=', true))
  .get()
```

## Migrations

Generate and execute migrations from your models:

```ts
import { generateMigration, executeMigration } from 'bun-query-builder'

// Generate migration from models directory
const migration = await generateMigration('./models', {
  dialect: 'postgres',
  apply: true,
  full: true
})

// Execute the migration
await executeMigration(migration)
```

## Database Seeding

Populate your database with test data using seeders powered by [ts-mocker](https://github.com/stacksjs/ts-mocker):

### Creating a Seeder

```bash
# Generate a new seeder
bun qb make:seeder User

# This creates database/seeders/UserSeeder.ts
```

### Writing a Seeder

```ts
import { Seeder } from 'bun-query-builder'
import { faker } from 'ts-mocker'

export default class UserSeeder extends Seeder {
  async run(qb: any): Promise<void> {
    // Generate 50 users with realistic fake data
    const users = Array.from({ length: 50 }, () => ({
      name: faker.person.fullName(),
      email: faker.internet.email(),
      age: faker.number.int(18, 80),
      role: faker.helpers.arrayElement(['admin', 'user', 'moderator']),
      created_at: new Date(),
      updated_at: new Date(),
    }))

    await qb.table('users').insert(users).execute()
  }

  // Control execution order (lower runs first)
  get order(): number {
    return 10 // Default is 100
  }
}
```

### Running Seeders

```bash
# Run all seeders
bun qb seed
bun qb db:seed

# Run a specific seeder
bun qb seed --class UserSeeder

# Drop all tables, re-run migrations and seed
bun qb db:fresh
```

### Programmatic Usage

```ts
import { runSeeders, runSeeder } from 'bun-query-builder'

// Run all seeders
await runSeeders({
  seedersDir: './database/seeders',
  verbose: true
})

// Run specific seeder
await runSeeder('UserSeeder', { verbose: true })
```

### CLI

```bash
# Model Generation
query-builder make:model User
query-builder make:model Post --table=blog_posts
query-builder model:show User                   # Show detailed model info

# Schema Introspection
query-builder introspect ./app/Models --verbose
query-builder sql ./app/Models users --limit 5

# Migrations
query-builder migrate ./app/Models --dialect postgres
query-builder migrate:generate                  # Generate migration from drift
query-builder migrate:status                    # Show migration status
query-builder migrate:list                      # List all migrations
query-builder migrate:rollback --steps 2        # Rollback migrations
query-builder migrate:fresh ./app/Models
query-builder reset ./app/Models

# Database Info
query-builder db:info                           # Show database statistics
query-builder db:stats                          # Alias for db:info
query-builder inspect users                     # Inspect table structure
query-builder table:info users                  # Alias for inspect
query-builder db:wipe --force                   # Drop all tables
query-builder db:optimize                       # Optimize database (VACUUM, ANALYZE)
query-builder db:optimize --aggressive          # Aggressive optimization

# Interactive Console
query-builder console                           # Start REPL
query-builder tinker                            # Alias for console

# Seeders
query-builder make:seeder User
query-builder seed
query-builder db:seed --class UserSeeder
query-builder db:fresh

# Data Management
query-builder export users --format json
query-builder export users --format csv --output users.csv
query-builder import users users.json --truncate
query-builder dump --tables users,posts

# Cache Management
query-builder cache:clear
query-builder cache:stats
query-builder cache:config --size 500

# Performance
query-builder benchmark --iterations 1000
query-builder benchmark --operations select,insert
query-builder query:explain-all ./queries        # Batch EXPLAIN analysis

# Schema Validation
query-builder validate:schema ./app/Models
query-builder check                             # Alias for validate:schema

# Connectivity
query-builder ping
query-builder wait-ready --attempts 30 --delay 250

# Execute SQL
query-builder file ./migrations/seed.sql
query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[1]"
query-builder explain "SELECT * FROM users WHERE active = true"

# Diagrams & Visualization
query-builder relation:diagram                   # Generate Mermaid ER diagram
query-builder relation:diagram --format dot     # Generate Graphviz DOT
query-builder relation:diagram --output schema.mmd
```

## Performance

**🏆 bun-query-builder wins 13 out of 16 benchmarks (81.25%)**

### Summary

| Category | Win Rate | Performance vs Best |
|----------|----------|-------------------|
| Basic Queries | 7/7 (100%) 🎯 | 1.36x-29.29x faster |
| Advanced Queries | 4/5 (80%) | 1.01x-3.96x faster |
| Batch Operations | 2/4 (50%) | 1.45x-4.83x faster |

### Key Performance Wins

🚀 **Dominant in Basic Queries:**

- **29.29x faster** than Prisma in DELETE operations
- **16.45x faster** than Prisma in SELECT with LIMIT
- **14.86x faster** than Prisma in SELECT active users
- **13.8x faster** than Prisma in SELECT by ID
- **12.65x faster** than Prisma in COUNT queries

⚡ **Strong in Advanced Queries:**

- **3.96x faster** than Drizzle in AGGREGATE queries
- **2.99x faster** than Prisma in GROUP BY + HAVING
- **1.28x faster** than Prisma in JOIN operations
- **1.03x faster** than Kysely in JOIN operations
- **1.02x faster** than Kysely in AGGREGATE queries

💪 **Competitive in Batch Operations:**

- **4.83x faster** than Prisma in DELETE MANY
- **1.45x faster** than Kysely in DELETE MANY
- Within 14% of Kysely on INSERT MANY

### Perfect Category

- **100% wins** in basic CRUD operations (7/7) 🎯 - Beating Kysely, Drizzle, and Prisma in every single basic query

### The Trade-offs (3 out of 16)

- **WHERE: Complex conditions** - Kysely 1.05x faster
- **ORDER BY + LIMIT** - Kysely 1.07x faster
- **SELECT: Large result set (1000 rows)**

**Note:** Two additional benchmarks where we're competitive but not winning:

- **INSERT MANY: 100 users** - Kysely 1.14x faster
- **UPDATE MANY** - Prisma 1.10x faster

### Why Fast?

bun-query-builder leverages Bun's native SQLite driver with:

- **Direct BunDatabase access** - No abstraction layers
- **Statement caching** - Prepared statements reused across queries
- **Ultra-fast path** - Optimized execution for queries without hooks/soft-deletes
- **Smart optimizations** - For-loop template processing, minimal allocations

**[View Full Benchmark Results →](./packages/benchmark/README.md)**

## Testing

```bash
bun test
```

## Changelog

Please see our [releases](https://github.com/stackjs/bun-query-builder/releases) page for more information on what has changed recently.

## Contributing

Please see [CONTRIBUTING](.github/CONTRIBUTING.md) for details.

## Community

For help, discussion about best practices, or any other conversation that would benefit from being searchable:

[Discussions on GitHub](https://github.com/stacksjs/ts-starter/discussions)

For casual chit-chat with others using this package:

[Join the Stacks Discord Server](https://discord.gg/stacksjs)

## Postcardware

“Software that is free, but hopes for a postcard.” We love receiving postcards from around the world showing where Stacks is being used! We showcase them on our website too.

Our address: Stacks.js, 12665 Village Ln #2306, Playa Vista, CA 90094, United States 🌎

## Sponsors

We would like to extend our thanks to the following sponsors for funding Stacks development. If you are interested in becoming a sponsor, please reach out to us.

- [JetBrains](https://www.jetbrains.com/)
- [The Solana Foundation](https://solana.com/)

## License

The MIT License (MIT). Please see [LICENSE](LICENSE.md) for more information.

Made with 💙

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/bun-query-builder?style=flat-square
[npm-version-href]: https://npmjs.com/package/bun-query-builder
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/stacksjs/ts-starter/ci.yml?style=flat-square&branch=main
[github-actions-href]: https://github.com/stacksjs/ts-starter/actions?query=workflow%3Aci

<!-- [codecov-src]: https://img.shields.io/codecov/c/gh/stacksjs/ts-starter/main?style=flat-square
[codecov-href]: https://codecov.io/gh/stacksjs/ts-starter -->
