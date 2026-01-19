# API Reference

Complete API reference for bun-query-builder.

## Core Functions

### createQueryBuilder

Create a new query builder instance.

```typescript
import { createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from 'bun-query-builder'

const db = createQueryBuilder<typeof schema>({
  schema: buildDatabaseSchema(models),
  meta: buildSchemaMeta(models),
  hooks?: {
    beforeCreate?: (ctx) => Promise<void>
    afterCreate?: (ctx) => Promise<void>
    beforeUpdate?: (ctx) => Promise<void>
    afterUpdate?: (ctx) => Promise<void>
    beforeDelete?: (ctx) => Promise<void>
    afterDelete?: (ctx) => Promise<void>
  }
})
```

### buildDatabaseSchema

Build a database schema from model definitions.

```typescript
const schema = buildDatabaseSchema(models)
```

### buildSchemaMeta

Build schema metadata from model definitions.

```typescript
const meta = buildSchemaMeta(models)
```

## Query Builder Methods

### SELECT Operations

| Method | Description | Example |
|--------|-------------|---------|
| `selectFrom(table)` | Start a SELECT query | `db.selectFrom('users')` |
| `select(columns)` | Select specific columns | `.select(['id', 'name'])` |
| `selectRaw(sql)` | Select with raw SQL | `.selectRaw('COUNT(*) as count')` |
| `distinct()` | Add DISTINCT modifier | `.distinct()` |
| `distinctOn(columns)` | DISTINCT ON (PostgreSQL) | `.distinctOn('email')` |

### WHERE Clauses

| Method | Description | Example |
|--------|-------------|---------|
| `where(condition)` | Add WHERE clause | `.where({ active: true })` |
| `where(col, op, val)` | WHERE with operator | `.where('age', '>=', 18)` |
| `andWhere(...)` | AND condition | `.andWhere('role', '=', 'admin')` |
| `orWhere(...)` | OR condition | `.orWhere('role', '=', 'mod')` |
| `whereIn(col, vals)` | WHERE IN | `.whereIn('id', [1, 2, 3])` |
| `whereNotIn(col, vals)` | WHERE NOT IN | `.whereNotIn('status', ['banned'])` |
| `whereBetween(col, a, b)` | WHERE BETWEEN | `.whereBetween('age', 18, 65)` |
| `whereNull(col)` | WHERE IS NULL | `.whereNull('deleted_at')` |
| `whereNotNull(col)` | WHERE IS NOT NULL | `.whereNotNull('email')` |
| `whereColumn(a, op, b)` | Compare columns | `.whereColumn('a', '=', 'b')` |
| `whereRaw(sql)` | Raw WHERE clause | `.whereRaw('LOWER(name) = ?', ['john'])` |

### JOIN Operations

| Method | Description | Example |
|--------|-------------|---------|
| `join(table, a, op, b)` | INNER JOIN | `.join('posts', 'users.id', '=', 'posts.user_id')` |
| `leftJoin(...)` | LEFT JOIN | `.leftJoin('posts', ...)` |
| `rightJoin(...)` | RIGHT JOIN | `.rightJoin('posts', ...)` |
| `crossJoin(table)` | CROSS JOIN | `.crossJoin('categories')` |

### ORDER & LIMIT

| Method | Description | Example |
|--------|-------------|---------|
| `orderBy(col, dir)` | ORDER BY | `.orderBy('name', 'asc')` |
| `orderByDesc(col)` | ORDER BY DESC | `.orderByDesc('created_at')` |
| `latest()` | Order by created_at DESC | `.latest()` |
| `oldest()` | Order by created_at ASC | `.oldest()` |
| `inRandomOrder()` | Random order | `.inRandomOrder()` |
| `limit(n)` | LIMIT | `.limit(10)` |
| `offset(n)` | OFFSET | `.offset(20)` |

### Aggregations

| Method | Description | Example |
|--------|-------------|---------|
| `count()` | COUNT(*) | `await db.selectFrom('users').count()` |
| `sum(col)` | SUM | `await db.selectFrom('orders').sum('total')` |
| `avg(col)` | AVG | `await db.selectFrom('users').avg('age')` |
| `min(col)` | MIN | `await db.selectFrom('products').min('price')` |
| `max(col)` | MAX | `await db.selectFrom('products').max('price')` |
| `groupBy(cols)` | GROUP BY | `.groupBy('department')` |
| `having(col, op, val)` | HAVING | `.having('count', '>', 5)` |

### Execution Methods

| Method | Description | Example |
|--------|-------------|---------|
| `get()` | Execute and get all rows | `await query.get()` |
| `first()` | Get first row | `await query.first()` |
| `execute()` | Execute query | `await query.execute()` |
| `toSQL()` | Get SQL string | `query.toSQL()` |

### INSERT Operations

