# Performance Benchmarks

bun-query-builder is built with performance in mind. We continuously benchmark against popular TypeScript query builders and ORMs to ensure we deliver exceptional performance.

## Methodology

All benchmarks are run on:
- **CPU**: Apple M3 Pro
- **Runtime**: Bun 1.2.21 (arm64-darwin)
- **Database**: SQLite (1,000 users, 5,000 posts)
- **Tool**: [mitata](https://github.com/evanwashere/mitata) - High-performance benchmarking library

## Libraries Compared

- **bun-query-builder** - Our query builder leveraging Bun's native SQL
- **Kysely** - Type-safe SQL query builder
- **Drizzle ORM** - TypeScript ORM with SQL-like syntax
- **Prisma** - Next-generation ORM for Node.js & TypeScript

## Benchmark Results

### Basic Queries

#### SELECT: Find User by ID

| Library | Time (avg) | vs bun-query-builder |
|---------|-----------|----------------------|
| **bun-query-builder** | **14.3 µs** | - |
| Drizzle | 33.2 µs | 2.32x slower |
| Prisma | 82.4 µs | 5.77x slower |

```ts
// bun-query-builder
await db.selectFrom('users').where({ id: 500 }).first()

// Kysely
await kysely.selectFrom('users').where('id', '=', 500).executeTakeFirst()
```

#### SELECT: Get Users with Limit

| Library | Time (avg) | vs bun-query-builder |
|---------|-----------|----------------------|
| **bun-query-builder** | **18.3 µs** | - |
| Drizzle | 32.8 µs | 1.79x slower |
| Prisma | 102 µs | 5.59x slower |

#### SELECT: Count Users

| Library | Time (avg) | vs bun-query-builder |
|---------|-----------|----------------------|
| **bun-query-builder** | **12.6 µs** | - |
| Kysely | 37.6 µs | 2.97x slower |
| Prisma | 86.9 µs | 6.87x slower |
| Drizzle | 113 µs | 8.93x slower |

```ts
// bun-query-builder
await db.selectFrom('users').count()

// Kysely
const result = await kysely.selectFrom('users')
  .select(({ fn }) => fn.count('id').as('count'))
  .executeTakeFirst()
```

### Advanced Queries

#### ORDER BY + LIMIT

| Library | Time (avg) | vs bun-query-builder |
|---------|-----------|----------------------|
| **bun-query-builder** | **270 µs** | - |
| Drizzle | 274 µs | 1.01x slower |
| Prisma | 488 µs | 1.8x slower |

```ts
// bun-query-builder
await db.selectFrom('posts')
  .orderBy('created_at', 'desc')
  .limit(50)
  .get()
```

#### AGGREGATE: Average Age

| Library | Time (avg) | Notes |
|---------|-----------|-------|
| Kysely | **126 µs** | Fastest |
| **bun-query-builder** | 137 µs | 1.08x slower |
| Prisma | 229 µs | 1.82x slower than Kysely |
| Drizzle | 457 µs | 3.63x slower than Kysely |

```ts
// bun-query-builder
await db.selectFrom('users').avg('age')

// Kysely
const result = await kysely.selectFrom('users')
  .select(({ fn }) => fn.avg('age').as('avg'))
  .executeTakeFirst()
```

### Batch Operations

#### SELECT: Large Result Set (1,000 rows)

| Library | Time (avg) | vs bun-query-builder |
|---------|-----------|----------------------|
| **bun-query-builder** | **247 µs** | - |
| Drizzle | 564 µs | 2.29x slower |
| Prisma | 3,461 µs | **14.04x slower** |

```ts
// bun-query-builder
await db.selectFrom('posts').limit(1000).get()

// Drizzle
await drizzle.select().from(posts).limit(1000)
```

#### INSERT MANY: 100 Users

| Library | Time (avg) | Notes |
|---------|-----------|-------|
| Kysely | **765 µs** | Fastest |
| Drizzle | 1,417 µs | 1.85x slower |
| Prisma | 1,811 µs | 2.37x slower |

#### DELETE MANY: By IDs

| Library | Time (avg) | vs Kysely |
|---------|-----------|-----------|
| Kysely | **21.7 µs** | - |
| Prisma | 66 µs | 3.05x slower |
| Drizzle | 367 µs | 16.93x slower |

## Performance Summary

### Where bun-query-builder Excels

1. **Simple SELECT queries**: 2-6x faster than competitors
2. **COUNT operations**: Up to 8.93x faster than Drizzle
3. **Large result sets**: Up to 14x faster than Prisma
4. **ORDER BY operations**: Competitive with Drizzle, significantly faster than Prisma

### Competitive Performance

- **Aggregations**: Very close to Kysely (within 10%)
- **Batch inserts**: Kysely has a slight edge

## Key Takeaways

- **bun-query-builder consistently outperforms** most query builders for read operations
- For **small, focused queries**, bun-query-builder shows 2-6x performance improvements
- For **large result sets**, the performance gap widens significantly (up to 14x faster than Prisma)
- bun-query-builder leverages **Bun's native SQL** for optimal performance

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

## Benchmark Caveats

- Benchmarks are run on SQLite. Performance may vary with PostgreSQL/MySQL.
- Results reflect specific query patterns. Real-world performance depends on your use case.
- Benchmarks measure query execution time, not including network latency.
- Some benchmarks show errors for certain libraries due to API differences or compatibility issues.

## Contributing

Found a performance issue or have optimization suggestions? We welcome contributions! Please see our [Contributing Guide](https://github.com/stacksjs/bun-query-builder/blob/main/.github/CONTRIBUTING.md).
