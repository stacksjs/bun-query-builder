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
_Platform: Apple M3 Pro, Bun 1.2.21_

### Summary

**bun-query-builder wins 14 out of 16 benchmarks (87.5%)**

| Category | Win Rate | Performance Range |
|----------|----------|-------------------|
| Basic Queries | 7/7 (100%) | 1.05-5.64x faster |
| Advanced Queries | 4/5 (80%) | 1.36-18.68x faster |
| Batch Operations | 3/4 (75%) | 1.04-18.54x faster |

### Detailed Results

#### Basic Queries ✅ 7/7 Wins (Perfect!)

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma | Result |
|-----------|-------------------|---------|---------|---------|---------|
| SELECT: Find user by ID | **13.3 µs** | error | 31.9 µs | 74.9 µs | ✅ 2.4x faster than Drizzle, 5.64x faster than Prisma |
| SELECT: Get all active users | **13.1 µs** | error | 26.8 µs | 69.1 µs | ✅ 2.05x faster than Drizzle, 5.29x faster than Prisma |
| SELECT: Get users with limit | **12.2 µs** | error | 28.1 µs | 60.0 µs | ✅ 2.3x faster than Drizzle, 4.91x faster than Prisma |
| SELECT: Count users | **10.5 µs** | 13.5 µs | 12.1 µs | 48.7 µs | ✅ 1.15x faster than Drizzle, 1.29x faster than Kysely |
| INSERT: Single user | **390 µs** | 431 µs | 410 µs | 499 µs | ✅ 1.05x faster than Drizzle, 1.1x faster than Kysely |
| UPDATE: Single user | **10.8 µs** | 13.0 µs | 17.2 µs | error | ✅ 1.2x faster than Kysely, 1.59x faster than Drizzle |
| DELETE: Single user | **10.1 µs** | 11.8 µs | 13.7 µs | 116 µs | ✅ 1.17x faster than Kysely, 1.36x faster than Drizzle |

#### Advanced Queries ✅ 4/5 Wins

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma | Result |
|-----------|-------------------|---------|---------|---------|---------|
| JOIN: Users with their posts | **437 µs** | 459 µs | 452 µs | 801 µs | ✅ 1.04x faster than Drizzle, 1.05x faster than Kysely |
| AGGREGATE: Average age | 167 µs | **166 µs** | 626 µs | 291 µs | ❌ Tied with Kysely (1.0x) |
| WHERE: Complex conditions | **209 µs** | error | 3'119 µs | 283 µs | ✅ 1.36x faster than Prisma, 14.94x faster than Drizzle |
| ORDER BY + LIMIT | **25.7 µs** | error | 269 µs | 481 µs | ✅ 10.45x faster than Drizzle, 18.68x faster than Prisma |
| GROUP BY + HAVING | **620 µs** | 621 µs | 676 µs | 1'811 µs | ✅ 1.09x faster than Drizzle (tied with Kysely) |

#### Batch Operations ✅ 3/4 Wins

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma | Result |
|-----------|-------------------|---------|---------|---------|---------|
| INSERT MANY: 100 users | **792 µs** | 823 µs | 1'157 µs | 1'571 µs | ✅ 1.04x faster than Kysely, 1.46x faster than Drizzle |
| UPDATE MANY: Batch update | 12.7 ms | 12.4 ms | 43.1 ms | **11.5 ms** | ❌ 10% slower than Prisma |
| DELETE MANY: By IDs | **19.7 µs** | 21.8 µs | 365 µs | 66.5 µs | ✅ 1.11x faster than Kysely, 18.54x faster than Drizzle |
| SELECT: Large result set | **242 µs** | error | 549 µs | 3'439 µs | ✅ 2.27x faster than Drizzle, 14.24x faster than Prisma |

### Performance Highlights

🚀 **Massive Wins:**
- **18.68x faster** than Prisma in ORDER BY + LIMIT
- **18.54x faster** than Drizzle in DELETE MANY
- **14.94x faster** than Drizzle in WHERE: Complex conditions
- **14.24x faster** than Prisma in SELECT: Large result set
- **11.47x faster** than Prisma in DELETE: Single user
- **10.45x faster** than Drizzle in ORDER BY + LIMIT

⚡ **Perfect Categories:**
- **100% wins** in basic CRUD operations (7/7) 🎯
- **80% wins** in advanced queries (4/5)
- **75% wins** in batch operations (3/4)

💪 **Exceptional Performance:**
- 14 out of 16 wins (87.5%)
- Only 2 non-wins (1 tied, 1 within 10%)
- Leverages Bun's native SQL for optimal performance

### Notes on Benchmark Results

- Some Kysely benchmarks show errors due to SQL syntax issues with the test setup
- Prisma UPDATE benchmark failed due to record not found issues
- TypeORM is excluded (native module compatibility issues with Bun)
- All times shown are average execution times (lower is better)

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
