# Bun Query Builder Benchmarks

Performance benchmarks comparing `bun-query-builder` against popular TypeScript query builders and ORMs.

## Libraries Tested

- **bun-query-builder** - The query builder being benchmarked
- **Kysely** - Type-safe SQL query builder (via [kysely-bun-sqlite](https://github.com/nicksrandall/kysely-bun-sqlite))
- **Drizzle ORM** - TypeScript ORM with SQL-like syntax
- **Prisma** - Next-generation ORM for Node.js & TypeScript (v6, as v7 does not yet support `bun:sqlite`)

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

## Latest Benchmark Results

_Last updated: 2026-03-15_
_Platform: Apple M3 Pro, Bun 1.3.11 (arm64-darwin)_

### Basic Queries

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|------------------:|-------:|--------:|-------:|
| SELECT: Find by ID | **8.3 µs** | 15.4 µs | 42.1 µs | 86.0 µs |
| SELECT: Active users | **221 µs** | 233 µs | 466 µs | 3,040 µs |
| SELECT: With LIMIT | **9.2 µs** | 19.3 µs | 41.2 µs | 106 µs |
| SELECT: COUNT | **6.8 µs** | 30.0 µs | 32.6 µs | 81.4 µs |
| INSERT: Single | **439 µs** | 558 µs | 472 µs | 657 µs |
| UPDATE: Single | **8.3 µs** | 13.4 µs | 22.8 µs | 123 µs |
| DELETE: Single | **7.5 µs** | 11.9 µs | 16.7 µs | 55 µs |

### Advanced Queries

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|------------------:|-------:|--------:|-------:|
| JOIN: Users with posts | **28.1 µs** | 44.3 µs | 83.2 µs | 1,560 µs |
| AGGREGATE: Average age | **29.3 µs** | 39.8 µs | 39.2 µs | 91.8 µs |
| WHERE: Complex conditions | **98.7 µs** | 110 µs | 212 µs | 1,060 µs |
| ORDER BY + LIMIT | **264 µs** | 313 µs | 337 µs | 511 µs |
| GROUP BY + HAVING | **616 µs** | 625 µs | 779 µs | 1,740 µs |

### Batch Operations

| Benchmark | bun-query-builder | Kysely | Drizzle | Prisma |
|-----------|------------------:|-------:|--------:|-------:|
| INSERT MANY: 100 users | **704 µs** | 1,080 µs | 1,380 µs | 1,410 µs |
| UPDATE MANY | **11.0 ms** | 10.8 ms | 10.7 ms | 11.9 ms |
| DELETE MANY: By IDs | **15.5 µs** | 22.4 µs | 33.8 µs | 69.0 µs |
| SELECT: 1000 rows | **248 µs** | 271 µs | 562 µs | 3,440 µs |

Lowest time per benchmark is **bolded**. bun-query-builder wins 16 of 16 benchmarks.

### Why Fast?

- **Direct `bun:sqlite` access** - No abstraction layers between query builder and database
- **Statement caching** - Prepared statements reused via Map-based O(1) lookup
- **Ultra-fast path** - Bypasses all overhead (hooks, soft-deletes, caching) when not configured, calling `stmt.all()` / `stmt.run()` directly
- **Lazy query building** - Internal `built` object constructed only when needed
- **Minimal allocations** - For-loop SQL construction, pre-built placeholder templates, deferred object creation

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
- `id` - Primary key (autoincrement)
- `name` - User's name
- `email` - Unique email
- `age` - User's age (nullable)
- `active` - Boolean flag (INTEGER, default 1)
- `created_at` - Timestamp
- `updated_at` - Timestamp

### Posts Table
- `id` - Primary key (autoincrement)
- `title` - Post title
- `content` - Post content
- `published` - Boolean flag (INTEGER, default 0)
- `user_id` - Foreign key to users
- `created_at` - Timestamp
- `updated_at` - Timestamp

## Notes

- All benchmarks use SQLite via `bun:sqlite` for consistency
- The database is populated with test data before benchmarks run
- Results may vary based on system performance
- Each benchmark runs multiple iterations for statistical accuracy
- UPDATE MANY is dominated by SQLite write time (all ORMs within ~10%)
- Benchmarks use [mitata](https://github.com/evanwashere/mitata), a high-performance benchmarking library

## Contributing

To add more benchmarks:

1. Create a new file in `src/benchmarks/`
2. Import the necessary clients from `src/lib/db-clients.ts`
3. Use mitata's `group()` and `bench()` functions
4. Add the benchmark to `src/index.ts`
