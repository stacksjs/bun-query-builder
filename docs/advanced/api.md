# API Reference

Complete list of public APIs exported from `bun-query-builder`.

This page summarizes method signatures and brief descriptions. See feature pages for deeper guides and examples.

## Imports

```ts
import type { CursorPaginationResult, DatabaseSchema, PaginationResult, QueryBuilderConfig, SchemaMeta, SortDirection, TransactionOptions, WhereExpression, WhereOperator } from 'bun-query-builder'
import {
  // Schema and Model Definition
  buildDatabaseSchema,
  buildSchemaMeta,
  config,
  // Query Builder and Configuration
  createQueryBuilder,

  defaultConfig,
  defineModel,

  defineModels,
  loadModels

  // Types for advanced usage

} from 'bun-query-builder'

// Example: Chris's team setup
import { buildDatabaseSchema, buildSchemaMeta, config, createQueryBuilder } from 'bun-query-builder'
import { userModels } from './models'

// Configure for PostgreSQL production environment
config.dialect = 'postgres'
config.aliasing.relationColumnAliasFormat = 'camelCase'

const schema = buildDatabaseSchema(userModels)
const meta = buildSchemaMeta(userModels)
const db = createQueryBuilder<typeof schema>({ schema, meta })
```

## Configuration

- config: Global runtime config (merged via bunfig). Shape: `QueryBuilderConfig`
- defaultConfig: Library defaults

Key sections: `dialect`, `timestamps`, `pagination`, `aliasing`, `relations`, `transactionDefaults`, `sql`, `features`, `debug`.

## Schema & Models

- defineModel(model)
- defineModels(models)
- buildDatabaseSchema(models): DatabaseSchema
- buildSchemaMeta(models): { modelToTable, tableToModel, primaryKeys }

## Loading Models

- loadModels({ modelsDir, cwd? }): ModelRecord

## Query Builder Factory

- createQueryBuilder<DB>(state?): QueryBuilder<DB>
  - state: { sql?, meta?, schema?, txDefaults? }

## QueryBuilder<DB>

- select(table, ...columns)
- selectFrom(table)
- selectFromSub(sub, alias)
- insertInto(table)
- updateTable(table)
- deleteFrom(table)
- sql: passthrough to Bun’s `sql`
- raw(strings, ...values)
- simple(strings, ...values)
- unsafe(query, params?)
- file(path, params?)
- reserve(): Promise<QueryBuilder & { release() }>
- close(opts?)
- listen(channel, handler?)
- unlisten(channel?)
- notify(channel, payload?)
- copyTo(queryOrTable, options?) [stub]
- copyFrom(queryOrTable, source, options?) [stub]
- ping()
- waitForReady({ attempts?, delayMs? })
- transaction(fn, options?)
- savepoint(fn)
- beginDistributed(name, fn)
- commitDistributed(name)
- rollbackDistributed(name)
- configure(partialConfig)
- setTransactionDefaults(defaults)
- transactional(fn, options?) → (...args) => Promise
- count(table, column?)
- sum(table, column)
- avg(table, column)
- min(table, column)
- max(table, column)

## SelectQueryBuilder

### Query Construction
- `distinct()` - Remove duplicate rows from results
- `distinctOn(...columns)` - PostgreSQL-specific distinct on specific columns
- `select(table, ...columns)` - Select specific columns from a table
- `selectRaw(fragment)` - Add raw SQL expressions to SELECT clause
- `addSelect(...columns)` - Add additional columns to existing selection

### Filtering and Conditions
- `where(expr)` - Add WHERE conditions using object, tuple, or raw expressions
- `whereRaw(fragment)` - Add raw WHERE clauses
- `whereColumn(left, op, right)` - Compare two columns
- `orWhereColumn(left, op, right)` - OR column comparison
- `whereNested(fragment)` - Nested WHERE conditions
- `orWhereNested(fragment)` - OR nested conditions
- `whereDate(column, op, date)` - Date-specific filtering
- `whereBetween(column, start, end)` - Range filtering
- `whereNotBetween(column, start, end)` - Exclude range
- `whereJsonContains(column, json)` - JSON containment (dialect-specific)
- `whereJsonPath(path, op, value)` - JSON path queries (PostgreSQL)
- `whereNull(column)` - NULL checks
- `whereNotNull(column)` - NOT NULL checks
- `whereIn(column, values)` - IN clause filtering
- `whereNotIn(column, values)` - NOT IN clause filtering
- `andWhere(expr)` - AND condition
- `orWhere(expr)` - OR condition

### Ordering and Limiting
- `orderBy(column, dir?)` - Order results by column
- `orderByDesc(column)` - Order descending
- `orderByRaw(fragment)` - Raw ORDER BY expressions
- `inRandomOrder()` - Random ordering (dialect-specific)
- `reorder(column, dir?)` - Replace existing ordering
- `latest(column?)` - Order by timestamp descending
- `oldest(column?)` - Order by timestamp ascending
- `limit(n)` - Limit number of results
- `offset(n)` - Skip rows

