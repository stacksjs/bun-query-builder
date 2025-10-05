# Bun Query Builder Benchmarks

Performance benchmarks comparing `bun-query-builder` against popular TypeScript query builders and ORMs.

## Libraries Tested

- **bun-query-builder** - The query builder being benchmarked
- **Kysely** - Type-safe SQL query builder for TypeScript
- **Prisma** - Next-generation ORM for Node.js & TypeScript
- **Drizzle ORM** - TypeScript ORM with SQL-like syntax
- **TypeORM** - ORM for TypeScript and JavaScript (currently disabled - requires native modules not fully compatible with Bun)

## Benchmark Categories

### Basic Queries
- SELECT: Find user by ID
- SELECT: Get all active users
- SELECT: Get users with limit
- SELECT: Count users
- INSERT: Single user
- UPDATE: Single user
- DELETE: Single user

### Advanced Queries
- JOIN: Users with their posts
- AGGREGATE: Average age
- WHERE: Complex conditions
- ORDER BY + LIMIT
- GROUP BY + HAVING

### Batch Operations
- INSERT MANY: 100 users
- UPDATE MANY: Batch update by age range
- DELETE MANY: By IDs
- SELECT: Large result set (1000 rows)

## Setup

Install dependencies:

```bash
bun install
```

Setup the benchmark database:

```bash
bun run setup
```

This creates a SQLite database with:
- 1,000 users
- 5,000 posts (associated with users)

## Running Benchmarks

Run all benchmarks:

```bash
bun run bench
```

Run specific benchmark suites:

```bash
# Basic queries only
bun run bench:basic

# Advanced queries only
bun run bench:advanced

# Batch operations only
bun run bench:batch
```

## Cleanup

Remove the benchmark database:

```bash
bun run clean
```

## Database Schema

### Users Table
- `id` - Primary key
- `name` - User's name
- `email` - Unique email
- `age` - User's age (nullable)
- `active` - Boolean flag
- `created_at` - Timestamp
- `updated_at` - Timestamp

### Posts Table
- `id` - Primary key
- `title` - Post title
- `content` - Post content
- `published` - Boolean flag
- `user_id` - Foreign key to users
- `created_at` - Timestamp
- `updated_at` - Timestamp

## Results Interpretation

The benchmarks use [mitata](https://github.com/evanwashere/mitata), a high-performance benchmarking library. Results show:

- **ops/sec** - Operations per second (higher is better)
- **avg (ms)** - Average execution time in milliseconds (lower is better)
- **p95 (ms)** - 95th percentile execution time
- **p99 (ms)** - 99th percentile execution time
- **samples** - Number of benchmark iterations

The fastest library in each category is marked with 🏆.

## Contributing

To add more benchmarks:

1. Create a new file in `src/benchmarks/`
2. Import the necessary clients from `src/lib/db-clients.ts`
3. Use mitata's `group()` and `bench()` functions
4. Add the benchmark to `src/index.ts`

Example:

```typescript
import { bench, run, group } from 'mitata'
import { createBunQBClient, createKyselyClient } from '../lib/db-clients'

const bunQB = createBunQBClient()
const kysely = createKyselyClient()

group('Your benchmark category', () => {
  bench('bun-query-builder', async () => {
    await bunQB.selectFrom('users').get()
  })

  bench('Kysely', async () => {
    await kysely.selectFrom('users').execute()
  })
})

await run()
```

## Notes

- All benchmarks use SQLite for consistency
- The database is populated with test data before benchmarks run
- Results may vary based on system performance
- Each benchmark runs multiple iterations for statistical accuracy