| Method | Description | Example |
|--------|-------------|---------|
| `insertInto(table)` | Start INSERT | `db.insertInto('users')` |
| `values(data)` | Set values | `.values({ name: 'John' })` |
| `returning(cols)` | Return columns | `.returning(['id'])` |
| `onConflict(col)` | ON CONFLICT | `.onConflict('email')` |
| `doUpdate(data)` | DO UPDATE | `.doUpdate({ name: 'John' })` |
| `doNothing()` | DO NOTHING | `.doNothing()` |
| `insertMany(table, rows)` | Bulk insert | `db.insertMany('users', [...])` |

### UPDATE Operations

| Method | Description | Example |
|--------|-------------|---------|
| `update(table)` | Start UPDATE | `db.update('users')` |
| `set(data)` | Set values | `.set({ active: false })` |
| `increment(col, n)` | Increment | `.increment('views', 1)` |
| `decrement(col, n)` | Decrement | `.decrement('stock', 1)` |
| `updateMany(table, where, set)` | Bulk update | `db.updateMany('users', {...}, {...})` |

### DELETE Operations

| Method | Description | Example |
|--------|-------------|---------|
| `deleteFrom(table)` | Start DELETE | `db.deleteFrom('users')` |
| `deleteMany(table, ids)` | Bulk delete | `db.deleteMany('users', [1, 2, 3])` |

### Relations

| Method | Description | Example |
|--------|-------------|---------|
| `with(relations)` | Eager load | `.with('posts')` |
| `withCount(relation)` | Count relation | `.withCount('comments')` |
| `has(relation)` | Has relation | `.has('posts')` |
| `doesntHave(relation)` | Missing relation | `.doesntHave('posts')` |
| `whereHas(rel, cb)` | Filter by relation | `.whereHas('posts', q => q.where(...))` |

### Pagination

| Method | Description | Example |
|--------|-------------|---------|
| `paginate(perPage)` | Paginate results | `await query.paginate(20)` |
| `simplePaginate(perPage)` | Simple pagination | `await query.simplePaginate(20)` |
| `cursorPaginate(cursor, limit)` | Cursor pagination | `await query.cursorPaginate(cursor, 20)` |

### Chunking

| Method | Description | Example |
|--------|-------------|---------|
| `chunk(size, cb)` | Process in chunks | `await query.chunk(100, cb)` |
| `chunkById(size, cb)` | Chunk by ID | `await query.chunkById(100, cb)` |
| `eachById(cb)` | Process each by ID | `await query.eachById(cb)` |

### Caching

| Method | Description | Example |
|--------|-------------|---------|
| `cache(ttl?)` | Cache query | `.cache(5000)` |
| `clearQueryCache()` | Clear cache | `clearQueryCache()` |
| `setQueryCacheMaxSize(n)` | Set cache size | `setQueryCacheMaxSize(500)` |

### Soft Deletes

| Method | Description | Example |
|--------|-------------|---------|
| `withTrashed()` | Include soft deleted | `.withTrashed()` |
| `onlyTrashed()` | Only soft deleted | `.onlyTrashed()` |

### Scopes

| Method | Description | Example |
|--------|-------------|---------|
| `scope(name)` | Apply model scope | `.scope('active')` |

## Transactions

### transaction

Execute queries in a transaction.

```typescript
await db.transaction(async (trx) => {
  await trx.insertInto('users').values({...}).execute()
  await trx.update('accounts').set({...}).execute()
})
```

### Transaction Options

```typescript
await db.transaction(async (trx) => {
  // ...
}, {
  isolationLevel: 'serializable',
  retries: 3,
  backoff: 'exponential',
  onRetry: (attempt, error) => console.log(`Retry ${attempt}`)
})
```

## Migrations

### generateMigration

Generate a migration from models.

```typescript
import { generateMigration } from 'bun-query-builder'

const migration = await generateMigration('./models', {
  dialect: 'postgres',
  apply: true,
  full: true
})
```

### executeMigration

Execute a migration.

```typescript
import { executeMigration } from 'bun-query-builder'

await executeMigration(migration)
```

## Seeders

### runSeeders

Run all seeders.

```typescript
import { runSeeders } from 'bun-query-builder'

await runSeeders({
  seedersDir: './database/seeders',
  verbose: true
})
```

### runSeeder

Run a specific seeder.

```typescript
import { runSeeder } from 'bun-query-builder'

await runSeeder('UserSeeder', { verbose: true })
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `qb make:model <name>` | Generate a model |
| `qb migrate` | Run migrations |
| `qb migrate:rollback` | Rollback migrations |
| `qb migrate:fresh` | Fresh migration |
| `qb seed` | Run seeders |
| `qb make:seeder <name>` | Generate a seeder |
| `qb db:info` | Database info |
| `qb console` | Interactive REPL |
| `qb cache:clear` | Clear query cache |

## Types

### WhereOperator

```typescript
type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in' | 'not in' | 'is' | 'is not'
```

### SortDirection

```typescript
type SortDirection = 'asc' | 'desc'
```

### Hook Context

```typescript
interface CreateHookContext {
  table: string
  data: Record<string, any>
}

interface UpdateHookContext {
  table: string
  data: Record<string, any>
  where: Record<string, any>
}

interface DeleteHookContext {
  table: string
  where: Record<string, any>
}
```
