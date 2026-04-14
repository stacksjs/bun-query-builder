# Performance Benchmarks

bun-query-builder is built with performance in mind. We continuously benchmark against popular TypeScript query builders and ORMs to ensure we deliver exceptional performance.

## Methodology

All benchmarks are run on:

- **CPU**: Apple M3 Pro
- **Runtime**: Bun 1.3.11 (arm64-darwin)
- **Database**: SQLite (1,000 users, 5,000 posts)
- **Tool**: [mitata](https://github.com/evanwashere/mitata) - High-performance benchmarking library

## Libraries Compared

- **bun-query-builder** - Our query builder leveraging Bun's native SQL
- **Kysely** - Type-safe SQL query builder (via [kysely-bun-sqlite](https://github.com/nicksrandall/kysely-bun-sqlite))
- **Drizzle ORM** - TypeScript ORM with SQL-like syntax
- **Prisma** - Next-generation ORM for Node.js & TypeScript

## Benchmark Results

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

## Why Fast

bun-query-builder leverages Bun's native SQLite driver with:

- **Direct `bun:sqlite` access** - No abstraction layers between query builder and database
- **Statement caching** - Prepared statements reused across queries via Map-based O(1) lookup
- **Ultra-fast path** - When no hooks, soft-deletes, or caching are configured, queries bypass all overhead and call `stmt.all()` / `stmt.run()` directly
- **Lazy query building** - The internal `built` object is only constructed when needed, avoiding expensive template tag calls on the hot path
- **Minimal allocations** - For-loop SQL construction, pre-built placeholder templates, deferred object creation

## Run Benchmarks Yourself

```bash
# Clone the repository
git clone https://github.com/stacksjs/bun-query-builder
cd bun-query-builder/packages/benchmark

# Install dependencies
bun install

# Setup test database
bun run setup

# Run all benchmarks
bun run bench

# Or run specific benchmark suites
bun run bench:basic
bun run bench:advanced
bun run bench:batch
```

## Caveats

- Benchmarks are run on SQLite. Performance may vary with PostgreSQL/MySQL.
- Results reflect specific query patterns. Real-world performance depends on your use case.
- Benchmarks measure query execution time, not including network latency.
- UPDATE MANY is dominated by SQLite write time (all ORMs within ~10%).
- Prisma v7 does not yet support Bun's native SQLite; benchmarks use Prisma v6.
