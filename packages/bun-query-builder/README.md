# bun-query-builder

A simple yet performant query builder for TypeScript. Built with Bun.

## Installation

```bash
bun add bun-query-builder
```

```bash
npm install bun-query-builder
```

## Usage

```typescript
import { QueryBuilder } from 'bun-query-builder'

// Select query
const users = await QueryBuilder
  .selectFrom('users')
  .where('active', '=', true)
  .orderByDesc('created_at')
  .limit(10)
  .get()

// Insert
await QueryBuilder
  .insertInto('users')
  .values({ name: 'John', email: 'john@example.com' })
  .execute()

// Update
await QueryBuilder
  .update('users')
  .set({ active: false })
  .where('id', '=', 1)
  .execute()

// Delete
await QueryBuilder
  .deleteFrom('users')
  .where('id', '=', 1)
  .execute()
```

## Features

- **Typed from Models** - Infer tables, columns, and primary keys from your model files
- **Fluent Builder** - `select`, `insert`, `update`, `delete`, `where`, `join`, `groupBy`, `having`, `union`
- **Aggregations** - `count()`, `avg()`, `sum()`, `max()`, `min()` with full type safety
- **Batch Operations** - `insertMany()`, `updateMany()`, `deleteMany()` for efficient bulk operations
- **Relations** - `with(...)`, `withCount(...)`, `whereHas(...)`, `has()`, `doesntHave()`
- **Query Caching** - Built-in LRU cache with TTL support
- **Model Hooks** - Lifecycle events for `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`
- **Transactions** - Full transaction support with retries, backoff, and isolation levels
- **Migrations** - Generate and execute migrations from models with diff support
- **Seeders** - Database seeding with fake data generation
- **Soft Deletes** - `withTrashed()`, `onlyTrashed()` for logical deletion
- **Pagination** - `paginate`, `simplePaginate`, `cursorPaginate`, `chunk`, `chunkById`
- **CLI** - Introspection, query printing, connectivity checks, and more

## License

MIT
