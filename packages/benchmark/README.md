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

## Latest Benchmark Results

_Last updated: 2025-10-05_
_Platform: Apple M3 Pro, Bun 1.2.24_

### Summary

Comparative performance results across 16 common database operations:

| Category | Benchmarks | Performance Range |
|----------|----------|-------------------|
| Basic Queries | 7 tests | 1.05-5.76x vs competitors |
| Advanced Queries | 5 tests | 1.02-18.62x vs competitors |
| Batch Operations | 4 tests | 1.08-17.65x vs competitors |

### Detailed Results

#### Basic Queries

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|-------------------|---------|---------|---------|
| SELECT: Find user by ID | 15.0 µs | error | 34.7 µs | 80.2 µs |
| _vs best_ | _baseline_ | _-_ | _+132% slower_ | _+436% slower_ |
| SELECT: Get all active users | 14.1 µs | error | 27.9 µs | 75.9 µs |
| _vs best_ | _baseline_ | _-_ | _+98% slower_ | _+438% slower_ |
| SELECT: Get users with limit | 13.2 µs | error | 29.2 µs | 63.7 µs |
| _vs best_ | _baseline_ | _-_ | _+121% slower_ | _+382% slower_ |
| SELECT: Count users | 10.8 µs | 14.7 µs | 13.0 µs | 60.2 µs |
| _vs best_ | _baseline_ | _+36% slower_ | _+20% slower_ | _+455% slower_ |
| INSERT: Single user | 418 µs | 417 µs | 432 µs | 474 µs |
| _vs best_ | _+0.2% slower_ | _baseline_ | _+3.6% slower_ | _+13.7% slower_ |
| UPDATE: Single user | 11.7 µs | 13.9 µs | 18.5 µs | error |
| _vs best_ | _baseline_ | _+18% slower_ | _+57% slower_ | _-_ |
| DELETE: Single user | 10.7 µs | 12.7 µs | 14.2 µs | 127 µs |
| _vs best_ | _baseline_ | _+19% slower_ | _+33% slower_ | _+1092% slower_ |

#### Advanced Queries

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|-------------------|---------|---------|---------|
| JOIN: Users with their posts | 500 µs | 493 µs | 503 µs | 892 µs |
| _vs best_ | _+1.4% slower_ | _baseline_ | _+2.0% slower_ | _+81% slower_ |
| AGGREGATE: Average age | 165 µs | 168 µs | 681 µs | 301 µs |
| _vs best_ | _baseline_ | _+1.8% slower_ | _+313% slower_ | _+82% slower_ |
| WHERE: Complex conditions | 224 µs | error | 3,173 µs | 294 µs |
| _vs best_ | _baseline_ | _-_ | _+1316% slower_ | _+31% slower_ |
| ORDER BY + LIMIT | 28.0 µs | error | 293 µs | 514 µs |
| _vs best_ | _baseline_ | _-_ | _+947% slower_ | _+1738% slower_ |
| GROUP BY + HAVING | 662 µs | 642 µs | 666 µs | 1,912 µs |
| _vs best_ | _+3.1% slower_ | _baseline_ | _+3.7% slower_ | _+198% slower_ |

#### Batch Operations

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|-------------------|---------|---------|---------|
| INSERT MANY: 100 users | 1,102 µs | 972 µs | 1,326 µs | 1,773 µs |
| _vs best_ | _+13.4% slower_ | _baseline_ | _+36% slower_ | _+82% slower_ |
| UPDATE MANY: Batch update | 11.3 ms | 11.0 ms | 37.1 ms | 10.3 ms |
| _vs best_ | _+9.7% slower_ | _+6.8% slower_ | _+260% slower_ | _baseline_ |
| DELETE MANY: By IDs | 22.5 µs | 22.9 µs | 398 µs | 69.8 µs |
| _vs best_ | _baseline_ | _+1.8% slower_ | _+1669% slower_ | _+210% slower_ |
| SELECT: Large result set | 254 µs | error | 574 µs | 3,670 µs |
| _vs best_ | _baseline_ | _-_ | _+126% slower_ | _+1345% slower_ |

### Notes on Benchmark Results

- All times shown are average execution time (lower is better)
- Some Kysely benchmarks error due to SQL syntax issues with the test setup
- Prisma UPDATE benchmark fails due to record not found issues
- TypeORM is excluded due to native module compatibility issues with Bun
- Performance varies by system and workload; these results reflect testing on Apple M3 Pro

## Results Interpretation

The benchmarks use [mitata](https://github.com/evanwashere/mitata), a high-performance benchmarking library. Results show:

- **time (avg)** - Average execution time (lower is better)
- **min … max** - Range of execution times
- **p75, p99, p999** - 75th, 99th, and 999th percentile times
- **Nx faster** - Performance multiplier vs competitor

The fastest library in each category is highlighted in the summary section.

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
