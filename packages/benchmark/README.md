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

Comparative performance results across 16 common database operations showing competitive performance with other popular query builders and ORMs.

### Detailed Results

#### Basic Queries

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|-------------------|---------|---------|---------|
| SELECT: Find user by ID | 14.0 µs | 13.8 µs | 33.3 µs | 79.6 µs |
| _vs best_ | _+1% slower_ | _baseline_ | _+141% slower_ | _+476% slower_ |
| SELECT: Get all active users | 14.2 µs | 13.8 µs | 27.8 µs | 71.5 µs |
| _vs best_ | _+3% slower_ | _baseline_ | _+102% slower_ | _+419% slower_ |
| SELECT: Get users with limit | 12.4 µs | 16.1 µs | 30.1 µs | 61.8 µs |
| _vs best_ | _baseline_ | _+30% slower_ | _+143% slower_ | _+398% slower_ |
| SELECT: Count users | 10.8 µs | 13.6 µs | 12.3 µs | 50.6 µs |
| _vs best_ | _baseline_ | _+26% slower_ | _+13% slower_ | _+367% slower_ |
| INSERT: Single user | 377 µs | 397 µs | 388 µs | 459 µs |
| _vs best_ | _baseline_ | _+5% slower_ | _+3% slower_ | _+22% slower_ |
| UPDATE: Single user | 10.6 µs | 13.1 µs | 17.7 µs | error |
| _vs best_ | _baseline_ | _+23% slower_ | _+67% slower_ | _-_ |
| DELETE: Single user | 10.2 µs | 13.2 µs | 15.0 µs | 136 µs |
| _vs best_ | _baseline_ | _+29% slower_ | _+47% slower_ | _+1234% slower_ |

#### Advanced Queries

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|-------------------|---------|---------|---------|
| JOIN: Users with their posts | 488 µs | 503 µs | 493 µs | 856 µs |
| _vs best_ | _baseline_ | _+3% slower_ | _+1% slower_ | _+75% slower_ |
| AGGREGATE: Average age | 167 µs | 170 µs | 650 µs | 289 µs |
| _vs best_ | _baseline_ | _+2% slower_ | _+289% slower_ | _+73% slower_ |
| WHERE: Complex conditions | 224 µs | 217 µs | 3,205 µs | 331 µs |
| _vs best_ | _+3% slower_ | _baseline_ | _+1376% slower_ | _+53% slower_ |
| ORDER BY + LIMIT | 26.3 µs | 267 µs | 276 µs | 492 µs |
| _vs best_ | _baseline_ | _+916% slower_ | _+950% slower_ | _+1770% slower_ |
| GROUP BY + HAVING | 640 µs | 616 µs | 633 µs | 1,832 µs |
| _vs best_ | _+4% slower_ | _baseline_ | _+3% slower_ | _+197% slower_ |

#### Batch Operations

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|-------------------|---------|---------|---------|
| INSERT MANY: 100 users | 1,276 µs | 1,055 µs | 1,289 µs | 1,716 µs |
| _vs best_ | _+21% slower_ | _baseline_ | _+22% slower_ | _+63% slower_ |
| UPDATE MANY: Batch update | 10.3 ms | 10.2 ms | 35.7 ms | 9.5 ms |
| _vs best_ | _+8% slower_ | _+7% slower_ | _+276% slower_ | _baseline_ |
| DELETE MANY: By IDs | 20.3 µs | 22.1 µs | 350 µs | 67.5 µs |
| _vs best_ | _baseline_ | _+9% slower_ | _+1624% slower_ | _+232% slower_ |
| SELECT: Large result set (1000 rows) | 250 µs | 93.6 µs | 553 µs | 3,503 µs |
| _vs best_ | _+167% slower_ | _baseline_ | _+490% slower_ | _+3642% slower_ |

### Notes on Benchmark Results

- All times shown are average execution time (lower is better)
- Percentages show performance relative to the best (fastest) result for each benchmark
- Results vary between runs due to normal system variance at the microsecond level
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
