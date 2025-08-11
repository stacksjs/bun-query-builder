# API Reference

Complete list of public APIs exported from `bun-query-builder`.

This page summarizes method signatures and brief descriptions. See feature pages for deeper guides and examples.

## Imports

```ts
import {
  buildDatabaseSchema,
  buildSchemaMeta, // types/config
  config,
  // builder
  createQueryBuilder,
  defaultConfig,
  // schema
  defineModel,
  defineModels,
} from 'bun-query-builder'
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

- distinct()
- distinctOn(...columns) [PG]
- selectRaw(fragment)
- where(expr)
- whereRaw(fragment)
- whereColumn(left, op, right)
- orWhereColumn(left, op, right)
- whereNested(fragment)
- orWhereNested(fragment)
- whereDate(column, op, date)
- whereBetween(column, start, end)
- whereNotBetween(column, start, end)
- whereJsonContains(column, json)
- whereNull(column)
- whereNotNull(column)
- andWhere(expr)
- orWhere(expr)
- orderBy(column, dir?)
- orderByDesc(column)
- inRandomOrder()
- reorder(column, dir?)
- latest(column?)
- oldest(column?)
- limit(n)
- offset(n)
- join(table, onLeft, op, onRight)
- joinSub(sub, alias, onLeft, op, onRight)
- innerJoin(...)
- leftJoin(...)
- leftJoinSub(...)
- rightJoin(...)
- crossJoin(table)
- crossJoinSub(sub, alias)
- selectAllRelations()
- groupBy(...columns)
- groupByRaw(fragment)
- having(expr)
- havingRaw(fragment)
- union(sub)
- unionAll(sub)
- forPage(page, perPage)
- value(column)
- pluck(column)
- exists()
- doesntExist()
- paginate(perPage, page?)
- simplePaginate(perPage, page?)
- cursorPaginate(perPage, cursor?, column?, dir?)
- chunk(size, handler)
- chunkById(size, column?, handler?)
- eachById(size, column?, handler?)
- when(condition, then, otherwise?)
- tap(fn)
- dump()
- dd()
- explain()
- simple()
- toText() [when debug.captureText]
- toSQL()
- execute()
- values()
- raw()
- cancel()

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