### Joins and Relations
- `join(table, onLeft, op, onRight)` - INNER JOIN
- `joinSub(sub, alias, onLeft, op, onRight)` - JOIN with subquery
- `innerJoin(...)` - Explicit INNER JOIN
- `leftJoin(...)` - LEFT JOIN
- `leftJoinSub(...)` - LEFT JOIN with subquery
- `rightJoin(...)` - RIGHT JOIN
- `crossJoin(table)` - CROSS JOIN
- `crossJoinSub(sub, alias)` - CROSS JOIN with subquery
- `with(...relations)` - Eager load relations via LEFT JOIN
- `selectAllRelations()` - Auto-select all relation columns with aliases
- `withCount(relation, alias?, where?)` - Add relation count column
- `whereHas(relation, where?)` - Filter by related record existence
- `orWhereHas(relation, where?)` - OR filter by relations

### Grouping and Aggregation
- `groupBy(...columns)` - GROUP BY columns
- `groupByRaw(fragment)` - Raw GROUP BY expressions
- `having(expr)` - HAVING clauses
- `havingRaw(fragment)` - Raw HAVING expressions

### Set Operations
- `union(sub)` - UNION with another query
- `unionAll(sub)` - UNION ALL with duplicates

### Result Retrieval
- `get()` - Alias for execute()
- `first()` - Get first result or undefined
- `firstOrFail()` - Get first result or throw error
- `value(column)` - Get single column value
- `pluck(column)` - Get array of column values
- `exists()` - Check if any results exist
- `doesntExist()` - Check if no results exist

### Pagination
- `forPage(page, perPage)` - Simple LIMIT/OFFSET pagination
- `paginate(perPage, page?)` - Full pagination with counts: `{ data, meta: { total, lastPage, ... } }`
- `simplePaginate(perPage, page?)` - Lightweight pagination: `{ data, meta: { hasMore, ... } }`
- `cursorPaginate(perPage, cursor?, column?, dir?)` - Cursor-based pagination: `{ data, meta: { nextCursor, ... } }`

### Bulk Processing
- `chunk(size, handler)` - Process results in chunks using offset pagination
- `chunkById(size, column?, handler?)` - Process using cursor pagination
- `eachById(size, column?, handler?)` - Process individual records with chunking

### Flow Control and Debugging
- `when(condition, then, otherwise?)` - Conditional query building
- `tap(fn)` - Side effects without changing query
- `dump()` - Print SQL and continue
- `dd()` - Print SQL and throw (debug and die)
- `explain()` - Get query execution plan
- `withTimeout(ms)` - Set query timeout
- `abort(signal)` - Attach AbortSignal for cancellation

### Execution and Output
- `toSQL()` - Convert to Bun SQL query object
- `toText()` - Get SQL string (requires debug.captureText)
- `execute()` - Execute query and return results
- `values()` - Get raw result matrix
- `raw()` - Get raw database response
- `simple()` - Use simple protocol (for DDL)
- `cancel()` - Cancel running query

### Example Usage

```ts
// Chris's comprehensive user query
const userAnalytics = await db
  .selectFrom('users')
  .select('users', 'id', 'name', 'email', 'created_at')
  .selectRaw(db.sql`COUNT(posts.id) as post_count`)
  .with('Profile', 'Team')
  .leftJoin('posts', 'posts.author_id', '=', 'users.id')
  .where({ 'users.active': true })
  .whereHas('Team', ['department', '=', 'Engineering'])
  .whereBetween('users.created_at', new Date('2024-01-01'), new Date())
  .groupBy('users.id', 'users.name', 'users.email', 'users.created_at')
  .having(['post_count', '>', 0])
  .orderByDesc('post_count')
  .when(process.env.DEBUG === '1', qb => qb.dump())
  .paginate(25, 1)

// Avery's e-commerce product search
const products = await db
  .selectFrom('products')
  .selectAllRelations()
  .with('Category', 'Reviews')
  .where(['products.active', '=', true])
  .whereJsonContains('attributes', { featured: true })
  .withCount('Reviews', 'review_count', ['rating', '>=', 4])
  .cursorPaginate(20, cursor, 'created_at', 'desc')

// Buddy's batch data processing
await db
  .selectFrom('large_dataset')
  .where(['processed', '=', false])
  .orderBy('id', 'asc')
  .chunkById(1000, 'id', async (batch) => {
    await processBatch(batch)
  })
```

## InsertQueryBuilder

- values(row | rows[])
- returning(...columns) [PG]
- toSQL()
- execute()

## UpdateQueryBuilder

- set(values)
- where(expr)
- returning(...columns) [PG]
- toSQL()
- execute()

## DeleteQueryBuilder

- where(expr)
- returning(...columns) [PG]
- toSQL()
- execute()

## Types (selected)

- WhereOperator: '=', '!=', '<', '>', '<=', '>=', 'like', 'in', 'not in', 'is', 'is not'
- WhereExpression<TColumns>: object | tuple | raw
- QueryBuilderConfig: see Configuration section
- DatabaseSchema<ModelRecord>

---

For detailed usage and best practices, see the pages under Features and Advanced.
