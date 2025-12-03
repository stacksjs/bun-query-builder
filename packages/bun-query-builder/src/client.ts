/* eslint-disable regexp/no-super-linear-backtracking */

/* eslint-disable no-useless-catch */
import type { SchemaMeta } from './meta'
import type { DatabaseSchema } from './schema'
import { config } from './config'
import { bunSql, getOrCreateBunSql, resetConnection } from './db'

export { resetConnection }

// Type guard for raw SQL expressions
interface RawExpression {
  raw: string
}

function isRawExpression(expr: unknown): expr is RawExpression {
  return typeof expr === 'object' && expr !== null && 'raw' in expr && typeof (expr as RawExpression).raw === 'string'
}

// Pre-compiled regex patterns for performance
const SQL_PATTERNS = {
  SELECT_STAR: /^SELECT\s+\*/i,
  SELECT: /^SELECT\s+/i,
  SELECT_FROM: /^SELECT\s+(.+?)\s+FROM/i,
  WHERE: /\bWHERE\b/i,
  IDENTIFIER: /^[A-Z_][\w.]*$/i,
  DELETED_AT: /\bdeleted_at\b/i,
} as const

// Simple query cache with TTL support
interface CacheEntry {
  data: any
  expiresAt: number
}

class QueryCache {
  private cache = new Map<string, CacheEntry>()
  private maxSize = 100

  get(key: string): any | null {
    const entry = this.cache.get(key)
    if (!entry)
      return null

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    return entry.data
  }

  set(key: string, data: any, ttlMs: number): void {
    // Simple LRU: if cache is full, delete oldest entry
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey)
        this.cache.delete(firstKey)
    }

    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    })
  }

  clear(): void {
    this.cache.clear()
  }

  setMaxSize(size: number): void {
    this.maxSize = size
  }
}

const queryCache = new QueryCache()

// Where condition helpers
type Primitive = string | number | boolean | bigint | Date | null | undefined
type ValueOrRef = Primitive

export type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in' | 'not in' | 'is' | 'is not'

export interface WhereRaw {
  raw: any
}

export type WhereExpression<TableColumns> =
  | Partial<{ [K in keyof TableColumns & string]: ValueOrRef | ValueOrRef[] }>
  | [key: keyof TableColumns & string, op: WhereOperator, value: ValueOrRef | ValueOrRef[]]
  | WhereRaw

export type QueryResult = any

/**
 * # `SortDirection`
 *
 * The direction used when ordering query results.
 */
export type SortDirection = 'asc' | 'desc'

/**
 * # `ColumnName<DB, TTable>`
 *
 * Helper type extracting a string union of column names for a given table.
 */
export type ColumnName<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> = keyof DB[TTable]['columns'] & string
// Named row alias to improve IDE hover readability
export type SelectedRow<
  DB extends DatabaseSchema<any>,
  _TTable extends keyof DB & string,
  TSelected,
> = Readonly<TSelected>

type JoinColumn<DB extends DatabaseSchema<any>, TTables extends string> = TTables extends any
  ? `${TTables}.${keyof DB[TTables]['columns'] & string}`
  : never

// Convert snake_case to PascalCase at the type level (e.g. created_at -> CreatedAt)
type SnakeToPascal<S extends string> = S extends `${infer H}_${infer T}`
  ? `${Capitalize<H>}${SnakeToPascal<T>}`
  : Capitalize<S>

// Typed SQL builder (type-level only). We piggy-back on the runtime builder but
// thread a phantom TSql string through method signatures so hovers can show the
// composed SQL at compile-time for common operations.
type _TypedDynamicWhereMethods<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string,
  TSql extends string,
> = {
  [K in keyof DB[TTable]['columns'] & string as `where${SnakeToPascal<K>}`]: (
    value: DB[TTable]['columns'][K],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${K} = ?`>
} & {
  [K in keyof DB[TTable]['columns'] & string as `orWhere${SnakeToPascal<K>}`]: (
    value: DB[TTable]['columns'][K],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${K} = ?`>
} & {
  [K in keyof DB[TTable]['columns'] & string as `andWhere${SnakeToPascal<K>}`]: (
    value: DB[TTable]['columns'][K],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${K} = ?`>
}

export type TypedSelectQueryBuilder<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
  TSql extends string = `SELECT * FROM ${TTable}`,
> = Omit<
  BaseSelectQueryBuilder<DB, TTable, TSelected, TJoined>,
  'toSQL' | 'where' | 'andWhere' | 'orWhere' | 'orderBy' | 'limit'
> & DynamicWhereMethods<DB, TTable, TSelected, TJoined>
& _TypedDynamicWhereMethods<DB, TTable, TSelected, TJoined, TSql>
& {
  toSQL: () => TSql
  where: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, any],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: any,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} WHERE ${string}`>)
  andWhere: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, any],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: any,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} AND ${string}`>)
  orWhere: (<K extends keyof DB[TTable]['columns'] & string>(
    expr: Record<K, DB[TTable]['columns'][K]>,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${K} = ?`>) & (<K extends keyof DB[TTable]['columns'] & string, OP extends WhereOperator>(
    expr: [K, OP, any],
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${K} ${Uppercase<OP>} ${OP extends 'in' | 'not in' ? '(?)' : '?'}`>) & ((
    expr: WhereExpression<DB[TTable]['columns']> | string,
    op?: WhereOperator,
    value?: any,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} OR ${string}`>)
  orderBy: <C extends keyof DB[TTable]['columns'] & string, D extends 'asc' | 'desc' = 'asc'>(
    column: C,
    direction?: D,
  ) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} ORDER BY ${C} ${D}`>
  limit: <N extends number>(n: N) => TypedSelectQueryBuilder<DB, TTable, TSelected, TJoined, `${TSql} LIMIT ${N}`>
}

type DynamicWhereMethods<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> = {
  [K in keyof DB[TTable]['columns'] & string as `where${SnakeToPascal<K>}`]: (value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
} & {
  [K in keyof DB[TTable]['columns'] & string as `orWhere${SnakeToPascal<K>}`]: (value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
} & {
  [K in keyof DB[TTable]['columns'] & string as `andWhere${SnakeToPascal<K>}`]: (value: DB[TTable]['columns'][K]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
}

export interface BaseSelectQueryBuilder<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> {
  // modifiers
  /**
   * # `distinct`
   *
   * Applies a DISTINCT modifier to the select list.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').distinct().get()
   * const sql = db.selectFrom('users').distinct().toSQL()
   * ```
   */
  distinct: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `distinctOn`
   *
   * Applies a DISTINCT ON clause (PostgreSQL).
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').distinctOn('email').get()
   * const sql = db.selectFrom('users').distinctOn('email', 'name').toSQL()
   * ```
   */
  distinctOn: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `selectRaw`
   *
   * Appends a raw fragment to the SELECT list.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').selectRaw(sql`count(*) as c`).get()
   * const sqlText = db.selectFrom('users').selectRaw(sql`now() as ts`).toSQL()
   * ```
   */
  selectRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `where`
   *
   * Adds a WHERE clause using an object, tuple, or raw fragment.
   *
   * @example
   * ```ts
   * const users = await db.selectFrom('users').where({ id: 1, active: true }).get()
   * const newer = await db.selectFrom('users').where(['created_at', '>', '2024-01-01']).get()
   * const sqlText = db.selectFrom('users').where({ id: 1 }).toSQL()
   * ```
   */
  where: (expr: WhereExpression<DB[TTable]['columns']> | string, op?: WhereOperator, value?: any) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `whereRaw`
   *
   * Adds a raw WHERE fragment.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereRaw(sql`lower(name) = lower(${ 'Alice' })`).get()
   * const sqlText = db.selectFrom('users').whereRaw(sql`custom_condition`).toSQL()
   * ```
   */
  whereRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereColumn`
   *
   * Compares one column to another column.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereColumn('created_at', '>=', 'updated_at').get()
   * const sqlText = db.selectFrom('users').whereColumn('a', '=', 'b').toSQL()
   * ```
   */
  whereColumn: (left: string, op: WhereOperator, right: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereColumn`
   *
   * Adds an OR column-to-column comparison.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereColumn('last_login', '<', 'created_at').get()
   * const sqlText = db.selectFrom('users').orWhereColumn('a', '!=', 'b').toSQL()
   * ```
   */
  orWhereColumn: (left: string, op: WhereOperator, right: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereIn`
   *
   * Filters rows where a column is IN a list or subquery.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereIn('id', [1, 2, 3]).get()
   * const sqlText = db.selectFrom('users').whereIn('id', db.selectFrom('admins').selectRaw(sql`id`)).toSQL()
   * ```
   */
  whereIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereIn`
   *
   * Adds an OR IN filter.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereIn('role', ['admin', 'owner']).get()
   * const sqlText = db.selectFrom('users').orWhereIn('id', [1, 2]).toSQL()
   * ```
   */
  orWhereIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNotIn`
   *
   * Filters rows where a column is NOT IN a list or subquery.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNotIn('id', [1, 2, 3]).get()
   * const sqlText = db.selectFrom('users').whereNotIn('id', [4, 5]).toSQL()
   * ```
   */
  whereNotIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereNotIn`
   *
   * Adds an OR NOT IN filter.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereNotIn('id', [1, 2]).get()
   * const sqlText = db.selectFrom('users').orWhereNotIn('role', ['banned']).toSQL()
   * ```
   */
  orWhereNotIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // convenience like wrappers
  /**
   * # `whereLike`
   *
   * Adds a LIKE filter for a column (case-insensitive by default).
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereLike('name', '%ali%').get()
   * const rowsCs = await db.selectFrom('users').whereLike('name', '%Ali%', true).get()
   * ```
   */
  whereLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Case-insensitive LIKE using native ILIKE on PostgreSQL, fallback LOWER() elsewhere. */
  whereILike?: (column: keyof DB[TTable]['columns'] & string, pattern: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereLike`
   *
   * Adds an OR LIKE filter.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereLike('email', '%@example.com').get()
   * const sqlText = db.selectFrom('users').orWhereLike('name', 'a%').toSQL()
   * ```
   */
  orWhereLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereILike?: (column: keyof DB[TTable]['columns'] & string, pattern: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNotLike`
   *
   * Adds a NOT LIKE filter for a column.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNotLike('name', 'admin%').get()
   * const sqlText = db.selectFrom('users').whereNotLike('email', '%spam%').toSQL()
   * ```
   */
  whereNotLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNotILike?: (column: keyof DB[TTable]['columns'] & string, pattern: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereNotLike`
   *
   * Adds an OR NOT LIKE filter.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhereNotLike('name', '%test%').get()
   * const sqlText = db.selectFrom('users').orWhereNotLike('name', '%bot%').toSQL()
   * ```
   */
  orWhereNotLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereNotILike?: (column: keyof DB[TTable]['columns'] & string, pattern: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // where any/all/none on list of columns
  /**
   * # `whereAny`
   *
   * Matches when any of the given columns satisfy the operator/value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereAny(['first_name', 'last_name'], 'like', '%ali%').get()
   * const sqlText = db.selectFrom('users').whereAny(['email', 'username'], 'like', 'a%').toSQL()
   * ```
   */
  whereAny: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereAll`
   *
   * Matches when all of the given columns satisfy the operator/value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereAll(['active', 'email_verified'], 'is', true).get()
   * const sqlText = db.selectFrom('users').whereAll(['a', 'b'], '=', 1).toSQL()
   * ```
   */
  whereAll: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNone`
   *
   * Matches when none of the given columns satisfy the operator/value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNone(['role', 'status'], 'in', ['banned']).get()
   * const sqlText = db.selectFrom('users').whereNone(['a'], '!=', 1).toSQL()
   * ```
   */
  whereNone: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNested`
   *
   * Wraps a subquery or fragment in parentheses and applies it with WHERE.
   *
   * @example
   * ```ts
   * const sub = db.selectFrom('users').whereLike('name', 'a%')
   * const rows = await db.selectFrom('users').whereNested(sub).get()
   * const sqlText = db.selectFrom('users').whereNested(sub).toSQL()
   * ```
   */
  whereNested: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orWhereNested`
   *
   * Adds an OR-wrapped nested condition.
   *
   * @example
   * ```ts
   * const sub = db.selectFrom('users').where({ active: true })
   * const rows = await db.selectFrom('users').orWhereNested(sub).get()
   * const sqlText = db.selectFrom('users').orWhereNested(sub).toSQL()
   * ```
   */
  orWhereNested: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // date/json helpers (basic variants)
  /**
   * # `whereDate`
   *
   * Compares a column to a date value using the given operator.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereDate('created_at', '>=', '2024-01-01').get()
   * const sqlText = db.selectFrom('users').whereDate('created_at', '<', new Date()).toSQL()
   * ```
   */
  whereDate: (column: string, op: WhereOperator, date: string | Date) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereBetween`
   *
   * Filters rows where a column is within the given inclusive range.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereBetween('id', 10, 20).get()
   * const sqlText = db.selectFrom('users').whereBetween('created_at', '2024-01-01', '2024-12-31').toSQL()
   * ```
   */
  whereBetween: (column: string, start: any, end: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNotBetween`
   *
   * Filters rows where a column is outside the given inclusive range.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNotBetween('id', 10, 20).get()
   * const sqlText = db.selectFrom('users').whereNotBetween('created_at', '2024-01-01', '2024-12-31').toSQL()
   * ```
   */
  whereNotBetween: (column: string, start: any, end: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonContains`
   *
   * Filters rows where a JSON column contains the given JSON value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonContains('tags', ['bun']).get()
   * const sqlText = db.selectFrom('posts').whereJsonContains('meta', { published: true }).toSQL()
   * ```
   */
  whereJsonContains: (column: string, json: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** JSON path comparison across dialects */
  whereJsonPath?: (path: string, op: WhereOperator, value: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `andWhere`
   *
   * Adds an AND condition using the flexible expression format.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).andWhere(['id', '>', 100]).get()
   * const sqlText = db.selectFrom('users').where({ active: true }).andWhere({ email_verified: true }).toSQL()
   * ```
   */
  andWhere: (expr: WhereExpression<DB[TTable]['columns']> | string, op?: WhereOperator, value?: any) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `orWhere`
   *
   * Adds an OR condition using the flexible expression format.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ active: true }).orWhere({ admin: true }).get()
   * const sqlText = db.selectFrom('users').orWhere(['id', 'in', [1,2,3]]).toSQL()
   * ```
   */
  orWhere: (expr: WhereExpression<DB[TTable]['columns']> | string, op?: WhereOperator, value?: any) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `orderBy`
   *
   * Orders the result by a column in ascending or descending order.
   *
   * @param column The column to order by (strongly typed to the table's columns)
   * @param direction Optional direction (asc | desc). Defaults to asc.
   *
   * @example
   * ```ts
   * // Setup
   * const models = defineModels({ User })
   * const schema = buildDatabaseSchema(models)
   * const meta = buildSchemaMeta(models)
   * const db = createQueryBuilder<typeof schema>({ schema, meta })
   *
   * // Usage
   * const rows = await db.selectFrom('users').orderBy('created_at', 'desc').get()
   * const sql = db.selectFrom('users').orderBy('id').toSQL()
   * ```
   */
  orderBy: (column: ColumnName<DB, TTable>, direction?: SortDirection) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `orderByDesc`
   *
   * Convenience for ordering by a column in descending order.
   *
   * @param column The column to order by (strongly typed to the table's columns)
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').orderByDesc('id').get()
   * const sql = db.selectFrom('users').orderByDesc('id').toSQL()
   * ```
   */
  orderByDesc: (column: ColumnName<DB, TTable>) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `inRandomOrder`
   *
   * Orders results randomly using the configured SQL dialect function.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').inRandomOrder().limit(5).get()
   * const sql = db.selectFrom('users').inRandomOrder().toSQL()
   * ```
   */
  inRandomOrder: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `reorder`
   *
   * Replaces any existing ORDER BY clause.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').orderBy('id').reorder('created_at', 'desc').toSQL()
   * const rows = await db.selectFrom('users').reorder('name', 'asc').get()
   * ```
   */
  reorder: (column: string, direction?: 'asc' | 'desc') => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `latest`
   *
   * Orders by the given column (or default timestamp) descending.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').latest().get()
   * const sql = db.selectFrom('users').latest('created_at').toSQL()
   * ```
   */
  latest: (column?: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `oldest`
   *
   * Orders by the given column (or default timestamp) ascending.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').oldest().get()
   * const sql = db.selectFrom('users').oldest('created_at').toSQL()
   * ```
   */
  oldest: (column?: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `limit`
   *
   * Limits the number of rows returned.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').limit(10).get()
   * const sql = db.selectFrom('users').limit(5).toSQL()
   * ```
   */
  limit: (n: number) => SelectQueryBuilder<DB, TTable, TSelected>
  /**
   * # `offset`
   *
   * Offsets the starting row.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').limit(10).offset(10).get()
   * const sql = db.selectFrom('users').offset(20).toSQL()
   * ```
   */
  offset: (n: number) => SelectQueryBuilder<DB, TTable, TSelected>
  /** Apply a timeout (ms) for this query (cancel on expiration). */
  withTimeout?: (ms: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Attach an AbortSignal to cancel this query when aborted. */
  abort?: (signal: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // Joins
  join: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  joinSub: (sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  innerJoin: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  leftJoin: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  leftJoinSub: (sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  rightJoin: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  crossJoin: <T2 extends keyof DB & string>(table: T2) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  crossJoinSub: (sub: { toSQL: () => any }, alias: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `groupBy`
   *
   * Adds a GROUP BY clause.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').groupBy('role').toSQL()
   * const rows = await db.selectFrom('users').groupBy('role', 'status').get()
   * ```
   */
  groupBy: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `groupByRaw`
   *
   * Adds a raw GROUP BY fragment.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').groupByRaw(sql`date_trunc('day', created_at)`).toSQL()
   * const rows = await db.selectFrom('users').groupByRaw(sql`1`).get()
   * ```
   */
  groupByRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `having`
   *
   * Adds a HAVING clause using the flexible expression format.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').groupBy('role').having(['count', '>', 10]).toSQL()
   * const rows = await db.selectFrom('users').having({ active: true }).get()
   * ```
   */
  having: (expr: WhereExpression<any>) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `havingRaw`
   *
   * Adds a raw HAVING fragment.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').groupBy('role').havingRaw(sql`count(*) > 10`).toSQL()
   * const rows = await db.selectFrom('users').havingRaw(sql`count(*) > 0`).get()
   * ```
   */
  havingRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `addSelect`
   *
   * Adds additional columns to the SELECT list.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').addSelect('id', 'name').toSQL()
   * const rows = await db.selectFrom('users').addSelect('email').get()
   * ```
   */
  addSelect: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  select?: (columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  selectAll?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `orderByRaw`
   *
   * Adds a raw ORDER BY fragment.
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').orderByRaw(sql`random()`).toSQL()
   * const rows = await db.selectFrom('users').orderByRaw(sql`1`).get()
   * ```
   */
  orderByRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `union`
   *
   * Unions another query.
   *
   * @example
   * ```ts
   * const a = db.selectFrom('users').where({ active: true })
   * const b = db.selectFrom('users').where({ admin: true })
   * const rows = await a.union(b).get()
   * const sql = a.union(b).toSQL()
   * ```
   */
  union: (other: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `unionAll`
   *
   * Unions another query including duplicates.
   *
   * @example
   * ```ts
   * const a = db.selectFrom('users').where({ active: true })
   * const b = db.selectFrom('users').where({ admin: true })
   * const rows = await a.unionAll(b).get()
   * const sql = a.unionAll(b).toSQL()
   * ```
   */
  unionAll: (other: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `forPage`
   *
   * Applies limit/offset based on page size and page number.
   *
   * @example
   * ```ts
   * const page = await db.selectFrom('users').forPage(2, 10).get()
   * const sql = db.selectFrom('users').forPage(3, 20).toSQL()
   * ```
   */
  forPage: (page: number, perPage: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  selectAllRelations?: () => SelectQueryBuilder<DB, TTable, any, TJoined>
  // where helpers
  /**
   * # `whereNull`
   *
   * Filters rows where a column is NULL.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNull('deleted_at').get()
   * const sql = db.selectFrom('users').whereNull('deleted_at').toSQL()
   * ```
   */
  whereNull?: (column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereNotNull`
   *
   * Filters rows where a column is NOT NULL.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereNotNull('deleted_at').get()
   * const sql = db.selectFrom('users').whereNotNull('deleted_at').toSQL()
   * ```
   */
  whereNotNull?: (column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // whereBetween intentionally omitted here because it is declared above as required
  /**
   * # `whereExists`
   *
   * Filters rows where the subquery returns at least one row.
   *
   * @example
   * ```ts
   * const sub = db.selectFrom('posts').whereColumn('posts.user_id', '=', 'users.id')
   * const rows = await db.selectFrom('users').whereExists(sub).get()
   * const sql = db.selectFrom('users').whereExists(sub).toSQL()
   * ```
   */
  whereExists?: (subquery: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonDoesntContain`
   *
   * Filters rows where a JSON column does not contain the given JSON value.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonDoesntContain('tags', ['spam']).get()
   * const sql = db.selectFrom('posts').whereJsonDoesntContain('tags', ['spam']).toSQL()
   * ```
   */
  whereJsonDoesntContain?: (column: string, json: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonContainsKey`
   *
   * Filters rows where a JSON path contains the given key.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonContainsKey('meta.published').get()
   * const sql = db.selectFrom('posts').whereJsonContainsKey('meta.tags').toSQL()
   * ```
   */
  whereJsonContainsKey?: (path: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonDoesntContainKey`
   *
   * Filters rows where a JSON path does not contain the given key.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonDoesntContainKey('meta.archived').get()
   * const sql = db.selectFrom('posts').whereJsonDoesntContainKey('meta.archived').toSQL()
   * ```
   */
  whereJsonDoesntContainKey?: (path: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `whereJsonLength`
   *
   * Filters rows by the length of a JSON array at the given path.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('posts').whereJsonLength('tags', '>=', 2).get()
   * const sql = db.selectFrom('posts').whereJsonLength('tags', 0).toSQL()
   * ```
   */
  whereJsonLength?: (path: string, opOrLen: WhereOperator | number, len?: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // relations
  /**
   * # `with`
   *
   * Auto-joins related tables inferred from schema metadata.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').with('posts', 'profiles').get()
   * const sql = db.selectFrom('users').with('posts').toSQL()
   * ```
   */
  with?: (...relations: string[]) => SelectQueryBuilder<DB, TTable, TSelected, any>
  /**
   * # `withPivot`
   *
   * Include pivot table columns when eager loading belongsToMany relationships.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').with('tags').withPivot('tags', 'created_at', 'role').get()
   * ```
   */
  withPivot?: (relation: string, ...columns: string[]) => SelectQueryBuilder<DB, TTable, TSelected, any>
  /**
   * # `applyPivotColumns`
   *
   * Apply pivot columns to the SELECT clause.
   */
  applyPivotColumns?: () => SelectQueryBuilder<DB, TTable, TSelected, any>
  // locks
  /**
   * # `lockForUpdate`
   *
   * Applies a FOR UPDATE row lock to the query.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ id: 1 }).lockForUpdate().get()
   * const sql = db.selectFrom('users').lockForUpdate().toSQL()
   * ```
   */
  lockForUpdate: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `sharedLock`
   *
   * Applies a shared lock syntax depending on the dialect configuration.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').where({ id: 1 }).sharedLock().get()
   * const sql = db.selectFrom('users').sharedLock().toSQL()
   * ```
   */
  sharedLock: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // ctes
  /**
   * # `withCTE`
   *
   * Adds a non-recursive Common Table Expression (CTE).
   *
   * @example
   * ```ts
   * const recent = db.selectFrom('users').whereDate('created_at', '>=', '2024-01-01')
   * const rows = await db.selectFrom('users').withCTE('recent_users', recent).get()
   * const sql = db.selectFrom('users').withCTE('recent_users', recent).toSQL()
   * ```
   */
  withCTE: (name: string, sub: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `withRecursive`
   *
   * Adds a recursive Common Table Expression (CTE).
   *
   * @example
   * ```ts
   * const tree = db.selectFrom('categories') // build recursive CTE
   * const rows = await db.selectFrom('categories').withRecursive('tree', tree).get()
   * const sql = db.selectFrom('categories').withRecursive('tree', tree).toSQL()
   * ```
   */
  withRecursive: (name: string, sub: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // results helpers
  /**
   * # `value`
   *
   * Returns a single column value from the first row.
   *
   * @example
   * ```ts
   * const name = await db.selectFrom('users').whereId(1).value('name')
   * const createdAt = await db.selectFrom('users').orderBy('id', 'desc').value('created_at')
   * ```
   */
  value: <K extends keyof TSelected & string>(column: K) => Promise<SelectedRow<DB, TTable, TSelected>[K]>
  pluck: {
    /**
     * # `pluck(column)`
     *
     * Returns an array of values for a single column.
     *
     * @example
     * ```ts
     * const names = await db.selectFrom('users').pluck('name')
     * const ids = await db.selectFrom('users').orderBy('id').pluck('id')
     * ```
     */
    <K extends keyof TSelected & string>(column: K): Promise<SelectedRow<DB, TTable, TSelected>[K][]>
    /**
     * # `pluck(column, key)`
     *
     * Returns an object keyed by the given key column.
     *
     * @example
     * ```ts
     * const byId = await db.selectFrom('users').pluck('email', 'id')
     * const map = await db.selectFrom('users').pluck('name', 'email')
     * ```
     */
    <K extends keyof TSelected & string, K2 extends keyof TSelected & string>(column: K, key: K2): Promise<Record<string, SelectedRow<DB, TTable, TSelected>[K]>>
  }
  /**
   * # `exists`
   *
   * Returns true if the query returns at least one row.
   *
   * @example
   * ```ts
   * const hasUsers = await db.selectFrom('users').exists()
   * const hasAdmins = await db.selectFrom('users').where({ admin: true }).exists()
   * ```
   */
  exists: () => Promise<boolean>
  /**
   * # `doesntExist`
   *
   * Returns true if the query returns no rows.
   *
   * @example
   * ```ts
   * const noUsers = await db.selectFrom('users').where({ id: -1 }).doesntExist()
   * const none = await db.selectFrom('users').where({ active: false }).doesntExist()
   * ```
   */
  doesntExist: () => Promise<boolean>
  /**
   * # `cursorPaginate`
   *
   * Cursor-based pagination helper.
   *
   * @example
   * ```ts
   * const page1 = await db.selectFrom('users').cursorPaginate(10)
   * const page2 = await db.selectFrom('users').cursorPaginate(10, page1.meta.nextCursor)
   * ```
   */
  cursorPaginate: (perPage: number, cursor?: string | number, column?: string, direction?: 'asc' | 'desc') => Promise<{ data: any[], meta: { perPage: number, nextCursor: string | number | null } }>
  /**
   * # `chunk`
   *
   * Iterates through results in pages and invokes the handler for each chunk.
   *
   * @example
   * ```ts
   * await db.selectFrom('users').chunk(100, async rows => {
   *   // process rows
   * })
   * const done = await db.selectFrom('users').chunk(50, () => {})
   * ```
   */
  chunk: (size: number, handler: (rows: any[]) => Promise<void> | void) => Promise<void>
  /**
   * # `chunkById`
   *
   * Iterates through results using cursor-based pagination on an id-like column.
   *
   * @example
   * ```ts
   * await db.selectFrom('users').chunkById(100, 'id', async rows => { // noop })
   * await db.selectFrom('users').chunkById(100)
   * ```
   */
  chunkById: (size: number, column?: string, handler?: (rows: any[]) => Promise<void> | void) => Promise<void>
  /**
   * # `eachById`
   *
   * Iterates row-by-row using id-based cursor pagination.
   *
   * @example
   * ```ts
   * await db.selectFrom('users').eachById(100, 'id', async row => { // noop })
   * await db.selectFrom('users').eachById(50)
   * ```
   */
  eachById: (size: number, column?: string, handler?: (row: any) => Promise<void> | void) => Promise<void>
  /**
   * # `when`
   *
   * Conditionally modifies the query.
   *
   * @example
   * ```ts
   * const activeOnly = true
   * const q = db.selectFrom('users').when(activeOnly, qb => qb.where({ active: true }))
   * const sql = q.toSQL()
   * ```
   */
  when: (condition: any, then: (qb: any) => any, otherwise?: (qb: any) => any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `tap`
   *
   * Runs a side-effect function and returns the builder for chaining.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').tap(qb => qb.orderBy('id')).get()
   * const sql = db.selectFrom('users').tap(() => {}).toSQL()
   * ```
   */
  tap: (fn: (qb: any) => any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `dump`
   *
   * Logs the SQL string to the console and returns the builder.
   *
   * @example
   * ```ts
   * db.selectFrom('users').whereId(1).dump().get()
   * db.selectFrom('users').orderBy('id').dump()
   * ```
   */
  dump: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /**
   * # `dd`
   *
   * Dumps the SQL and throws an error to stop execution.
   *
   * @example
   * ```ts
   * // db.selectFrom('users').whereId(1).dd()
   * ```
   */
  dd: () => never
  /**
   * # `explain`
   *
   * Runs EXPLAIN on the built query and returns the plan rows.
   *
   * @example
   * ```ts
   * const plan = await db.selectFrom('users').whereId(1).explain()
   * const plan2 = await db.selectFrom('users').orderBy('id').limit(1).explain()
   * ```
   */
  explain: () => Promise<any[]>
  /**
   * # `simple`
   *
   * Returns the Bun.sql simple representation for the built query.
   *
   * @example
   * ```ts
   * const s = db.selectFrom('users').whereId(1).simple()
   * const t = db.selectFrom('users').orderBy('id').simple()
   * ```
   */
  simple: () => any
  toText?: () => string
  /**
   * # `paginate`
   *
   * Paginates results using LIMIT/OFFSET and returns data with meta info.
   *
   * @example
   * ```ts
   * const res = await db.selectFrom('users').paginate(10, 2)
   * const res2 = await db.selectFrom('users').where({ active: true }).paginate(25)
   * ```
   */
  paginate: (perPage: number, page?: number) => Promise<{ data: SelectedRow<DB, TTable, TSelected>[], meta: { perPage: number, page: number, total: number, lastPage: number } }>
  /**
   * # `simplePaginate`
   *
   * Lightweight paginator using LIMIT/OFFSET and a hasMore flag.
   *
   * @example
   * ```ts
   * const res = await db.selectFrom('users').simplePaginate(10, 1)
   * const res2 = await db.selectFrom('users').where({ active: true }).simplePaginate(25)
   * ```
   */
  simplePaginate: (perPage: number, page?: number) => Promise<{ data: SelectedRow<DB, TTable, TSelected>[], meta: { perPage: number, page: number, hasMore: boolean } }>
  /**
   * # `toSQL`
   *
   * Returns the SQL string for the current query (with placeholders).
   *
   * @example
   * ```ts
   * const sql = db.selectFrom('users').where({ id: 1 }).toSQL()
   * const text = db.selectFrom('users').orderBy('id').toSQL()
   * ```
   */
  toSQL: () => string
  execute: () => Promise<SelectedRow<DB, TTable, TSelected>[]>
  executeTakeFirst: () => Promise<SelectedRow<DB, TTable, TSelected> | undefined>
  // Laravel-style retrieval helpers
  /**
   * # `get`
   *
   * Executes the query and returns all rows.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereName('Alice').get()
   * const rows2 = await db.selectFrom('users').orderBy('id', 'desc').get()
   * ```
   */
  get: () => Promise<SelectedRow<DB, TTable, TSelected>[]>
  /**
   * # `first`
   *
   * Returns the first row or undefined if none found.
   *
   * @example
   * ```ts
   * const row = await db.selectFrom('users').whereId(1).first()
   * const row2 = await db.selectFrom('users').orderBy('id').first()
   * ```
   */
  first: () => Promise<SelectedRow<DB, TTable, TSelected> | undefined>
  /**
   * # `firstOrFail`
   *
   * Returns the first row or throws if none found.
   *
   * @example
   * ```ts
   * const row = await db.selectFrom('users').whereId(1).firstOrFail()
   * const row2 = await db.selectFrom('users').where({ email: 'a@b.c' }).firstOrFail()
   * ```
   */
  firstOrFail: () => Promise<SelectedRow<DB, TTable, TSelected>>
  find: (id: any) => Promise<SelectedRow<DB, TTable, TSelected> | undefined>
  findOrFail: (id: any) => Promise<SelectedRow<DB, TTable, TSelected>>
  findMany: (ids: any[]) => Promise<TSelected[]>
  lazy: () => AsyncIterable<TSelected>
  lazyById: () => AsyncIterable<TSelected>
  pipe: <R>(fn: (qb: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => R) => R
  count: () => Promise<number>
  avg: (column: keyof DB[TTable]['columns'] & string) => Promise<number>
  sum: (column: keyof DB[TTable]['columns'] & string) => Promise<number>
  max: (column: keyof DB[TTable]['columns'] & string) => Promise<any>
  min: (column: keyof DB[TTable]['columns'] & string) => Promise<any>
  // Type-only convenience properties for IDE hovers; not implemented at runtime
  readonly rows: TSelected[]
  readonly row: TSelected
  values: () => Promise<any[][]>
  /** Return parameter values for debugging/tests. */
  toParams?: () => any[]
  raw: () => Promise<any[][]>
  cancel: () => void
  /** Include soft-deleted rows in results. */
  withTrashed?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Only return soft-deleted rows. */
  onlyTrashed?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Apply a named scope defined on the model. */
  scope?: (name: string, value?: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Shallow clone of this builder to branch query modifications. */
  clone?: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Enable query result caching with TTL in milliseconds (default 60000ms / 1 minute). */
  cache?: (ttlMs?: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  /** Window function helpers */
  rowNumber?: (alias?: string, partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  denseRank?: (alias?: string, partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  rank?: (alias?: string, partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
}

export type SelectQueryBuilder<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> = BaseSelectQueryBuilder<DB, TTable, TSelected, TJoined> & DynamicWhereMethods<DB, TTable, TSelected, TJoined>

export interface InsertQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  /**
   * # `values`
   *
   * Sets the row or rows to insert.
   *
   * @example
   * ```ts
   * const id = await db.insertInto('users').values({ name: 'Alice' }).execute()
   * const rows = await db.insertInto('users').values([{ name: 'A' }, { name: 'B' }]).execute()
   * ```
   */
  values: (data: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => InsertQueryBuilder<DB, TTable>
  /**
   * # `returning`
   *
   * Adds a RETURNING clause and switches to a select builder of those columns.
   *
   * @example
   * ```ts
   * const row = await db.insertInto('users').values({ name: 'Alice' }).returning('id', 'name').first()
   * const sql = db.insertInto('users').values({ name: 'A' }).returning('id').toSQL()
   * ```
   */
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  /**
   * # `toSQL`
   *
   * Returns the SQL string for the INSERT statement.
   *
   * @example
   * ```ts
   * const sql = db.insertInto('users').values({ name: 'A' }).toSQL()
   * ```
   */
  toSQL: () => string
  /**
   * # `execute`
   *
   * Executes the INSERT. Returns affected row count or inserted rows when using RETURNING.
   *
   * @example
   * ```ts
   * const count = await db.insertInto('users').values({ name: 'A' }).execute()
   * const rows = await db.insertInto('users').values({ name: 'A' }).returning('id').execute()
   * ```
   */
  execute: () => Promise<number | DB[TTable]['columns'] | DB[TTable]['columns'][]>
}

export interface UpdateQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  /**
   * # `set`
   *
   * Sets columns and values to update.
   *
   * @example
   * ```ts
   * const sql = db.updateTable('users').set({ name: 'Alice' }).where({ id: 1 }).toSQL()
   * ```
   */
  set: (values: Partial<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `where`
   *
   * Filters rows to update using a flexible expression.
   *
   * @example
   * ```ts
   * const cnt = await db.updateTable('users').set({ active: true }).where({ id: 1 }).execute()
   * ```
   */
  where: (expr: WhereExpression<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `returning`
   *
   * Adds a RETURNING clause and switches to a select builder of those columns.
   *
   * @example
   * ```ts
   * const rows = await db.updateTable('users').set({ name: 'A' }).returning('id').execute()
   * ```
   */
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  /**
   * # `toSQL`
   *
   * Returns the SQL string for the UPDATE statement.
   *
   * @example
   * ```ts
   * const sql = db.updateTable('users').set({ name: 'A' }).toSQL()
   * ```
   */
  toSQL: () => string
  /**
   * # `execute`
   *
   * Executes the UPDATE and returns the number of affected rows.
   *
   * @example
   * ```ts
   * const count = await db.updateTable('users').set({ active: true }).where({ id: 1 }).execute()
   * ```
   */
  execute: () => Promise<number>
  executeTakeFirst?: () => Promise<{ numUpdatedRows?: number }>
}

export interface DeleteQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  /**
   * # `where`
   *
   * Filters rows to delete using a flexible expression.
   *
   * @example
   * ```ts
   * const count = await db.deleteFrom('users').where({ inactive: true }).execute()
   * ```
   */
  where: (expr: WhereExpression<DB[TTable]['columns']>) => DeleteQueryBuilder<DB, TTable>
  /**
   * # `returning`
   *
   * Adds a RETURNING clause and switches to a select builder of those columns.
   *
   * @example
   * ```ts
   * const rows = await db.deleteFrom('users').where({ id: 1 }).returning('id').execute()
   * ```
   */
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  /**
   * # `toSQL`
   *
   * Returns the SQL string for the DELETE statement.
   *
   * @example
   * ```ts
   * const sql = db.deleteFrom('users').where({ id: 1 }).toSQL()
   * ```
   */
  toSQL: () => string
  /**
   * # `execute`
   *
   * Executes the DELETE and returns the number of affected rows.
   *
   * @example
   * ```ts
   * const count = await db.deleteFrom('users').where({ id: 1 }).execute()
   * ```
   */
  execute: () => Promise<number>
  executeTakeFirst?: () => Promise<{ numDeletedRows?: number }>
}

export interface TableQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  /**
   * # `insert`
   *
   * Inserts rows into the table (Laravel-style API).
   *
   * @example
   * ```ts
   * const count = await db.table('users').insert({ name: 'Alice' }).execute()
   * const rows = await db.table('users').insert([{ name: 'A' }, { name: 'B' }]).execute()
   * ```
   */
  insert: (data: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => InsertQueryBuilder<DB, TTable>
  /**
   * # `update`
   *
   * Updates rows in the table (Laravel-style API).
   *
   * @example
   * ```ts
   * const count = await db.table('users').update({ active: true }).where({ id: 1 }).execute()
   * ```
   */
  update: (values: Partial<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `delete`
   *
   * Deletes rows from the table (Laravel-style API).
   *
   * @example
   * ```ts
   * const count = await db.table('users').delete().where({ id: 1 }).execute()
   * ```
   */
  delete: () => DeleteQueryBuilder<DB, TTable>
  /**
   * # `select`
   *
   * Selects from the table (Laravel-style API).
   *
   * @example
   * ```ts
   * const rows = await db.table('users').select('id', 'name').execute()
   * ```
   */
  select: (...columns: (keyof DB[TTable]['columns'] & string)[]) => SelectQueryBuilder<DB, TTable, any>
}

export interface QueryBuilder<DB extends DatabaseSchema<any>> {
  // typed select list (column names or raw aliases)
  /**
   * # `select`
   *
   * Starts a SELECT query for a table with explicit columns or raw aliases.
   *
   * @example
   * ```ts
   * const rows = await db.select('users', 'id', 'name').get()
   * const sql = db.select('users', 'id', `count(*) as c`).toSQL()
   * ```
   */
  select: <TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string>(
    table: TTable,
    ...columns: (K | `${string} as ${string}`)[]
  ) => SelectQueryBuilder<DB, TTable, any>
  /**
   * # `selectFrom`
   *
   * Starts a SELECT * query for the given table with typed dynamic where methods.
   *
   * @example
   * ```ts
   * const rows = await db.selectFrom('users').whereId(1).get()
   * const sql = db.selectFrom('users').orderBy('id').toSQL()
   * ```
   */
  selectFrom: <TTable extends keyof DB & string>(table: TTable) => TypedSelectQueryBuilder<DB, TTable, DB[TTable]['columns'], TTable, `SELECT * FROM ${TTable}`>
  /**
   * # `insertInto`
   *
   * Starts an INSERT query for the given table.
   *
   * @example
   * ```ts
   * const id = await db.insertInto('users').values({ name: 'A' }).execute()
   * const row = await db.insertInto('users').values({ name: 'A' }).returning('id').first()
   * ```
   */
  insertInto: <TTable extends keyof DB & string>(table: TTable) => TypedInsertQueryBuilder<DB, TTable>
  /**
   * # `updateTable`
   *
   * Starts an UPDATE query for the given table.
   *
   * @example
   * ```ts
   * const count = await db.updateTable('users').set({ active: true }).where({ id: 1 }).execute()
   * ```
   */
  updateTable: <TTable extends keyof DB & string>(table: TTable) => UpdateQueryBuilder<DB, TTable>
  /**
   * # `deleteFrom`
   *
   * Starts a DELETE query for the given table.
   *
   * @example
   * ```ts
   * const count = await db.deleteFrom('users').where({ id: 1 }).execute()
   * ```
   */
  deleteFrom: <TTable extends keyof DB & string>(table: TTable) => DeleteQueryBuilder<DB, TTable>
  /**
   * # `table`
   *
   * Laravel-style table API with insert/update/delete methods.
   *
   * @example
   * ```ts
   * const count = await db.table('users').insert({ name: 'Alice' }).execute()
   * const rows = await db.table('users').insert([{ name: 'A' }, { name: 'B' }]).execute()
   * await db.table('users').update({ active: true }).where({ id: 1 }).execute()
   * await db.table('users').delete().where({ id: 1 }).execute()
   * ```
   */
  table: <TTable extends keyof DB & string>(table: TTable) => TableQueryBuilder<DB, TTable>
  /**
   * # `selectFromSub`
   *
   * Selects from a subquery with an alias.
   *
   * @example
   * ```ts
   * const sub = db.selectFrom('users').where({ active: true })
   * const sql = db.selectFromSub(sub, 'u').toSQL()
   * ```
   */
  selectFromSub: (sub: { toSQL: () => any }, alias: string) => SelectQueryBuilder<DB, keyof DB & string, any>
  /**
   * # `sql`
   *
   * Exposes the underlying Bun.sql tag for advanced usage.
   *
   * @example
   * ```ts
   * const rows = await db.sql`SELECT 1 as one`.execute()
   * ```
   */
  sql: any
  /**
   * # `raw`
   *
   * Tagged template passthrough to Bun.sql.
   *
   * @example
   * ```ts
   * const q = db.raw`SELECT ${1} as one`
   * ```
   */
  raw: (strings: TemplateStringsArray, ...values: any[]) => any
  /**
   * # `simple`
   *
   * Tagged template passthrough that returns a simple statement.
   *
   * @example
   * ```ts
   * const s = db.simple`SELECT ${1}`
   * ```
   */
  simple: (strings: TemplateStringsArray, ...values: any[]) => any
  /**
   * # `unsafe`
   *
   * Executes an unsafe raw SQL string with optional parameters.
   *
   * @example
   * ```ts
   * const rows = await db.unsafe('SELECT 1 as one')
   * ```
   */
  unsafe: (query: string, params?: any[]) => Promise<any>
  /**
   * # `file`
   *
   * Executes a SQL file with optional parameters (if supported by Bun.sql).
   *
   * @example
   * ```ts
   * const rows = await db.file('queries/users.sql')
   * ```
   */
  file: (path: string, params?: any[]) => Promise<any>
  /**
   * # `reserve`
   *
   * Reserves a connection from the pool and returns a scoped query builder.
   *
   * @example
   * ```ts
   * const reserved = await db.reserve()
   * try { await reserved.selectFrom('users').get() } finally { reserved.release() }
   * ```
   */
  reserve: () => Promise<(QueryBuilder<DB> & { release: () => void })>
  /**
   * # `close`
   *
   * Closes the underlying connection/pool.
   *
   * @example
   * ```ts
   * await db.close()
   * ```
   */
  close: (opts?: { timeout?: number }) => Promise<void>
  // Pub/Sub (stubs until Bun exposes API)
  /**
   * # `listen`
   *
   * Subscribes to a channel (placeholder until Bun exposes API).
   *
   * @example
   * ```ts
   * await db.listen('events')
   * ```
   */
  listen: (channel: string, handler?: (payload: any) => void) => Promise<void>
  /**
   * # `unlisten`
   *
   * Unsubscribes from a channel or all channels (placeholder).
   */
  unlisten: (channel?: string) => Promise<void>
  /**
   * # `notify`
   *
   * Sends a notification to a channel (placeholder).
   */
  notify: (channel: string, payload?: any) => Promise<void>
  // COPY support (stubs until available)
  /**
   * # `copyTo`
   *
   * Streams out data from a query or table (placeholder).
   */
  copyTo: (queryOrTable: string, options?: Record<string, any>) => Promise<any>
  /**
   * # `copyFrom`
   *
   * Streams data into a table (placeholder).
   */
  copyFrom: (queryOrTable: string, source: AsyncIterable<any> | Iterable<any>, options?: Record<string, any>) => Promise<any>
  // Pool readiness
  /**
   * # `ping`
   *
   * Executes a lightweight query to confirm connectivity.
   */
  ping: () => Promise<boolean>
  /**
   * # `waitForReady`
   *
   * Repeatedly pings until ready or attempts exhausted.
   */
  waitForReady: (opts?: { attempts?: number, delayMs?: number }) => Promise<void>
  /**
   * # `transaction`
   *
   * Runs the provided function within a transaction with retry options.
   *
   * @example
   * ```ts
   * const res = await db.transaction(async tx => {
   *   await tx.insertInto('users').values({ name: 'A' }).execute()
   *   return 'ok'
   * })
   * ```
   */
  transaction: <T>(fn: (tx: QueryBuilder<DB>) => Promise<T> | T, options?: TransactionOptions) => Promise<T>
  /**
   * # `savepoint`
   *
   * Executes the provided function inside a database savepoint.
   */
  savepoint: <T>(fn: (sp: QueryBuilder<DB>) => Promise<T> | T) => Promise<T>
  /**
   * # `beginDistributed` / `commitDistributed` / `rollbackDistributed`
   *
   * Distributed transaction primitives (if supported by Bun.sql).
   */
  beginDistributed: <T>(name: string, fn: (tx: QueryBuilder<DB>) => Promise<T> | T) => Promise<T>
  commitDistributed: (name: string) => Promise<void>
  rollbackDistributed: (name: string) => Promise<void>
  /**
   * # `configure`
   *
   * Applies runtime configuration overrides to this builder instance.
   */
  configure: (opts: Partial<typeof config>) => QueryBuilder<DB>
  /**
   * # `setTransactionDefaults`
   *
   * Sets default transaction options for this builder instance.
   */
  setTransactionDefaults: (defaults: TransactionOptions) => void
  /**
   * # `transactional`
   *
   * Wraps a function so it runs inside a new transaction when called.
   */
  transactional: <TArgs extends any[], R>(fn: (tx: QueryBuilder<DB>, ...args: TArgs) => Promise<R> | R, options?: TransactionOptions) => (...args: TArgs) => Promise<R>
  // aggregates
  count: <TTable extends keyof DB & string>(table: TTable, column?: keyof DB[TTable]['columns'] & string) => Promise<number>
  sum: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<number>
  avg: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<number>
  min: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<any>
  max: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<any>
  // dml helpers
  insertOrIgnore: <TTable extends keyof DB & string>(table: TTable, values: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => Promise<any>
  insertGetId: <TTable extends keyof DB & string>(table: TTable, values: Partial<DB[TTable]['columns']>, idColumn?: keyof DB[TTable]['columns'] & string) => Promise<any>
  updateOrInsert: <TTable extends keyof DB & string>(table: TTable, match: Partial<DB[TTable]['columns']>, values: Partial<DB[TTable]['columns']>) => Promise<boolean>
  upsert: <TTable extends keyof DB & string>(table: TTable, rows: Partial<DB[TTable]['columns']>[], conflictColumns: (keyof DB[TTable]['columns'] & string)[], mergeColumns?: (keyof DB[TTable]['columns'] & string)[]) => Promise<any>

  /**
   * # `create(table, values)`
   *
   * Inserts a row and returns the created record.
   */
  create: <TTable extends keyof DB & string>(
    table: TTable,
    values: Partial<DB[TTable]['columns']>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `createMany(table, rows)`
   *
   * Inserts multiple rows. Returns void.
   */
  createMany: <TTable extends keyof DB & string>(
    table: TTable,
    rows: Partial<DB[TTable]['columns']>[],
  ) => Promise<void>

  /**
   * # `insertMany(table, rows)`
   *
   * Alias for createMany. Inserts multiple rows. Returns void.
   */
  insertMany: <TTable extends keyof DB & string>(
    table: TTable,
    rows: Partial<DB[TTable]['columns']>[],
  ) => Promise<void>

  /**
   * # `updateMany(table, conditions, data)`
   *
   * Updates multiple rows matching conditions. Returns count of affected rows.
   */
  updateMany: <TTable extends keyof DB & string>(
    table: TTable,
    conditions: WhereExpression<DB[TTable]['columns']>,
    data: Partial<DB[TTable]['columns']>,
  ) => Promise<number>

  /**
   * # `deleteMany(table, ids)`
   *
   * Deletes multiple rows by IDs. Returns count of deleted rows.
   */
  deleteMany: <TTable extends keyof DB & string>(
    table: TTable,
    ids: any[],
  ) => Promise<number>

  /**
   * # `firstOrCreate(table, match, [defaults])`
   *
   * Returns the first matching row, or creates one with defaults merged and returns it.
   */
  firstOrCreate: <TTable extends keyof DB & string>(
    table: TTable,
    match: Partial<DB[TTable]['columns']>,
    defaults?: Partial<DB[TTable]['columns']>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `updateOrCreate(table, match, values)`
   *
   * Updates the first matching row with values or creates a new one if none exists, then returns it.
   */
  updateOrCreate: <TTable extends keyof DB & string>(
    table: TTable,
    match: Partial<DB[TTable]['columns']>,
    values: Partial<DB[TTable]['columns']>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `save(table, values)`
   * If values contain the primary key and a row exists, updates it; otherwise creates a new row. Returns the row.
   */
  save: <TTable extends keyof DB & string>(
    table: TTable,
    values: Partial<DB[TTable]['columns']>,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `remove(table, id)`
   * Deletes by primary key and returns adapter's first result object.
   */
  remove: <TTable extends keyof DB & string>(
    table: TTable,
    id: DB[TTable]['columns'][DB[TTable]['primaryKey'] & keyof DB[TTable]['columns']] | any,
  ) => Promise<any>

  /**
   * # `find(table, id)`
   * Fetch by primary key. Returns the row or undefined.
   */
  find: <TTable extends keyof DB & string>(
    table: TTable,
    id: DB[TTable]['columns'][DB[TTable]['primaryKey'] & keyof DB[TTable]['columns']] | any,
  ) => Promise<DB[TTable]['columns'] | undefined>

  /**
   * # `findOrFail(table, id)`
   * Fetch by primary key or throw if not found.
   */
  findOrFail: <TTable extends keyof DB & string>(
    table: TTable,
    id: DB[TTable]['columns'][DB[TTable]['primaryKey'] & keyof DB[TTable]['columns']] | any,
  ) => Promise<DB[TTable]['columns']>

  /**
   * # `findMany(table, ids)`
   * Fetch many by primary keys.
   */
  findMany: <TTable extends keyof DB & string>(
    table: TTable,
    ids: any[],
  ) => Promise<DB[TTable]['columns'][]>

  /**
   * # `latest(table, column?)`
   * Returns latest row by column or default timestamp column.
   */
  latest: <TTable extends keyof DB & string>(
    table: TTable,
    column?: keyof DB[TTable]['columns'] & string,
  ) => Promise<DB[TTable]['columns'] | undefined>

  /**
   * # `oldest(table, column?)`
   * Returns oldest row by column or default timestamp column.
   */
  oldest: <TTable extends keyof DB & string>(
    table: TTable,
    column?: keyof DB[TTable]['columns'] & string,
  ) => Promise<DB[TTable]['columns'] | undefined>

  /**
   * # `skip(table, count)`
   * Returns a builder with an offset applied.
   */
  skip: <TTable extends keyof DB & string>(
    table: TTable,
    count: number,
  ) => SelectQueryBuilder<DB, TTable, DB[TTable]['columns'], TTable>

  /**
   * # `rawQuery(sql)`
   * Execute a raw SQL string (single statement) with no parameters.
   */
  rawQuery: (query: string) => Promise<any>
  /** Safely wrap/validate an identifier for raw fragments. */
  id?: (name: string) => any
  /** Safely wrap/validate multiple identifiers. */
  ids?: (...names: string[]) => any
  /** Take an advisory lock (PostgreSQL only). */
  advisoryLock?: (key: number | string) => Promise<void>
  /** Try to take an advisory lock and return false if unavailable (PostgreSQL only). */
  tryAdvisoryLock?: (key: number | string) => Promise<boolean>
  /** Get all relationships defined for a table. */
  getRelationships?: (table: string) => Record<string, any>
  /** Check if a table has a specific relationship. */
  hasRelationship?: (table: string, relationName: string) => boolean
  /** Get the type of a relationship (hasMany, belongsTo, etc.). */
  getRelationshipType?: (table: string, relationName: string) => string | null
  /** Get the target model/table of a relationship. */
  getRelationshipTarget?: (table: string, relationName: string) => string | null
}

// Typed INSERT builder to expose a structured SQL literal in hovers
export type TypedInsertQueryBuilder<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSql extends string = `INSERT INTO ${TTable}`,
> = Omit<InsertQueryBuilder<DB, TTable>, 'toSQL' | 'values' | 'returning'> & {
  toSQL: () => TSql
  values: (
    data: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[],
  ) => TypedInsertQueryBuilder<DB, TTable, `${TSql} ${string}`>
  returning: <K extends keyof DB[TTable]['columns'] & string>(
    ...cols: K[]
  ) => TypedSelectQueryBuilder<
    DB,
    TTable,
    Pick<DB[TTable]['columns'], K>,
    TTable,
    `${TSql} RETURNING ${string}`
  >
}

interface InternalState {
  sql: any
  meta?: SchemaMeta
  schema?: any
  txDefaults?: TransactionOptions
}

// applyCondition and applyWhere moved inside createQueryBuilder to use the correct SQL instance

function isRetriableTxError(err: any): boolean {
  const msg = String(err?.message || '').toLowerCase()
  return (
    msg.includes('deadlock')
    || msg.includes('serialization failure')
    || msg.includes('could not serialize access')
    || msg.includes('deadlock found when trying to get lock') // MySQL
    || msg.includes('lock wait timeout exceeded') // MySQL
    || msg.includes('database is locked') // SQLite
    || msg.includes('busy') // SQLite BUSY
  )
}

type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable'
interface TxBackoff { baseMs?: number, maxMs?: number, factor?: number, jitter?: boolean }
interface TxLoggerEvent { type: 'start' | 'retry' | 'commit' | 'rollback' | 'error', attempt: number, error?: any, durationMs?: number }
export interface TransactionOptions {
  retries?: number
  isolation?: TransactionIsolation
  onRetry?: (attempt: number, error: any) => void
  afterCommit?: () => void
  sqlStates?: string[]
  backoff?: TxBackoff
  logger?: (event: TxLoggerEvent) => void
  /** When true, executes transaction in read-only mode (where supported). */
  readOnly?: boolean
  /** Called when a transaction is rolled back. */
  onRollback?: (error: any) => void
  /** Called after rollback completes. */
  afterRollback?: () => void
}

function matchesSqlState(err: any, states?: string[]): boolean {
  if (!states || states.length === 0)
    return false
  const code = (err && (err.code || err.sqlState || err.sqlstate)) as string | undefined
  if (!code)
    return false
  return states.includes(code)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function computeBackoffMs(attempt: number, cfg?: TxBackoff): number {
  const base = Math.max(1, cfg?.baseMs ?? 50)
  const factor = Math.max(1, cfg?.factor ?? 2)
  const max = Math.max(base, cfg?.maxMs ?? 2000)
  let ms = Math.min(max, base * (factor ** Math.max(0, attempt - 1)))
  if (cfg?.jitter) {
    const jitter = Math.random() * ms * 0.2
    ms = ms - jitter / 2
  }
  return Math.floor(ms)
}

export function createQueryBuilder<DB extends DatabaseSchema<any>>(state?: Partial<InternalState>): QueryBuilder<DB> {
  const _sql = state?.sql ?? getOrCreateBunSql()
  const meta = state?.meta
  const schema = state?.schema

  function applyCondition(expr: WhereExpression<any>): any {
    // Returns just the condition part without WHERE keyword
    // Avoid using _sql(column) as it creates "helpers" that Bun restricts
    if (Array.isArray(expr)) {
      const [col, op, val] = expr
      const colName = String(col)
      switch (op) {
        case 'in':
          if (Array.isArray(val)) {
            const placeholders = val.map((_, i) => `$${i + 1}`).join(', ')
            return (_sql as any).unsafe(`${colName} IN (${placeholders})`, val)
          }
          return (_sql as any).unsafe(`${colName} IN ($1)`, [val])
        case 'not in':
          if (Array.isArray(val)) {
            const placeholders = val.map((_, i) => `$${i + 1}`).join(', ')
            return (_sql as any).unsafe(`${colName} NOT IN (${placeholders})`, val)
          }
          return (_sql as any).unsafe(`${colName} NOT IN ($1)`, [val])
        case 'like':
          return (_sql as any).unsafe(`${colName} LIKE $1`, [val])
        case 'is':
          return (_sql as any).unsafe(`${colName} IS ${val}`)
        case 'is not':
          return (_sql as any).unsafe(`${colName} IS NOT ${val}`)
        case '!=':
          return (_sql as any).unsafe(`${colName} <> $1`, [val])
        case '<':
        case '>':
        case '<=':
        case '>=':
        case '=':
        default:
          return (_sql as any).unsafe(`${colName} ${op} $1`, [val])
      }
    }
    if ('raw' in (expr as any)) {
      return (expr as WhereRaw).raw
    }
    // Object notation: {name: 'Alice', age: 25}
    const keys = Object.keys(expr)
    if (keys.length === 0)
      return (_sql as any).unsafe('')

    const conditions: string[] = []
    const allParams: any[] = []
    let paramIndex = 1

    for (const key of keys) {
      const value = (expr as any)[key]
      if (Array.isArray(value)) {
        const placeholders = value.map(() => `$${paramIndex++}`).join(', ')
        conditions.push(`${key} IN (${placeholders})`)
        allParams.push(...value)
      }
      else {
        conditions.push(`${key} = $${paramIndex++}`)
        allParams.push(value)
      }
    }

    return (_sql as any).unsafe(conditions.join(' AND '), allParams)
  }

  function applyWhere(columns: Record<string, unknown>, q: any, expr?: WhereExpression<any>) {
    if (!expr)
      return q
    const condition = applyCondition(expr)
    return _sql`${q} WHERE ${condition}`
  }

  function computeSqlText(q: any): string {
    const prev = config.debug?.captureText
    if (config.debug)
      config.debug.captureText = true
    const s = String(q)
    if (config.debug)
      config.debug.captureText = prev as boolean
    return s
  }

  function runWithHooks<T = any>(q: any, kind: 'select' | 'insert' | 'update' | 'delete' | 'raw', opts?: { signal?: AbortSignal, timeoutMs?: number }): Promise<T> {
    const hooks = config.hooks
    const hasHooks = hooks && (hooks.onQueryStart || hooks.onQueryEnd || hooks.onQueryError || hooks.startSpan)
    const hasTimeoutOrSignal = (opts?.timeoutMs && opts.timeoutMs > 0) || opts?.signal

    // Fast path: no hooks, no timeout, no signal - direct execute
    if (!hasHooks && !hasTimeoutOrSignal) {
      return (q as any).execute()
    }

    const text = computeSqlText(q)
    const startAt = Date.now()
    let span: { end: (error?: any) => void } | undefined

    try {
      hooks?.onQueryStart?.({ sql: text, kind })
      if (hooks?.startSpan)
        span = hooks.startSpan({ sql: text, kind })
    }
    catch {}

    let finished = false
    const finish = (err?: any, rowCount?: number) => {
      if (finished)
        return
      finished = true
      const durationMs = Date.now() - startAt
      try {
        if (err) {
          hooks?.onQueryError?.({ sql: text, error: err, durationMs, kind })
        }
        else {
          hooks?.onQueryEnd?.({ sql: text, durationMs, rowCount, kind })
        }
      }
      catch {}
      try {
        span?.end(err)
      }
      catch {}
    }

    const execPromise = (q as any).execute()

    // Handle timeout/abort by canceling the query if driver supports it
    const promises: Promise<any>[] = [execPromise]
    let timeoutId: any
    if (opts?.timeoutMs && opts.timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          try {
            (q as any).cancel?.()
          }
          catch {}
          const err = new Error(`Query timed out after ${opts.timeoutMs}ms`)
          ;(err as any).code = 'EBQBTIMEOUT'
          reject(err)
        }, opts.timeoutMs)
      })
      promises.push(timeoutPromise)
    }
    if (opts?.signal) {
      if (opts.signal.aborted) {
        try {
          (q as any).cancel?.()
        }
        catch {}
        const err = new Error('Query aborted')
          ;(err as any).code = 'EBQBABORT'
        finish(err)
        return Promise.reject(err)
      }
      const abortHandler = () => {
        try {
          (q as any).cancel?.()
        }
        catch {}
      }
      opts.signal.addEventListener('abort', abortHandler, { once: true })
      execPromise.finally(() => {
        opts.signal?.removeEventListener('abort', abortHandler)
      })
    }

    return Promise.race(promises)
      .then((rows) => {
        clearTimeout(timeoutId)
        const rc = Array.isArray(rows) ? rows.length : (typeof rows === 'number' ? rows : undefined)
        finish(undefined, rc)
        return rows
      })
      .catch((err) => {
        clearTimeout(timeoutId)
        finish(err)
        throw err
      })
  }

  function makeExecutableQuery(q: any, text?: string) {
    const sqlText = text ?? computeSqlText(q)
    return {
      sql: sqlText,
      toString: () => sqlText,
      execute: () => (q as any).execute(),
      values: () => (q as any).values(),
      raw: () => (q as any).raw(),
    }
  }

  function makeSelect<TTable extends keyof DB & string>(table: TTable): TypedSelectQueryBuilder<DB, TTable, any, TTable, `SELECT * FROM ${TTable}`>
  function makeSelect<TTable extends keyof DB & string>(table: TTable, columns: string[]): TypedSelectQueryBuilder<DB, TTable, any, TTable, `SELECT ${string} FROM ${TTable}`>
  function makeSelect<TTable extends keyof DB & string>(table: TTable, columns?: string[]): any {
    // Use the sql instance from state (allows tests to inject mockSql)
    const sql = _sql
    // Build query using unsafe for better performance
    let text = (columns && columns.length > 0)
      ? `SELECT ${columns.join(', ')} FROM ${String(table)}`
      : `SELECT * FROM ${String(table)}`

    // Lazy building: don't prepare statement until execution
    let built: any = (columns && columns.length > 0)
      ? sql`SELECT ${sql(columns.join(', '))} FROM ${sql(table)}`
      : sql`SELECT * FROM ${sql(table)}`

    const addWhereText = (prefix: 'WHERE' | 'AND' | 'OR', clause: string) => {
      const hasWhere = SQL_PATTERNS.WHERE.test(text)
      const p = hasWhere ? prefix : 'WHERE'
      text = `${text} ${p} ${clause}`
    }

    const joinedTables = new Set<string>()
    let timeoutMs: number | undefined
    let abortSignal: AbortSignal | undefined
    let includeTrashed = false
    let onlyTrashed = false
    let useCache = false
    const pivotColumns = new Map<string, string[]>() // Store pivot columns per relationship
    let cacheTtl = 60000

    // Track WHERE conditions and parameters for proper merging
    const whereConditions: string[] = []
    const whereParams: unknown[] = []

    // Helper function to validate SQL identifiers with context
    const validateIdentifier = (name: string, context?: string): void => {
      if (!SQL_PATTERNS.IDENTIFIER.test(name)) {
        const contextMsg = context ? ` in ${context}` : ''
        throw new Error(`[query-builder] Invalid identifier${contextMsg}: '${name}'. Identifiers must start with a letter or underscore and contain only alphanumeric characters, underscores, and dots.`)
      }
    }

    // Helper function to add columns to the SELECT clause
    const addToSelectClause = (columnsToAdd: string): void => {
      // Update text representation for toSQL()
      if (SQL_PATTERNS.SELECT_STAR.test(text)) {
        text = text.replace(SQL_PATTERNS.SELECT_STAR, `SELECT *, ${columnsToAdd}`)
      }
      else if (SQL_PATTERNS.SELECT.test(text)) {
        text = text.replace(SQL_PATTERNS.SELECT_FROM, `SELECT $1, ${columnsToAdd} FROM`)
      }

      // Update built query
      const currentSelect = String(built)
      if (SQL_PATTERNS.SELECT_STAR.test(currentSelect)) {
        const newSql = currentSelect.replace(SQL_PATTERNS.SELECT_STAR, `SELECT *, ${columnsToAdd}`)
        built = (_sql as any).unsafe(newSql)
      }
      else if (SQL_PATTERNS.SELECT.test(currentSelect)) {
        const selectPart = SQL_PATTERNS.SELECT_FROM.exec(currentSelect)
        if (selectPart) {
          const newSql = currentSelect.replace(SQL_PATTERNS.SELECT_FROM, `SELECT $1, ${columnsToAdd} FROM`)
          built = (_sql as any).unsafe(newSql)
        }
      }
    }

    // Helper function to build hasOne/hasMany subquery with validation
    const buildHasSubquery = (parentTable: string, targetTable: string, pk: string, callback?: (qb: any) => any): string => {
      validateIdentifier(parentTable, 'relationship subquery (parent table)')
      validateIdentifier(targetTable, 'relationship subquery (target table)')
      validateIdentifier(pk, 'relationship subquery (primary key)')

      const fk = `${parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable}_id`
      validateIdentifier(fk, 'relationship subquery (foreign key)')

      let subquerySQL = `SELECT 1 FROM ${targetTable} WHERE ${targetTable}.${fk} = ${parentTable}.${pk}`

      if (callback) {
        const subQb = {
          where: (col: string, op: string, val: any) => {
            validateIdentifier(col, 'relationship subquery condition')
            return `${targetTable}.${col} ${op} ${typeof val === 'string' ? `'${val}'` : val}`
          },
        }
        const condition = callback(subQb)
        if (condition) {
          subquerySQL += ` AND ${condition}`
        }
      }

      return subquerySQL
    }

    // Helper function to build belongsTo subquery with validation
    const buildBelongsToSubquery = (parentTable: string, targetTable: string, pk: string, callback?: (qb: any) => any): string => {
      validateIdentifier(parentTable, 'relationship subquery (parent table)')
      validateIdentifier(targetTable, 'relationship subquery (target table)')
      validateIdentifier(pk, 'relationship subquery (primary key)')

      const fk = `${targetTable.endsWith('s') ? targetTable.slice(0, -1) : targetTable}_id`
      validateIdentifier(fk, 'relationship subquery (foreign key)')

      let subquerySQL = `SELECT 1 FROM ${targetTable} WHERE ${targetTable}.${pk} = ${parentTable}.${fk}`

      if (callback) {
        const subQb = {
          where: (col: string, op: string, val: any) => {
            validateIdentifier(col, 'relationship subquery condition')
            return `${targetTable}.${col} ${op} ${typeof val === 'string' ? `'${val}'` : val}`
          },
        }
        const condition = callback(subQb)
        if (condition) {
          subquerySQL += ` AND ${condition}`
        }
      }

      return subquerySQL
    }

    // Helper function to build belongsToMany subquery with validation
    const buildBelongsToManySubquery = (parentTable: string, targetTable: string, pk: string, targetPk: string, callback?: (qb: any) => any): string => {
      validateIdentifier(parentTable, 'relationship subquery (parent table)')
      validateIdentifier(targetTable, 'relationship subquery (target table)')
      validateIdentifier(pk, 'relationship subquery (primary key)')
      validateIdentifier(targetPk, 'relationship subquery (target primary key)')

      const a = parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable
      const b = targetTable.endsWith('s') ? targetTable.slice(0, -1) : targetTable
      const pivot = [a, b].sort().join('_')
      const fkA = `${a}_id`
      const fkB = `${b}_id`

      validateIdentifier(pivot, 'relationship subquery (pivot table)')
      validateIdentifier(fkA, 'relationship subquery (foreign key A)')
      validateIdentifier(fkB, 'relationship subquery (foreign key B)')

      let subquerySQL = `SELECT 1 FROM ${pivot} JOIN ${targetTable} ON ${targetTable}.${targetPk} = ${pivot}.${fkB} WHERE ${pivot}.${fkA} = ${parentTable}.${pk}`

      if (callback) {
        const subQb = {
          where: (col: string, op: string, val: any) => {
            validateIdentifier(col, 'relationship subquery condition')
            return `${targetTable}.${col} ${op} ${typeof val === 'string' ? `'${val}'` : val}`
          },
        }
        const condition = callback(subQb)
        if (condition) {
          subquerySQL += ` AND ${condition}`
        }
      }

      return subquerySQL
    }

    // Helper function to build count subquery for hasOne/hasMany with validation
    const buildHasCountSubquery = (parentTable: string, targetTable: string, pk: string): string => {
      validateIdentifier(parentTable, 'withCount (parent table)')
      validateIdentifier(targetTable, 'withCount (target table)')
      validateIdentifier(pk, 'withCount (primary key)')

      const fk = `${parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable}_id`
      validateIdentifier(fk, 'withCount (foreign key)')

      return `(SELECT COUNT(*) FROM ${targetTable} WHERE ${targetTable}.${fk} = ${parentTable}.${pk})`
    }

    // Helper function to build count subquery for belongsToMany with validation
    const buildBelongsToManyCountSubquery = (parentTable: string, targetTable: string, pk: string): string => {
      validateIdentifier(parentTable, 'withCount (parent table)')
      validateIdentifier(targetTable, 'withCount (target table)')
      validateIdentifier(pk, 'withCount (primary key)')

      const a = parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable
      const b = targetTable.endsWith('s') ? targetTable.slice(0, -1) : targetTable
      const pivot = [a, b].sort().join('_')
      const fkA = `${a}_id`

      validateIdentifier(pivot, 'withCount (pivot table)')
      validateIdentifier(fkA, 'withCount (foreign key)')

      return `(SELECT COUNT(*) FROM ${pivot} WHERE ${pivot}.${fkA} = ${parentTable}.${pk})`
    }

    // Helper function to apply pivot columns to the query
    const applyPivotColumnsToQuery = () => {
      if (pivotColumns.size === 0)
        return

      const allPivotColumns: string[] = []

      for (const [relation, columns] of pivotColumns.entries()) {
        const parentTable = String(table)
        const rels = meta?.relations?.[parentTable]
        if (!rels)
          continue

        const targetModel = rels.belongsToMany?.[relation]
        if (!targetModel)
          continue

        const targetTable = meta.modelToTable[targetModel] || targetModel
        const a = parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable
        const b = targetTable.endsWith('s') ? targetTable.slice(0, -1) : targetTable
        const pivot = [a, b].sort().join('_')

        // Validate each column name to prevent SQL injection
        for (const col of columns) {
          validateIdentifier(col, 'withPivot')
        }

        const pivotColumnsStr = columns.map(col => `${pivot}.${col} AS pivot_${col}`)
        allPivotColumns.push(...pivotColumnsStr)
      }

      if (allPivotColumns.length > 0) {
        const pivotColumnsStr = allPivotColumns.join(', ')
        addToSelectClause(pivotColumnsStr)
      }
    }

    // Build the base API; then wrap with a proxy that exposes dynamic where/orWhere/andWhere methods

    const base: BaseSelectQueryBuilder<DB, TTable, any, TTable> = {
      distinct() {
        const rest = String(built).replace(SQL_PATTERNS.SELECT, '')
        built = sql`SELECT DISTINCT ${sql``}${sql(rest)}`
        return this as any
      },
      distinctOn(...columns: any[]) {
        const match = SQL_PATTERNS.SELECT_FROM.exec(String(built))
        const body = match ? `${match[1]} FROM` : String(built)
        built = sql`SELECT DISTINCT ON (${sql(columns as any)}) ${sql``}${sql(body)}`
        return this as any
      },
      selectRaw(fragment: any) {
        built = sql`${built} , ${fragment}`
        return this as any
      },
      rowNumber(alias = 'row_number', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const parts: any[] = []
        if (partitionBy) {
          const cols = Array.isArray(partitionBy) ? partitionBy : [partitionBy]
          parts.push(sql`PARTITION BY ${sql(cols as any)}`)
        }
        if (orderBy && orderBy.length) {
          const ob = orderBy.map(([c, d]) => sql`${sql(c)} ${d === 'desc' ? sql`DESC` : sql`ASC`}`)
          const expr = ob.reduce((acc, p, i) => (i === 0 ? p : sql`${acc}, ${p}`))
          parts.push(sql`ORDER BY ${expr}`)
        }
        const over = parts.length ? sql`OVER (${sql(parts as any)})` : sql`OVER ()`
        built = sql`${built} , ROW_NUMBER() ${over} AS ${sql(alias)}`
        return this as any
      },
      denseRank(alias = 'dense_rank', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const cols = Array.isArray(partitionBy) ? partitionBy : (partitionBy ? [partitionBy] : [])
        const parts: any[] = []
        if (cols.length)
          parts.push(sql`PARTITION BY ${sql(cols as any)}`)
        if (orderBy && orderBy.length) {
          const ob = orderBy.map(([c, d]) => sql`${sql(c)} ${d === 'desc' ? sql`DESC` : sql`ASC`}`)
          const expr = ob.reduce((acc, p, i) => (i === 0 ? p : sql`${acc}, ${p}`))
          parts.push(sql`ORDER BY ${expr}`)
        }
        const over = parts.length ? sql`OVER (${sql(parts as any)})` : sql`OVER ()`
        built = sql`${built} , DENSE_RANK() ${over} AS ${sql(alias)}`
        return this as any
      },
      rank(alias = 'rank', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const cols = Array.isArray(partitionBy) ? partitionBy : (partitionBy ? [partitionBy] : [])
        const parts: any[] = []
        if (cols.length)
          parts.push(sql`PARTITION BY ${sql(cols as any)}`)
        if (orderBy && orderBy.length) {
          const ob = orderBy.map(([c, d]) => sql`${sql(c)} ${d === 'desc' ? sql`DESC` : sql`ASC`}`)
          const expr = ob.reduce((acc, p, i) => (i === 0 ? p : sql`${acc}, ${p}`))
          parts.push(sql`ORDER BY ${expr}`)
        }
        const over = parts.length ? sql`OVER (${sql(parts as any)})` : sql`OVER ()`
        built = sql`${built} , RANK() ${over} AS ${sql(alias)}`
        return this as any
      },
      selectAll() {
        return this as any
      },
      select(columns: string[]) {
        if (!columns || columns.length === 0)
          return this as any
        // Replace SELECT * with SELECT specific columns, preserving FROM and JOINs
        const fromIndex = text.indexOf(' FROM ')
        if (fromIndex !== -1) {
          text = `SELECT ${columns.join(', ')}${text.substring(fromIndex)}`
        }
        else {
          text = `SELECT ${columns.join(', ')} FROM ${table}`
        }
        return this as any
      },
      addSelect(...columns: string[]) {
        if (!columns.length)
          return this as any
        // inject additional columns into SELECT list
        const body = String(built).replace(SQL_PATTERNS.SELECT, '')
        built = sql`SELECT ${sql(columns as any)} , ${sql(body)} `
        return this as any
      },
      with(...relations: (string | Record<string, (qb: any) => any> | ((qb: any) => any))[]) {
        // Null safety and validation
        if (!meta || !relations || relations.length === 0)
          return this as any

        // Filter out null/undefined/invalid values and normalize to array of objects
        const normalizedRelations: Array<{ name: string, callback?: (qb: any) => any }> = []

        for (const rel of relations) {
          if (!rel)
            continue

          if (typeof rel === 'string') {
            normalizedRelations.push({ name: rel })
          }
          else if (typeof rel === 'object' && !Array.isArray(rel)) {
            // Object notation: { posts: (qb) => qb.where(...) }
            for (const [name, callback] of Object.entries(rel)) {
              if (typeof callback === 'function') {
                normalizedRelations.push({ name, callback })
              }
              else {
                normalizedRelations.push({ name })
              }
            }
          }
        }

        if (normalizedRelations.length === 0)
          return this as any

        // Check max eager load limit
        const maxEagerLoad = config.relations.maxEagerLoad ?? 50
        if (normalizedRelations.length > maxEagerLoad) {
          throw new Error(`[query-builder] Too many relationships to eager load (${normalizedRelations.length}). Maximum allowed: ${maxEagerLoad}`)
        }

        const parentTable = String(table)
        const visitedTables = new Set<string>() // For cycle detection
        const loadedRelationships = new Set<string>() // Track loaded relationships
        const relationConditions = new Map<string, (qb: any) => any>() // Store conditions per relation

        const singularize = (name: string) => {
          if (config.relations.singularizeStrategy === 'none')
            return name
          return name.endsWith('s') ? name.slice(0, -1) : name
        }

        const getAvailableRelations = (fromTable: string): string[] => {
          const rels = meta.relations?.[fromTable]
          if (!rels)
            return []
          return [
            ...Object.keys(rels.hasOne || {}),
            ...Object.keys(rels.hasMany || {}),
            ...Object.keys(rels.belongsTo || {}),
            ...Object.keys(rels.belongsToMany || {}),
            ...Object.keys(rels.hasOneThrough || {}),
            ...Object.keys(rels.hasManyThrough || {}),
            ...Object.keys(rels.morphOne || {}),
            ...Object.keys(rels.morphMany || {}),
            ...Object.keys(rels.morphToMany || {}),
            ...Object.keys(rels.morphedByMany || {}),
          ]
        }

        const addJoin = (fromTable: string, relationKey: string, depth: number = 0, condition?: (qb: any) => any) => {
          // Check max depth
          const maxDepth = config.relations.maxDepth ?? 10
          if (depth >= maxDepth) {
            throw new Error(`[query-builder] Maximum relationship depth (${maxDepth}) exceeded at '${relationKey}'. Consider using separate queries or increasing maxDepth.`)
          }

          const rels = meta.relations?.[fromTable]

          // If no relationships defined for this table, return early
          if (!rels) {
            return fromTable
          }

          // Helper to build conditional JOIN clause
          const _buildConditionalJoin = (baseJoinCondition: string, targetTable: string): string => {
            let joinCondition = baseJoinCondition

            // Add soft delete filter if enabled
            if (config.softDeletes?.enabled && config.softDeletes?.defaultFilter) {
              const softDeleteColumn = config.softDeletes.column || 'deleted_at'
              joinCondition = `${joinCondition} AND ${targetTable}.${softDeleteColumn} IS NULL`
            }

            if (!condition)
              return joinCondition

            // Create a simple query builder for the condition
            const conditionBuilder = {
              where: (col: string, op: string, val: any) => {
                const valStr = typeof val === 'string' ? `'${val}'` : String(val)
                return `${targetTable}.${col} ${op} ${valStr}`
              },
            }

            try {
              const additionalCondition = condition(conditionBuilder)
              if (additionalCondition && typeof additionalCondition === 'string') {
                return `${joinCondition} AND ${additionalCondition}`
              }
            }
            catch {
              // If condition fails, just use base condition
            }

            return joinCondition
          }

          // Helper to add soft delete check to JOIN
          const addSoftDeleteCheck = (table: string): string => {
            if (config.softDeletes?.enabled && config.softDeletes?.defaultFilter) {
              const softDeleteColumn = config.softDeletes.column || 'deleted_at'
              return ` AND ${table}.${softDeleteColumn} IS NULL`
            }
            return ''
          }

          const resolveTarget = (): string | undefined => {
            const pick = (m?: Record<string, string>) => {
              const modelName = m?.[relationKey]
              return modelName ? meta.modelToTable[modelName] : undefined
            }
            const pickThrough = (m?: Record<string, { through: string, target: string }>) => {
              const rel = m?.[relationKey]
              return rel?.target ? meta.modelToTable[rel.target] : undefined
            }
            return pick(rels?.hasOne) || pick(rels?.hasMany) || pick(rels?.belongsTo) || pick(rels?.belongsToMany) || pickThrough(rels?.hasOneThrough) || pickThrough(rels?.hasManyThrough) || pick(rels?.morphOne) || pick(rels?.morphMany) || pick(rels?.morphToMany) || pick(rels?.morphedByMany)
          }

          // Resolve target table with fallback logic
          const targetTable = resolveTarget() ?? (meta.modelToTable[relationKey] || meta.tableToModel[relationKey] ? (meta.modelToTable[relationKey] ?? relationKey) : relationKey)
          const childTable = String(targetTable)

          // Validate relationship exists (only throw error if it's truly invalid)
          if (!targetTable || (!resolveTarget() && !meta.modelToTable[relationKey] && !meta.tableToModel[relationKey])) {
            const available = getAvailableRelations(fromTable)
            if (available.length > 0 && !available.includes(relationKey)) {
              const suggestion = ` Available relationships: ${available.join(', ')}`
              throw new Error(`[query-builder] Relationship '${relationKey}' not found on table '${fromTable}'.${suggestion}`)
            }
          }

          // Cycle detection
          if (config.relations.detectCycles !== false) {
            const cycleKey = `${fromTable}->${childTable}`
            if (visitedTables.has(cycleKey)) {
              throw new Error(`[query-builder] Circular relationship detected: ${cycleKey}. This would cause an infinite loop.`)
            }
            visitedTables.add(cycleKey)
          }

          if (!childTable || childTable === fromTable)
            return fromTable

          // hasOneThrough / hasManyThrough: access through intermediate table
          const throughRel = rels?.hasOneThrough?.[relationKey] || rels?.hasManyThrough?.[relationKey]
          if (throughRel) {
            const throughModel = throughRel.through
            const targetModel = throughRel.target
            const throughTable = meta.modelToTable[throughModel] || throughModel
            const finalTable = meta.modelToTable[targetModel] || targetModel
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const throughPk = meta.primaryKeys[throughTable] ?? 'id'
            const fkInThrough = `${singularize(fromTable)}_id`
            const fkInFinal = `${singularize(throughTable)}_id`
            built = sql`${built} LEFT JOIN ${sql(throughTable)} ON ${sql(`${throughTable}.${fkInThrough}`)} = ${sql(`${fromTable}.${fromPk}`)} LEFT JOIN ${sql(finalTable)} ON ${sql(`${finalTable}.${fkInFinal}`)} = ${sql(`${throughTable}.${throughPk}`)}`
            joinedTables.add(throughTable)
            joinedTables.add(finalTable)
            return finalTable
          }

          // belongsToMany: join through pivot
          const isBtm = Boolean(rels?.belongsToMany?.[relationKey])
          if (isBtm) {
            const a = singularize(fromTable)
            const b = singularize(childTable)
            const pivot = [a, b].sort().join('_')
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const childPk = meta.primaryKeys[childTable] ?? 'id'
            const fkA = `${singularize(fromTable)}_id`
            const fkB = `${singularize(childTable)}_id`
            built = sql`${built} LEFT JOIN ${sql(pivot)} ON ${sql(`${pivot}.${fkA}`)} = ${sql(`${fromTable}.${fromPk}`)} LEFT JOIN ${sql(childTable)} ON ${sql(`${childTable}.${childPk}`)} = ${sql(`${pivot}.${fkB}`)}`

            joinedTables.add(pivot)
            joinedTables.add(childTable)
            return childTable
          }

          // morphToMany: polymorphic many-to-many through pivot
          const isMtm = Boolean(rels?.morphToMany?.[relationKey])
          if (isMtm) {
            const morphName = relationKey
            const pivotTable = `${singularize(childTable)}_${morphName}`
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const childPk = meta.primaryKeys[childTable] ?? 'id'
            const morphType = `${morphName}_type`
            const morphId = `${morphName}_id`
            const targetFk = `${singularize(childTable)}_id`
            built = sql`${built} LEFT JOIN ${sql(pivotTable)} ON ${sql(`${pivotTable}.${morphId}`)} = ${sql(`${fromTable}.${fromPk}`)} AND ${sql(`${pivotTable}.${morphType}`)} = ${sql(meta.tableToModel[fromTable] || fromTable)} LEFT JOIN ${sql(childTable)} ON ${sql(`${childTable}.${childPk}`)} = ${sql(`${pivotTable}.${targetFk}`)}`
            joinedTables.add(pivotTable)
            joinedTables.add(childTable)
            return childTable
          }

          // morphedByMany: inverse of morphToMany
          const isMbm = Boolean(rels?.morphedByMany?.[relationKey])
          if (isMbm) {
            const relatedModel = rels.morphedByMany?.[relationKey] || relationKey
            const relatedTable = meta.modelToTable[relatedModel] || relatedModel
            const morphName = singularize(fromTable)
            const pivotTable = `${singularize(relatedTable)}_${morphName}`
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            const relatedPk = meta.primaryKeys[relatedTable] ?? 'id'
            const morphType = `${morphName}_type`
            const morphId = `${morphName}_id`
            const relatedFk = `${singularize(relatedTable)}_id`
            built = sql`${built} LEFT JOIN ${sql(pivotTable)} ON ${sql(`${pivotTable}.${relatedFk}`)} = ${sql(`${fromTable}.${fromPk}`)} LEFT JOIN ${sql(relatedTable)} ON ${sql(`${relatedTable}.${relatedPk}`)} = ${sql(`${pivotTable}.${morphId}`)} AND ${sql(`${pivotTable}.${morphType}`)} = ${sql(meta.tableToModel[relatedTable] || relatedTable)}`
            joinedTables.add(pivotTable)
            joinedTables.add(relatedTable)
            return relatedTable
          }

          // belongsTo: parent has fk to child
          const isBt = Boolean(rels?.belongsTo?.[relationKey])
          if (isBt) {
            const fkInParent = `${singularize(childTable)}_id`
            const childPk = meta.primaryKeys[childTable] ?? 'id'
            built = sql`${built} LEFT JOIN ${sql(childTable)} ON ${sql(`${fromTable}.${fkInParent}`)} = ${sql(`${childTable}.${childPk}`)}`
            joinedTables.add(childTable)
            return childTable
          }

          // morphOne / morphMany: polymorphic one/many
          const isMorphOne = Boolean(rels?.morphOne?.[relationKey])
          const isMorphMany = Boolean(rels?.morphMany?.[relationKey])
          if (isMorphOne || isMorphMany) {
            const morphType = `${relationKey}_type`
            const morphId = `${relationKey}_id`
            const fromPk = meta.primaryKeys[fromTable] ?? 'id'
            built = sql`${built} LEFT JOIN ${sql(childTable)} ON ${sql(`${childTable}.${morphId}`)} = ${sql(`${fromTable}.${fromPk}`)} AND ${sql(`${childTable}.${morphType}`)} = ${sql(meta.tableToModel[fromTable] || fromTable)}`
            joinedTables.add(childTable)
            return childTable
          }

          // hasOne/hasMany: child has fk to parent
          const fkInChild = `${singularize(fromTable)}_id`
          const pk = meta.primaryKeys[fromTable] ?? 'id'
          const softDeleteCheck = addSoftDeleteCheck(childTable)

          if (softDeleteCheck) {
            // Use raw SQL for complex condition
            const currentSql = String(built)
            const joinCondition = `${childTable}.${fkInChild} = ${fromTable}.${pk}${softDeleteCheck}`
            built = sql`${sql(currentSql)} LEFT JOIN ${sql(childTable)} ON ${sql(joinCondition)}`
          }
          else {
            // Use standard JOIN
            built = sql`${built} LEFT JOIN ${sql(childTable)} ON ${sql(`${childTable}.${fkInChild}`)} = ${sql(`${fromTable}.${pk}`)}`
          }

          joinedTables.add(childTable)
          return childTable
        }

        for (const rel of normalizedRelations) {
          const relationName = rel.name.trim()

          // Store callback for later use
          if (rel.callback) {
            relationConditions.set(relationName, rel.callback)
          }

          // Safely split the relationship path
          const parts = relationName.split('.')
          let from = parentTable
          let currentDepth = 0

          for (const part of parts) {
            if (!part || part.trim().length === 0)
              continue // Skip empty parts
            const trimmedPart = part.trim()

            // For conditional loading, we need to add WHERE conditions to the JOIN
            const condition = relationConditions.get(trimmedPart)
            const next = addJoin(from, trimmedPart, currentDepth, condition) || from
            from = next
            currentDepth++
          }

          // Track loaded relationship
          loadedRelationships.add(relationName)
        }

        // Apply pivot columns if any were requested
        if (pivotColumns.size > 0) {
          const allPivotColumns: string[] = []

          for (const [relation, columns] of pivotColumns.entries()) {
            const parentTable = String(table)
            const rels = meta.relations?.[parentTable]
            if (!rels)
              continue

            const targetModel = rels.belongsToMany?.[relation]
            if (!targetModel)
              continue

            const targetTable = meta.modelToTable[targetModel] || targetModel
            const a = parentTable.endsWith('s') ? parentTable.slice(0, -1) : parentTable
            const b = targetTable.endsWith('s') ? targetTable.slice(0, -1) : targetTable
            const pivot = [a, b].sort().join('_')

            const pivotColumnsStr = columns.map(col => `${pivot}.${col} AS pivot_${col}`)
            allPivotColumns.push(...pivotColumnsStr)
          }

          if (allPivotColumns.length > 0) {
            const pivotColumnsStr = allPivotColumns.join(', ')
            addToSelectClause(pivotColumnsStr)
          }
        }

        // Update text representation for toSQL()
        text = computeSqlText(built)

        return this as any
      },
      /**
       * Query records that have a specific relationship with optional conditions
       */
      whereHas(relation: string, callback?: (qb: any) => any) {
        if (!meta)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels) {
          throw new Error(`[query-builder] No relationships defined for table '${parentTable}'`)
        }

        // Find the relationship
        const relType = Object.entries(rels).find(([_type, relations]) =>
          relations && typeof relations === 'object' && relation in relations,
        )

        if (!relType) {
          throw new Error(`[query-builder] Relationship '${relation}' not found on table '${parentTable}'`)
        }

        const [type, relMap] = relType
        const targetModel = (relMap as any)[relation]
        const targetTable = meta.modelToTable[targetModel] || targetModel

        // Build raw SQL for EXISTS clause since we can't use sql in a cross-compatible way
        let subquerySQL: string

        if (type === 'hasMany' || type === 'hasOne') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          subquerySQL = buildHasSubquery(parentTable, targetTable, pk, callback)
        }
        else if (type === 'belongsTo') {
          const pk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToSubquery(parentTable, targetTable, pk, callback)
        }
        else if (type === 'belongsToMany') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          const targetPk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToManySubquery(parentTable, targetTable, pk, targetPk, callback)
        }
        else {
          throw new Error(`[query-builder] Unsupported relationship type '${type}' for whereHas`)
        }

        built = sql`${built} WHERE EXISTS (${sql([subquerySQL] as any)})`
        try {
          addWhereText('WHERE', `EXISTS (${subquerySQL})`)
        }
        catch {}

        return this as any
      },
      /**
       * Query records that don't have a specific relationship
       */
      whereDoesntHave(relation: string, callback?: (qb: any) => any) {
        if (!meta)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels) {
          throw new Error(`[query-builder] No relationships defined for table '${parentTable}'`)
        }

        const relType = Object.entries(rels).find(([_type, relations]) =>
          relations && typeof relations === 'object' && relation in relations,
        )

        if (!relType) {
          throw new Error(`[query-builder] Relationship '${relation}' not found on table '${parentTable}'`)
        }

        const [type, relMap] = relType
        const targetModel = (relMap as any)[relation]
        const targetTable = meta.modelToTable[targetModel] || targetModel

        let subquerySQL: string

        if (type === 'hasMany' || type === 'hasOne') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          subquerySQL = buildHasSubquery(parentTable, targetTable, pk, callback)
        }
        else if (type === 'belongsTo') {
          const pk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToSubquery(parentTable, targetTable, pk, callback)
        }
        else if (type === 'belongsToMany') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          const targetPk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToManySubquery(parentTable, targetTable, pk, targetPk, callback)
        }
        else {
          throw new Error(`[query-builder] Unsupported relationship type '${type}' for whereDoesntHave`)
        }

        built = sql`${built} WHERE NOT EXISTS (${sql([subquerySQL] as any)})`
        try {
          addWhereText('WHERE', `NOT EXISTS (${subquerySQL})`)
        }
        catch {}

        return this as any
      },
      /**
       * Shorthand for whereHas - filter records that have a relationship
       */
      has(relation: string) {
        // Inline implementation to avoid TypeScript `this` issues
        if (!meta)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels)
          throw new Error(`[query-builder] No relationships defined for table '${parentTable}'`)

        const relType = Object.entries(rels).find(([_type, relations]) =>
          relations && typeof relations === 'object' && relation in relations,
        )
        if (!relType)
          throw new Error(`[query-builder] Relationship '${relation}' not found on table '${parentTable}'`)

        const [type, relMap] = relType
        const targetModel = (relMap as any)[relation]
        const targetTable = meta.modelToTable[targetModel] || targetModel

        let subquerySQL: string

        if (type === 'hasMany' || type === 'hasOne') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          subquerySQL = buildHasSubquery(parentTable, targetTable, pk)
        }
        else if (type === 'belongsTo') {
          const pk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToSubquery(parentTable, targetTable, pk)
        }
        else if (type === 'belongsToMany') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          const targetPk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToManySubquery(parentTable, targetTable, pk, targetPk)
        }
        else {
          throw new Error(`[query-builder] Unsupported relationship type '${type}' for has`)
        }

        built = sql`${built} WHERE EXISTS (${sql([subquerySQL] as any)})`
        try {
          addWhereText('WHERE', `EXISTS (${subquerySQL})`)
        }
        catch {}

        return this as any
      },
      /**
       * Shorthand for whereDoesntHave - filter records that don't have a relationship
       */
      doesntHave(relation: string) {
        // Inline implementation to avoid TypeScript `this` issues
        if (!meta)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels)
          throw new Error(`[query-builder] No relationships defined for table '${parentTable}'`)

        const relType = Object.entries(rels).find(([_type, relations]) =>
          relations && typeof relations === 'object' && relation in relations,
        )
        if (!relType)
          throw new Error(`[query-builder] Relationship '${relation}' not found on table '${parentTable}'`)

        const [type, relMap] = relType
        const targetModel = (relMap as any)[relation]
        const targetTable = meta.modelToTable[targetModel] || targetModel

        let subquerySQL: string

        if (type === 'hasMany' || type === 'hasOne') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          subquerySQL = buildHasSubquery(parentTable, targetTable, pk)
        }
        else if (type === 'belongsTo') {
          const pk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToSubquery(parentTable, targetTable, pk)
        }
        else if (type === 'belongsToMany') {
          const pk = meta.primaryKeys[parentTable] ?? 'id'
          const targetPk = meta.primaryKeys[targetTable] ?? 'id'
          subquerySQL = buildBelongsToManySubquery(parentTable, targetTable, pk, targetPk)
        }
        else {
          throw new Error(`[query-builder] Unsupported relationship type '${type}' for doesntHave`)
        }

        built = sql`${built} WHERE NOT EXISTS (${sql([subquerySQL] as any)})`
        try {
          addWhereText('WHERE', `NOT EXISTS (${subquerySQL})`)
        }
        catch {}

        return this as any
      },
      /**
       * Load relationship counts as aggregate columns
       */
      withCount(...relations: string[]) {
        if (!meta || !relations || relations.length === 0)
          return this as any

        const parentTable = String(table)

        for (const relation of relations) {
          const rels = meta.relations?.[parentTable]
          if (!rels)
            continue

          const relType = Object.entries(rels).find(([_type, relMap]) =>
            relMap && typeof relMap === 'object' && relation in relMap,
          )

          if (!relType)
            continue

          const [type, relMap] = relType
          const targetModel = (relMap as any)[relation]
          const targetTable = meta.modelToTable[targetModel] || targetModel

          const pk = meta.primaryKeys[parentTable] ?? 'id'
          let countSubquery: string

          if (type === 'hasMany' || type === 'hasOne') {
            countSubquery = buildHasCountSubquery(parentTable, targetTable, pk)
          }
          else if (type === 'belongsToMany') {
            countSubquery = buildBelongsToManyCountSubquery(parentTable, targetTable, pk)
          }
          else {
            continue // Skip unsupported relationship types
          }

          const alias = `${relation}_count`
          addToSelectClause(`${countSubquery} AS ${alias}`)
        }

        return this as any
      },
      /**
       * Apply pivot columns to the SELECT clause
       */
      applyPivotColumns() {
        applyPivotColumnsToQuery()
        return this as any
      },
      /**
       * Include pivot table columns when eager loading belongsToMany relationships
       * Usage: .with('tags').withPivot('tags', 'created_at', 'role')
       */
      withPivot(relation: string, ...columns: string[]) {
        if (!meta || !columns || columns.length === 0)
          return this as any

        const parentTable = String(table)
        const rels = meta.relations?.[parentTable]
        if (!rels)
          return this as any

        // Find if this is a belongsToMany relationship
        const targetModel = rels.belongsToMany?.[relation]
        if (!targetModel) {
          throw new Error(`[query-builder] Relationship '${relation}' is not a belongsToMany relationship on table '${parentTable}'`)
        }

        // Store pivot columns for this relationship
        pivotColumns.set(relation, columns)

        // Apply pivot columns to the current query
        applyPivotColumnsToQuery()

        return this as any
      },
      where(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          const paramIndex = whereParams.length + 1
          whereConditions.push(`${String(expr)} ${String(op)} $${paramIndex}`)
          whereParams.push(value)
          // Update built and text immediately
          text = `${text} WHERE ${String(expr)} ${String(op)} $${paramIndex}`
          built = (_sql as any).unsafe(text, whereParams)
          return this
        }

        // Handle array format: ['column', 'op', value]
        if (Array.isArray(expr)) {
          const [col, op, val] = expr
          const colName = String(col)
          const operator = String(op)

          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(val) ? val : [val]
            const placeholders = values.map((_, i) => `$${whereParams.length + i + 1}`).join(', ')
            whereConditions.push(`${colName} ${operator.toUpperCase()} (${placeholders})`)
            whereParams.push(...values)
            text = `${text} WHERE ${colName} ${operator.toUpperCase()} (${placeholders})`
            built = (_sql as any).unsafe(text, whereParams)
          }
          else {
            const paramIndex = whereParams.length + 1
            whereConditions.push(`${colName} ${operator} $${paramIndex}`)
            whereParams.push(val)
            text = `${text} WHERE ${colName} ${operator} $${paramIndex}`
            built = (_sql as any).unsafe(text, whereParams)
          }

          return this
        }

        // Handle object format: { name: 'Alice', age: 25 }
        if (expr && typeof expr === 'object' && !isRawExpression(expr)) {
          const whereObject = expr as Record<string, unknown>
          const keys = Object.keys(whereObject)
          const conditions: string[] = []

          for (const key of keys) {
            const value = whereObject[key]
            if (Array.isArray(value)) {
              const placeholders = value.map((_, i) => `$${whereParams.length + i + 1}`).join(', ')
              conditions.push(`${key} IN (${placeholders})`)
              whereConditions.push(`${key} IN (${placeholders})`)
              whereParams.push(...value)
            }
            else {
              const paramIndex = whereParams.length + 1
              conditions.push(`${key} = $${paramIndex}`)
              whereConditions.push(`${key} = $${paramIndex}`)
              whereParams.push(value)
            }
          }

          if (conditions.length > 0) {
            text = `${text} WHERE ${conditions.join(' AND ')}`
            built = (_sql as any).unsafe(text, whereParams)
          }
          return this
        }

        // Handle raw expressions
        if (isRawExpression(expr)) {
          whereConditions.push(expr.raw)
          text = `${text} WHERE ${expr.raw}`
          built = (_sql as any).unsafe(text)
          return this
        }

        return this
      },
      // where helpers
      whereNull(column: string) {
        built = sql`${built} WHERE ${sql(String(column))} IS NULL`
        return this
      },
      whereNotNull(column: string) {
        built = sql`${built} WHERE ${sql(String(column))} IS NOT NULL`
        return this
      },
      whereBetween(column: string, start: any, end: any) {
        built = sql`${built} WHERE ${sql(String(column))} BETWEEN ${start} AND ${end}`
        return this
      },
      whereExists(subquery: { toSQL: () => any }) {
        built = sql`${built} WHERE EXISTS (${subquery.toSQL()})`
        return this
      },
      whereJsonContains(column: string, json: unknown) {
        built = sql`${built} WHERE ${sql(String(column))} @> ${sql(JSON.stringify(json))}`
        addWhereText('WHERE', `${String(column)} @> ?`)
        return this as any
      },
      whereJsonPath(path: string, op: WhereOperator, value: any) {
        const dialect = config.dialect
        if (dialect === 'postgres') {
          built = sql`${built} WHERE ${sql(path)} ${op} ${value}`
        }
        else if (dialect === 'mysql') {
          built = sql`${built} WHERE JSON_EXTRACT(${sql(path)}) ${op} ${value}`
        }
        else {
          built = sql`${built} WHERE json_extract(${sql(path)}) ${op} ${value}`
        }
        return this as any
      },
      whereLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? sql`${sql(String(column))} LIKE ${pattern}` : sql`LOWER(${sql(String(column))}) LIKE LOWER(${pattern})`
        built = sql`${built} WHERE ${expr}`
        addWhereText('WHERE', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} LIKE ${caseSensitive ? '?' : 'LOWER(?)'}`)
        return this as any
      },
      whereILike(column: string, pattern: string) {
        if (config.dialect === 'postgres') {
          built = sql`${built} WHERE ${sql(String(column))} ILIKE ${pattern}`
          addWhereText('WHERE', `${String(column)} ILIKE ?`)
        }
        else {
          const expr = sql`LOWER(${sql(String(column))}) LIKE LOWER(${pattern})`
          built = sql`${built} WHERE ${expr}`
          addWhereText('WHERE', `LOWER(${String(column)}) LIKE LOWER(?)`)
        }
        return this as any
      },
      orWhereLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? sql`${sql(String(column))} LIKE ${pattern}` : sql`LOWER(${sql(String(column))}) LIKE LOWER(${pattern})`
        built = sql`${built} OR ${expr}`
        addWhereText('OR', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} LIKE ${caseSensitive ? '?' : 'LOWER(?)'}`)
        return this as any
      },
      orWhereILike(column: string, pattern: string) {
        if (config.dialect === 'postgres') {
          built = sql`${built} OR ${sql(String(column))} ILIKE ${pattern}`
          addWhereText('OR', `${String(column)} ILIKE ?`)
        }
        else {
          const expr = sql`LOWER(${sql(String(column))}) LIKE LOWER(${pattern})`
          built = sql`${built} OR ${expr}`
          addWhereText('OR', `LOWER(${String(column)}) LIKE LOWER(?)`)
        }
        return this as any
      },
      whereNotLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? sql`${sql(String(column))} NOT LIKE ${pattern}` : sql`LOWER(${sql(String(column))}) NOT LIKE LOWER(${pattern})`
        built = sql`${built} WHERE ${expr}`
        addWhereText('WHERE', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} NOT LIKE ${caseSensitive ? '?' : 'LOWER(?)'}`)
        return this as any
      },
      whereNotILike(column: string, pattern: string) {
        if (config.dialect === 'postgres') {
          built = sql`${built} WHERE ${sql(String(column))} NOT ILIKE ${pattern}`
          addWhereText('WHERE', `${String(column)} NOT ILIKE ?`)
        }
        else {
          const expr = sql`LOWER(${sql(String(column))}) NOT LIKE LOWER(${pattern})`
          built = sql`${built} WHERE ${expr}`
          addWhereText('WHERE', `LOWER(${String(column)}) NOT LIKE LOWER(?)`)
        }
        return this as any
      },
      orWhereNotLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? sql`${sql(String(column))} NOT LIKE ${pattern}` : sql`LOWER(${sql(String(column))}) NOT LIKE LOWER(${pattern})`
        built = sql`${built} OR ${expr}`
        addWhereText('OR', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} NOT LIKE ${caseSensitive ? '?' : 'LOWER(?)'}`)
        return this as any
      },
      orWhereNotILike(column: string, pattern: string) {
        if (config.dialect === 'postgres') {
          built = sql`${built} OR ${sql(String(column))} NOT ILIKE ${pattern}`
          addWhereText('OR', `${String(column)} NOT ILIKE ?`)
        }
        else {
          const expr = sql`LOWER(${sql(String(column))}) NOT LIKE LOWER(${pattern})`
          built = sql`${built} OR ${expr}`
          addWhereText('OR', `LOWER(${String(column)}) NOT LIKE LOWER(?)`)
        }
        return this as any
      },
      whereAny(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0)
          return this as any
        const parts = cols.map(c => sql`${sql(String(c))} ${op} ${value}`)
        const expr = parts.reduce((acc, p, i) => (i === 0 ? p : sql`${acc} OR ${p}`))
        built = sql`${built} WHERE (${expr})`
        return this as any
      },
      whereAll(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0)
          return this as any
        const parts = cols.map(c => sql`${sql(String(c))} ${op} ${value}`)
        const expr = parts.reduce((acc, p, i) => (i === 0 ? p : sql`${acc} AND ${p}`))
        built = sql`${built} WHERE (${expr})`
        return this as any
      },
      whereNone(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0)
          return this as any
        const parts = cols.map(c => sql`${sql(String(c))} ${op} ${value}`)
        const expr = parts.reduce((acc, p, i) => (i === 0 ? p : sql`${acc} OR ${p}`))
        built = sql`${built} WHERE NOT (${expr})`
        return this as any
      },
      whereNotBetween(column: string, start: any, end: any) {
        built = sql`${built} WHERE ${sql(String(column))} NOT BETWEEN ${start} AND ${end}`
        return this as any
      },
      whereDate(column: string, op: WhereOperator, date: string | Date) {
        built = sql`${built} WHERE ${sql(String(column))} ${op} ${sql(String(date))}`
        return this as any
      },
      whereRaw(fragment: any) {
        built = sql`${built} WHERE ${fragment}`
        return this as any
      },
      whereColumn(left: string, op: WhereOperator, right: string) {
        built = sql`${built} WHERE ${sql(left)} ${op} ${sql(right)}`
        return this as any
      },
      orWhereColumn(left: string, op: WhereOperator, right: string) {
        built = sql`${built} OR ${sql(left)} ${op} ${sql(right)}`
        return this as any
      },
      whereIn(column: string, values: any[] | { toSQL: () => any }) {
        const v = Array.isArray(values) ? sql(values as any) : sql`(${(values as any).toSQL()})`
        built = sql`${built} WHERE ${sql(String(column))} IN ${v}`
        return this as any
      },
      orWhereIn(column: string, values: any[] | { toSQL: () => any }) {
        const v = Array.isArray(values) ? sql(values as any) : sql`(${(values as any).toSQL()})`
        built = sql`${built} OR ${sql(String(column))} IN ${v}`
        return this as any
      },
      whereNotIn(column: string, values: any[] | { toSQL: () => any }) {
        const v = Array.isArray(values) ? sql(values as any) : sql`(${(values as any).toSQL()})`
        built = sql`${built} WHERE ${sql(String(column))} NOT IN ${v}`
        return this as any
      },
      orWhereNotIn(column: string, values: any[] | { toSQL: () => any }) {
        const v = Array.isArray(values) ? sql(values as any) : sql`(${(values as any).toSQL()})`
        built = sql`${built} OR ${sql(String(column))} NOT IN ${v}`
        return this as any
      },
      whereNested(fragment: any) {
        built = sql`${built} WHERE (${fragment.toSQL ? fragment.toSQL() : fragment})`
        return this as any
      },
      orWhereNested(fragment: any) {
        built = sql`${built} OR (${fragment.toSQL ? fragment.toSQL() : fragment})`
        return this as any
      },
      andWhere(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          const paramIndex = whereParams.length + 1
          whereConditions.push(`${String(expr)} ${String(op)} $${paramIndex}`)
          whereParams.push(value)
          text = `${text} AND ${String(expr)} ${String(op)} $${paramIndex}`
          built = (_sql as any).unsafe(text, whereParams)
          return this
        }

        // Handle array format: ['column', 'op', value]
        if (Array.isArray(expr)) {
          const [col, op, val] = expr
          const colName = String(col)
          const operator = String(op)

          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(val) ? val : [val]
            const placeholders = values.map((_, i) => `$${whereParams.length + i + 1}`).join(', ')
            whereConditions.push(`${colName} ${operator.toUpperCase()} (${placeholders})`)
            whereParams.push(...values)
            text = `${text} AND ${colName} ${operator.toUpperCase()} (${placeholders})`
            built = (_sql as any).unsafe(text, whereParams)
          }
          else {
            const paramIndex = whereParams.length + 1
            whereConditions.push(`${colName} ${operator} $${paramIndex}`)
            whereParams.push(val)
            text = `${text} AND ${colName} ${operator} $${paramIndex}`
            built = (_sql as any).unsafe(text, whereParams)
          }

          return this
        }

        // Handle object format: { name: 'Alice', age: 25 }
        if (expr && typeof expr === 'object' && !('raw' in expr)) {
          const keys = Object.keys(expr)
          const conditions: string[] = []

          for (const key of keys) {
            const value = (expr as any)[key]
            if (Array.isArray(value)) {
              const placeholders = value.map((_, i) => `$${whereParams.length + i + 1}`).join(', ')
              conditions.push(`${key} IN (${placeholders})`)
              whereConditions.push(`${key} IN (${placeholders})`)
              whereParams.push(...value)
            }
            else {
              const paramIndex = whereParams.length + 1
              conditions.push(`${key} = $${paramIndex}`)
              whereConditions.push(`${key} = $${paramIndex}`)
              whereParams.push(value)
            }
          }

          if (conditions.length > 0) {
            text = `${text} AND ${conditions.join(' AND ')}`
            built = (_sql as any).unsafe(text, whereParams)
          }
          return this
        }

        // Handle raw expressions
        if (expr && typeof (expr as any).raw !== 'undefined') {
          whereConditions.push((expr as any).raw)
          text = `${text} AND ${(expr as any).raw}`
          built = (_sql as any).unsafe(text)
          return this
        }

        return this
      },
      orWhere(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          const paramIndex = whereParams.length + 1
          whereConditions.push(`OR ${String(expr)} ${String(op)} $${paramIndex}`)
          whereParams.push(value)
          text = `${text} OR ${String(expr)} ${String(op)} $${paramIndex}`
          built = (_sql as any).unsafe(text, whereParams)
          return this
        }

        // Handle array format: ['column', 'op', value]
        if (Array.isArray(expr)) {
          const [col, op, val] = expr
          const colName = String(col)
          const operator = String(op)

          if (operator === 'in' || operator === 'not in') {
            const values = Array.isArray(val) ? val : [val]
            const placeholders = values.map((_, i) => `$${whereParams.length + i + 1}`).join(', ')
            whereConditions.push(`OR ${colName} ${operator.toUpperCase()} (${placeholders})`)
            whereParams.push(...values)
            text = `${text} OR ${colName} ${operator.toUpperCase()} (${placeholders})`
            built = (_sql as any).unsafe(text, whereParams)
          }
          else {
            const paramIndex = whereParams.length + 1
            whereConditions.push(`OR ${colName} ${operator} $${paramIndex}`)
            whereParams.push(val)
            text = `${text} OR ${colName} ${operator} $${paramIndex}`
            built = (_sql as any).unsafe(text, whereParams)
          }

          return this
        }

        // Handle object format: { name: 'Alice', age: 25 }
        if (expr && typeof expr === 'object' && !('raw' in expr)) {
          const keys = Object.keys(expr)
          const conditions: string[] = []

          for (const key of keys) {
            const value = (expr as any)[key]
            if (Array.isArray(value)) {
              const placeholders = value.map((_, i) => `$${whereParams.length + i + 1}`).join(', ')
              conditions.push(`${key} IN (${placeholders})`)
              whereConditions.push(`OR ${key} IN (${placeholders})`)
              whereParams.push(...value)
            }
            else {
              const paramIndex = whereParams.length + 1
              conditions.push(`${key} = $${paramIndex}`)
              whereConditions.push(`OR ${key} = $${paramIndex}`)
              whereParams.push(value)
            }
          }

          if (conditions.length > 0) {
            text = `${text} OR ${conditions.join(' AND ')}`
            built = (_sql as any).unsafe(text, whereParams)
          }
          return this
        }

        // Handle raw expressions
        if (expr && typeof (expr as any).raw !== 'undefined') {
          whereConditions.push(`OR ${(expr as any).raw}`)
          text = `${text} OR ${(expr as any).raw}`
          built = (_sql as any).unsafe(text)
          return this
        }

        return this
      },
      orderBy(column: string, direction: 'asc' | 'desc' = 'asc') {
        text += ` ORDER BY ${column} ${direction === 'asc' ? 'ASC' : 'DESC'}`
        built = whereParams.length > 0
          ? (_sql as any).unsafe(text, whereParams)
          : (_sql as any).unsafe(text)
        return this
      },
      orderByDesc(column: string) {
        built = sql`${built} ORDER BY ${sql(String(column))} DESC`
        return this as any
      },
      inRandomOrder() {
        const rnd = config.sql.randomFunction === 'RAND()' ? sql`RAND()` : sql`RANDOM()`
        built = sql`${built} ORDER BY ${rnd}`
        return this as any
      },
      reorder(column: string, direction: 'asc' | 'desc' = 'asc') {
        built = sql`${sql(String(built).replace(/ORDER BY[\s\S]*$/i, ''))} ORDER BY ${sql(column)} ${direction === 'asc' ? sql`ASC` : sql`DESC`}`
        return this as any
      },
      latest(column?: any) {
        const col = column ?? config.timestamps.defaultOrderColumn
        built = sql`${built} ORDER BY ${sql(String(col))} DESC`
        return this as any
      },
      oldest(column?: any) {
        const col = column ?? config.timestamps.defaultOrderColumn
        built = sql`${built} ORDER BY ${sql(String(col))} ASC`
        return this as any
      },
      limit(n: number) {
        text += ` LIMIT ${n}`
        return this
      },
      offset(n: number) {
        text += ` OFFSET ${n}`
        return this
      },
      join(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        text = `${text} JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`
        joinedTables.add(table2)
        return this as any
      },
      joinSub(sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) {
        built = sql`${built} JOIN (${sub.toSQL()}) AS ${sql(alias)} ON ${sql(onLeft)} ${operator} ${sql(onRight)}`
        joinedTables.add(alias)
        return this as any
      },
      innerJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        text = `${text} INNER JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`
        built = (_sql as any).unsafe(text)
        joinedTables.add(table2)
        return this as any
      },
      leftJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        text = `${text} LEFT JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`
        built = (_sql as any).unsafe(text)
        joinedTables.add(table2)
        return this as any
      },
      leftJoinSub(sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) {
        built = sql`${built} LEFT JOIN (${sub.toSQL()}) AS ${sql(alias)} ON ${sql(onLeft)} ${operator} ${sql(onRight)}`
        joinedTables.add(alias)
        return this as any
      },
      rightJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        text = `${text} RIGHT JOIN ${table2} ON ${onLeft} ${operator} ${onRight}`
        built = (_sql as any).unsafe(text)
        joinedTables.add(table2)
        return this as any
      },
      crossJoin(table2: string) {
        text = `${text} CROSS JOIN ${table2}`
        built = (_sql as any).unsafe(text)
        joinedTables.add(table2)
        return this as any
      },
      crossJoinSub(sub: { toSQL: () => any }, alias: string) {
        built = sql`${built} CROSS JOIN (${sub.toSQL()}) AS ${sql(alias)}`
        joinedTables.add(alias)
        return this as any
      },
      selectAllRelations() {
        if (!schema)
          return this as any
        const parent = String(table)
        const parentCols = Object.keys((schema as any)[parent]?.columns ?? {})
        const parts: any[] = []
        if (parentCols.length > 0)
          parts.push(sql`${sql(parent)}.*`)
        for (const jt of joinedTables) {
          const cols = Object.keys((schema as any)[jt]?.columns ?? {})
          for (const c of cols) {
            const alias = config.aliasing.relationColumnAliasFormat === 'camelCase'
              ? `${jt}_${c}`.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
              : config.aliasing.relationColumnAliasFormat === 'table.dot.column'
                ? `${jt}.${c}`
                : `${jt}_${c}`
            parts.push(sql`${sql(`${jt}.${c}`)} AS ${sql(alias)}`)
          }
        }
        if (parts.length > 0) {
          built = sql`SELECT ${sql(parts as any)} FROM ${sql(parent)} ${sql``}`
        }
        return this as any
      },
      groupBy(...cols: string[]) {
        if (cols.length) {
          text += ` GROUP BY ${cols.join(', ')}`
          built = (_sql as any).unsafe(text, whereParams)
        }
        return this as any
      },
      groupByRaw(fragment: any) {
        built = sql`${built} GROUP BY ${fragment}`
        return this as any
      },
      having(expr: any) {
        // Handle array format: ['COUNT(id)', '>', 3]
        if (Array.isArray(expr)) {
          const paramIdx = whereParams.length + 1
          text = `${text} HAVING ${expr[0]} ${expr[1]} $${paramIdx}`
          whereParams.push(expr[2])
          built = (_sql as any).unsafe(text, whereParams)
        }
        // Handle object format
        else if (expr && typeof expr === 'object' && !('raw' in expr)) {
          const keys = Object.keys(expr)
          const len = keys.length
          if (len) {
            const baseIdx = whereParams.length
            const conditions: string[] = Array.from({ length: len })
            for (let i = 0; i < len; i++) {
              const key = keys[i]
              conditions[i] = `${key} = $${baseIdx + i + 1}`
              whereParams.push(expr[key])
            }
            text = `${text} HAVING ${conditions.join(' AND ')}`
            built = (_sql as any).unsafe(text, whereParams)
          }
        }
        // Handle raw expressions
        else if (expr && typeof (expr as any).raw !== 'undefined') {
          text += ` HAVING ${(expr as any).raw}`
          built = (_sql as any).unsafe(text)
        }
        return this as any
      },
      havingRaw(fragment: any) {
        built = sql`${built} HAVING ${fragment}`
        return this as any
      },
      orderByRaw(fragment: any) {
        built = sql`${built} ORDER BY ${fragment}`
        return this as any
      },
      union(other: { toSQL: () => any }) {
        built = sql`${built} UNION ${other.toSQL()}`
        return this as any
      },
      unionAll(other: { toSQL: () => any }) {
        built = sql`${built} UNION ALL ${other.toSQL()}`
        return this as any
      },
      forPage(page: number, perPage: number) {
        const p = Math.max(1, Math.floor(page))
        const pp = Math.max(1, Math.floor(perPage))
        built = sql`${built} LIMIT ${pp} OFFSET ${(p - 1) * pp}`
        return this as any
      },
      toSQL() {
        return makeExecutableQuery(built, text) as any
      },
      async value(column: string) {
        const q = sql`${built} LIMIT 1`
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row?.[column]
      },
      async pluck(column: any, key?: any) {
        const rows = await runWithHooks<any[]>(built, 'select', { signal: abortSignal, timeoutMs })
        if (key) {
          const out: Record<string, any> = {}
          for (const r of rows) out[String(r?.[key])] = r?.[column]
          return out
        }
        return rows.map((r: any) => r?.[column])
      },
      async exists() {
        const q = sql`SELECT EXISTS (${built}) as e`
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Boolean(row?.e)
      },
      async doesntExist() {
        const e = await (this as any).exists()
        return !e
      },
      async paginate(perPage: number, page = 1) {
        const countQ = sql`SELECT COUNT(*) as c FROM (${built}) as sub`
        const cRows = await runWithHooks<any[]>(countQ, 'select', { signal: abortSignal, timeoutMs })
        const [cRow] = cRows
        const total = Number(cRow?.c ?? 0)
        const lastPage = Math.max(1, Math.ceil(total / perPage))
        const p = Math.max(1, Math.min(page, lastPage))
        const offset = (p - 1) * perPage
        const data = await runWithHooks<any[]>(sql`${built} LIMIT ${perPage} OFFSET ${offset}`, 'select', { signal: abortSignal, timeoutMs })
        return { data, meta: { perPage, page: p, total, lastPage } }
      },
      async simplePaginate(perPage: number, page = 1) {
        const p = Math.max(1, page)
        const offset = (p - 1) * perPage
        const data = await runWithHooks<any[]>(sql`${built} LIMIT ${perPage + 1} OFFSET ${offset}`, 'select', { signal: abortSignal, timeoutMs })
        const hasMore = data.length > perPage
        return { data: hasMore ? data.slice(0, perPage) : data, meta: { perPage, page: p, hasMore } }
      },
      async cursorPaginate(perPage: number, cursor?: any, column: string | string[] = 'id', direction: 'asc' | 'desc' = 'asc') {
        let q = built
        if (cursor !== undefined && cursor !== null) {
          if (Array.isArray(column)) {
            const cols = column.map(c => sql(String(c)))
            const comp = direction === 'asc' ? sql`>` : sql`<`
            const tupleCols = sql`(${sql(cols as any)})`
            const tupleVals = sql`(${sql(cursor as any)})`
            q = sql`${q} WHERE ${tupleCols} ${comp} ${tupleVals}`
          }
          else {
            q = direction === 'asc'
              ? sql`${q} WHERE ${sql(String(column))} > ${cursor}`
              : sql`${q} WHERE ${sql(String(column))} < ${cursor}`
          }
        }
        if (Array.isArray(column)) {
          const orderParts = column.map(c => sql`${sql(String(c))} ${direction === 'asc' ? sql`ASC` : sql`DESC`}`)
          const orderExpr = orderParts.reduce((acc, p, i) => (i === 0 ? p : sql`${acc}, ${p}`))
          q = sql`${q} ORDER BY ${orderExpr} LIMIT ${perPage + 1}`
        }
        else {
          q = sql`${q} ORDER BY ${sql(String(column))} ${direction === 'asc' ? sql`ASC` : sql`DESC`} LIMIT ${perPage + 1}`
        }
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const next = rows.length > perPage
          ? (Array.isArray(column) ? column.map(c => rows[perPage]?.[c]) : rows[perPage]?.[column])
          : null
        const data = rows.slice(0, perPage)
        const prevCursor = data.length ? (Array.isArray(column) ? column.map(c => data[0]?.[c]) : data[0]?.[column]) : null
        return { data, meta: { perPage, nextCursor: next ?? null, prevCursor } }
      },
      async chunk(size: number, handler: (rows: any[]) => Promise<void> | void) {
        let page = 1
        while (true) {
          const { data } = await (this as any).paginate(size, page)
          if (data.length === 0)
            break
          await handler(data as any[])
          if (data.length < size)
            break
          page += 1
        }
      },
      async chunkById(size: number, column = 'id', handler?: (rows: any[]) => Promise<void> | void) {
        let cursor: any
        while (true) {
          const { data, meta } = await (this as any).cursorPaginate(size, cursor, column, 'asc')
          if (data.length === 0)
            break
          if (handler)
            await handler(data as any[])
          cursor = meta.nextCursor
          if (!cursor)
            break
        }
      },
      async eachById(size: number, column = 'id', handler?: (row: any) => Promise<void> | void) {
        await (this as any).chunkById(size, column, async (rows: any[]) => {
          for (const r of rows) await handler?.(r as any)
        })
      },
      withTimeout(ms: number) {
        timeoutMs = Math.max(1, Math.floor(ms))
        return this as any
      },
      abort(signal: any) {
        abortSignal = signal
        return this as any
      },
      withTrashed() {
        includeTrashed = true
        onlyTrashed = false
        return this as any
      },
      onlyTrashed() {
        includeTrashed = true
        onlyTrashed = true

        const softDeleteColumn = config.softDeletes?.column || 'deleted_at'

        // Update text representation for toSQL()
        if (text.includes('WHERE')) {
          text = text.replace(/WHERE/, `WHERE ${table}.${softDeleteColumn} IS NOT NULL AND`)
        }
        else {
          text = `${text} WHERE ${table}.${softDeleteColumn} IS NOT NULL`
        }

        // Update built query
        const currentSql = String(built)
        if (currentSql.includes('WHERE')) {
          const newSql = currentSql.replace(/WHERE/, `WHERE ${table}.${softDeleteColumn} IS NOT NULL AND`)
          built = sql([newSql] as any)
        }
        else {
          const newSql = `${currentSql} WHERE ${table}.${softDeleteColumn} IS NOT NULL`
          built = sql([newSql] as any)
        }

        return this as any
      },
      scope(name: string, value?: any) {
        const tbl = String(table)
        const scopeMap = meta?.scopes?.[tbl]
        const fn = scopeMap?.[name]
        if (fn)
          return fn(this, value)
        return this as any
      },
      when(condition: any, then: (qb: any) => any, otherwise?: (qb: any) => any) {
        if (condition)
          return then(this)
        if (otherwise)
          return otherwise(this)
        return this as any
      },
      tap(fn: (qb: any) => any) {
        fn(this)
        return this as any
      },
      dump() {
        console.log(String(built))
        return this as any
      },
      dd() {
        console.log(String(built))
        throw new Error('Dump and Die')
      },
      cache(ttlMs: number = 60000) {
        cacheTtl = ttlMs
        useCache = true
        return this as any
      },
      async explain() {
        const q = sql`EXPLAIN ${built}`
        return await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
      },
      simple() {
        return (built as any).simple()
      },
      toText() {
        return text
      },
      async get() {
        // Build query at execution time (statement will be cached by db-clients.ts)
        built = whereParams.length > 0
          ? (_sql as any).unsafe(text, whereParams)
          : (_sql as any).unsafe(text)

        // Ultra-fast path: no soft-deletes, no cache, no timeout, no signal, no hooks
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal && !config.hooks) {
          // Direct statement execution for maximum performance (bypasses all overhead)
          const stmt = built._stmt
          const params = built._params
          if (stmt) {
            // Call statement directly with params (avoid any wrapper overhead)
            return params && params.length > 0 ? stmt.all(...params) : stmt.all()
          }
          return built.execute()
        }

        // Fast path: no soft-deletes, no cache, no timeout, no signal (but may have hooks)
        if (!config.softDeletes?.enabled && !useCache && !timeoutMs && !abortSignal) {
          return runWithHooks<any[]>(built, 'select')
        }

        // Apply soft-deletes default filter if enabled and table has the column
        let finalQuery = built
        if (config.softDeletes?.enabled && config.softDeletes.defaultFilter && !includeTrashed) {
          const col = config.softDeletes.column
          const tbl = String(table)
          const hasCol = schema ? Boolean((schema as any)[tbl]?.columns?.[col]) : true
          if (hasCol && !SQL_PATTERNS.DELETED_AT.test(text)) {
            finalQuery = sql`${built} WHERE ${sql(String(col))} IS ${onlyTrashed ? sql`NOT NULL` : sql`NULL`}`
            addWhereText('WHERE', `${String(col)} IS ${onlyTrashed ? 'NOT ' : ''}NULL`)
          }
        }

        // Check cache if enabled
        if (useCache) {
          const cacheKey = String(finalQuery)
          const cached = queryCache.get(cacheKey)
          if (cached)
            return cached
        }

        const result = await runWithHooks<any[]>(finalQuery, 'select', { signal: abortSignal, timeoutMs })

        // Store in cache if enabled
        if (useCache) {
          const cacheKey = String(finalQuery)
          queryCache.set(cacheKey, result, cacheTtl)
        }

        return result
      },
      async executeTakeFirst() {
        const rows = await runWithHooks<any[]>(built, 'select', { signal: abortSignal, timeoutMs })
        return Array.isArray(rows) ? rows[0] : rows
      },
      async first() {
        const rows = await runWithHooks<any[]>(sql`${built} LIMIT 1`, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row as any
      },
      async firstOrFail() {
        const row = await (this as any).first()
        if (!row)
          throw new Error('Record not found')
        return row as any
      },
      async find(id: any) {
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        const rows = await runWithHooks<any[]>(sql`${built} WHERE ${sql(pk)} = ${id} LIMIT 1`, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row as any
      },
      async findOrFail(id: any) {
        const row = await (this as any).find(id)
        if (!row)
          throw new Error('Record not found')
        return row as any
      },
      async findMany(ids: any[]) {
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        const rows = await runWithHooks<any[]>(sql`${built} WHERE ${sql(String(pk))} IN ${sql(ids as any)}`, 'select', { signal: abortSignal, timeoutMs })
        return rows as any
      },
      async* lazy() {
        let cursor: any
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        while (true) {
          const q = cursor == null
            ? sql`${built} ORDER BY ${sql(String(pk))} ASC LIMIT 100`
            : sql`${built} WHERE ${sql(String(pk))} > ${cursor} ORDER BY ${sql(String(pk))} ASC LIMIT 100`
          const rows: any[] = await (q as any).execute()
          if (rows.length === 0)
            break
          for (const r of rows) yield r as any
          cursor = rows[rows.length - 1]?.[pk as any]
          if (cursor == null)
            break
        }
      },
      async* lazyById() {
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        let cursor: any
        while (true) {
          const q = cursor == null
            ? sql`${built} ORDER BY ${sql(String(pk))} ASC LIMIT 100`
            : sql`${built} WHERE ${sql(String(pk))} > ${cursor} ORDER BY ${sql(String(pk))} ASC LIMIT 100`
          const rows: any[] = await (q as any).execute()
          if (rows.length === 0)
            break
          for (const r of rows) yield r as any
          cursor = rows[rows.length - 1]?.[pk as any]
          if (cursor == null)
            break
        }
      },
      pipe(fn: any) {
        return fn(this as any)
      },
      async count() {
        // Build optimized COUNT query without subquery
        const fromIdx = text.indexOf(' FROM ')
        const countText = fromIdx !== -1
          ? `SELECT COUNT(*) as c${text.substring(fromIdx)}`
          : `SELECT COUNT(*) as c FROM ${table}`
        const q = whereParams.length > 0
          ? (_sql as any).unsafe(countText, whereParams)
          : (_sql as any).unsafe(countText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Number(row?.c ?? 0)
      },
      async avg(column: string) {
        // Build optimized AVG query without subquery or helpers
        const fromIdx = text.indexOf(' FROM ')
        const avgText = fromIdx !== -1
          ? `SELECT AVG(${column}) as a${text.substring(fromIdx)}`
          : `SELECT AVG(${column}) as a FROM ${table}`
        const q = whereParams.length > 0
          ? (_sql as any).unsafe(avgText, whereParams)
          : (_sql as any).unsafe(avgText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Number(row?.a ?? 0)
      },
      async sum(column: string) {
        const fromIdx = text.indexOf(' FROM ')
        const sumText = fromIdx !== -1
          ? `SELECT SUM(${column}) as s${text.substring(fromIdx)}`
          : `SELECT SUM(${column}) as s FROM ${table}`
        const q = whereParams.length > 0
          ? (_sql as any).unsafe(sumText, whereParams)
          : (_sql as any).unsafe(sumText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Number(row?.s ?? 0)
      },
      async max(column: string) {
        const fromIdx = text.indexOf(' FROM ')
        const maxText = fromIdx !== -1
          ? `SELECT MAX(${column}) as m${text.substring(fromIdx)}`
          : `SELECT MAX(${column}) as m FROM ${table}`
        const q = whereParams.length > 0
          ? (_sql as any).unsafe(maxText, whereParams)
          : (_sql as any).unsafe(maxText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row?.m
      },
      async min(column: string) {
        const fromIdx = text.indexOf(' FROM ')
        const minText = fromIdx !== -1
          ? `SELECT MIN(${column}) as m${text.substring(fromIdx)}`
          : `SELECT MIN(${column}) as m FROM ${table}`
        const q = whereParams.length > 0
          ? (_sql as any).unsafe(minText, whereParams)
          : (_sql as any).unsafe(minText)
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return row?.m
      },
      lockForUpdate() {
        built = sql`${built} FOR UPDATE`
        return this as any
      },
      sharedLock() {
        const syntax = config.sql.sharedLockSyntax === 'LOCK IN SHARE MODE' ? sql`LOCK IN SHARE MODE` : sql`FOR SHARE`
        built = sql`${built} ${syntax}`
        return this as any
      },
      withCTE(name: string, sub: any) {
        built = sql`WITH ${sql(name)} AS (${sub.toSQL()}) ${built}`
        return this as any
      },
      withRecursive(name: string, sub: any) {
        built = sql`WITH RECURSIVE ${sql(name)} AS (${sub.toSQL()}) ${built}`
        return this as any
      },
      execute() {
        return runWithHooks<any[]>(built, 'select', { signal: abortSignal, timeoutMs })
      },
      values() {
        return (built as any).values()
      },
      toParams() {
        return (built as any).values?.() ?? []
      },
      raw() {
        return (built as any).raw()
      },
      get rows() {
        return undefined as any
      },
      get row() {
        return undefined as any
      },
      cancel() {
        try {
          (built as any).cancel()
        }
        catch {}
      },

    } as unknown as BaseSelectQueryBuilder<DB, TTable, any, TTable>

    const proxy: any = new Proxy(base as any, {
      get(target, prop: string, receiver) {
        // Prefer explicitly defined methods on the base API
        const existing = Reflect.get(target, prop, receiver)
        if (existing !== undefined)
          return existing
        if (typeof prop === 'string' && (prop.startsWith('where') || prop.startsWith('orWhere') || prop.startsWith('andWhere'))) {
          const isOr = prop.startsWith('orWhere')
          const isAnd = prop.startsWith('andWhere')
          const raw = prop.replace(/^or?where/i, '').replace(/^andwhere/i, '')
          if (!raw)
            return () => receiver
          const lowerFirst = raw.charAt(0).toLowerCase() + raw.slice(1)
          const toSnake = (s: string) => s.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
          const snake = toSnake(raw)
          const tbl = String(table)
          const available: string[] = schema ? Object.keys(((schema as any)[tbl]?.columns) ?? {}) : []
          const chosen = [snake, lowerFirst, lowerFirst.toLowerCase()].find(n => available.includes(n)) ?? snake
          return (value: any) => {
            const expr = Array.isArray(value)
              ? sql`${sql(String(chosen))} IN ${sql(value as any)}`
              : sql`${sql(String(chosen))} = ${value}`
            built = isOr
              ? sql`${built} OR ${expr}`
              : isAnd
                ? sql`${built} AND ${expr}`
                : sql`${built} WHERE ${expr}`
            // update textual representation
            const clause = Array.isArray(value) ? `${String(chosen)} IN (?)` : `${String(chosen)} = ?`
            addWhereText(isOr ? 'OR' : isAnd ? 'AND' : 'WHERE', clause)
            return receiver
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    return proxy as any
  }

  return {
    // Create a builder with per-instance option overrides
    configure(opts: Partial<typeof config>) {
      // This keeps types simple; for now, users can set global config via import
      Object.assign(config, opts)
      return this as any
    },
    /** Escape/validate identifier names (best-effort) */
    id(name: string) {
      if (!SQL_PATTERNS.IDENTIFIER.test(name)) {
        throw new Error(`[query-builder] Invalid identifier: '${name}'. Identifiers must start with a letter or underscore and contain only alphanumeric characters, underscores, and dots.`)
      }
      return _sql(String(name))
    },
    ids(...names: string[]) {
      for (const n of names) {
        if (!SQL_PATTERNS.IDENTIFIER.test(n)) {
          throw new Error(`[query-builder] Invalid identifier: '${n}'. Identifiers must start with a letter or underscore and contain only alphanumeric characters, underscores, and dots.`)
        }
      }
      return _sql(names as any)
    },
    select<TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string>(
      table: TTable,
      ...columns: (K | `${string} as ${string}`)[]
    ): SelectQueryBuilder<DB, TTable, any, TTable> {
      return makeSelect<any>(table, columns as string[]) as unknown as SelectQueryBuilder<DB, TTable, any, TTable>
    },
    selectFrom<TTable extends keyof DB & string>(table: TTable) {
      return makeSelect<TTable>(table)
    },
    selectFromSub(sub, alias) {
      // Create a proper query builder that mimics makeSelect but works with subqueries
      const sql = _sql
      const q = _sql`SELECT * FROM (${sub.toSQL()}) AS ${_sql(alias)}`

      // Build the base API similar to makeSelect
      const base: BaseSelectQueryBuilder<DB, any, any, any> = {
        distinct() {
          const rest = String(q).replace(/^SELECT\s+/i, '')
          const newQ = sql`SELECT DISTINCT ${sql``}${sql(rest)}`
          return createSubQueryBuilder(newQ) as any
        },
        distinctOn(...columns: any[]) {
          const match = /^SELECT\s+(\S+)\s+FROM/i.exec(String(q))
          const body = match ? `${match[1]} FROM` : String(q)
          const newQ = sql`SELECT DISTINCT ON (${sql(columns as any)}) ${sql``}${sql(body)}`
          return createSubQueryBuilder(newQ) as any
        },
        selectRaw(fragment: any) {
          const newQ = sql`${q} , ${fragment}`
          return createSubQueryBuilder(newQ) as any
        },
        where(expr: any, op?: WhereOperator, value?: any) {
          // Apply where condition to the subquery
          const newQ = applyWhereCondition(q, expr, op, value, 'WHERE')
          return createSubQueryBuilder(newQ) as any
        },
        andWhere(expr: any, op?: WhereOperator, value?: any) {
          const newQ = applyWhereCondition(q, expr, op, value, 'AND')
          return createSubQueryBuilder(newQ) as any
        },
        orWhere(expr: any, op?: WhereOperator, value?: any) {
          const newQ = applyWhereCondition(q, expr, op, value, 'OR')
          return createSubQueryBuilder(newQ) as any
        },
        orderBy(column: string, direction: 'asc' | 'desc' = 'asc') {
          const newQ = sql`${q} ORDER BY ${sql(column)} ${direction === 'asc' ? sql`ASC` : sql`DESC`}`
          return createSubQueryBuilder(newQ) as any
        },
        limit(n: number) {
          const newQ = sql`${q} LIMIT ${n}`
          return createSubQueryBuilder(newQ) as any
        },
        offset(n: number) {
          const newQ = sql`${q} OFFSET ${n}`
          return createSubQueryBuilder(newQ) as any
        },
        toSQL() {
          return makeExecutableQuery(q) as any
        },
        async execute() {
          return runWithHooks<any[]>(q, 'select')
        },
        async executeTakeFirst() {
          const rows = await runWithHooks<any[]>(q, 'select')
          return Array.isArray(rows) ? rows[0] : rows
        },
        async get() {
          return runWithHooks<any[]>(q, 'select')
        },
        async first() {
          const rows = await runWithHooks<any[]>(q, 'select')
          return Array.isArray(rows) ? rows[0] : rows
        },
        async firstOrFail() {
          const rows = await runWithHooks<any[]>(q, 'select')
          const first = Array.isArray(rows) ? rows[0] : rows
          if (!first)
            throw new Error('No rows found')
          return first
        },
        async exists() {
          const countQ = sql`SELECT EXISTS(${q}) as exists`
          const result = await runWithHooks<any[]>(countQ, 'select')
          return result?.[0]?.exists === true
        },
        async doesntExist() {
          const exists = await this.exists()
          return !exists
        },
        values() {
          return (q as any).values()
        },
        raw() {
          return (q as any).raw()
        },
        cancel() {
          try {
            ;(q as any).cancel()
          }
          catch {}
        },
        // Add other essential methods as no-ops or basic implementations
        whereRaw: () => this as any,
        whereColumn: () => this as any,
        orWhereColumn: () => this as any,
        whereIn: () => this as any,
        orWhereIn: () => this as any,
        whereNotIn: () => this as any,
        orWhereNotIn: () => this as any,
        whereLike: () => this as any,
        whereILike: () => this as any,
        orWhereLike: () => this as any,
        orWhereILike: () => this as any,
        whereNotLike: () => this as any,
        whereNotILike: () => this as any,
        orWhereNotLike: () => this as any,
        orWhereNotILike: () => this as any,
        whereAny: () => this as any,
        whereAll: () => this as any,
        whereNone: () => this as any,
        whereNested: () => this as any,
        orWhereNested: () => this as any,
        whereDate: () => this as any,
        whereBetween: () => this as any,
        whereNotBetween: () => this as any,
        whereJsonContains: () => this as any,
        whereJsonPath: () => this as any,
        whereNull: () => this as any,
        whereNotNull: () => this as any,
        whereExists: () => this as any,
        whereJsonDoesntContain: () => this as any,
        whereJsonContainsKey: () => this as any,
        whereJsonDoesntContainKey: () => this as any,
        whereJsonLength: () => this as any,
        join: () => this as any,
        joinSub: () => this as any,
        innerJoin: () => this as any,
        leftJoin: () => this as any,
        leftJoinSub: () => this as any,
        rightJoin: () => this as any,
        crossJoin: () => this as any,
        crossJoinSub: () => this as any,
        groupBy: () => this as any,
        groupByRaw: () => this as any,
        having: () => this as any,
        havingRaw: () => this as any,
        addSelect: () => this as any,
        select: () => this as any,
        selectAll: () => this as any,
        orderByDesc: () => this as any,
        inRandomOrder: () => this as any,
        reorder: () => this as any,
        orderByRaw: () => this as any,
        union: () => this as any,
        unionAll: () => this as any,
        forPage: () => this as any,
        selectAllRelations: () => this as any,
        with: () => this as any,
        value: () => Promise.resolve(undefined),
        pluck: () => Promise.resolve([]),
        cursorPaginate: () => Promise.resolve({ data: [], meta: { perPage: 0, nextCursor: null } }),
        paginate: () => Promise.resolve({ data: [], meta: { perPage: 0, page: 1, total: 0, lastPage: 1 } }),
        simplePaginate: () => Promise.resolve({ data: [], meta: { perPage: 0, page: 1, hasMore: false } }),
        chunk: () => Promise.resolve(),
        chunkById: () => Promise.resolve(),
        eachById: () => Promise.resolve(),
        count: () => Promise.resolve(0),
        avg: () => Promise.resolve(0),
        sum: () => Promise.resolve(0),
        max: () => Promise.resolve(null),
        min: () => Promise.resolve(null),
        find: () => Promise.resolve(undefined),
        findOrFail: () => Promise.reject(new Error('Not found')),
        findMany: () => Promise.resolve([]),
        latest: () => this as any,
        oldest: () => this as any,
        lazy: () => (async function* () {})(),
        lazyById: () => (async function* () {})(),
        pipe: (fn: any) => fn(this),
        when: () => this as any,
        tap: () => this as any,
        dump: () => this as any,
        dd: () => { throw new Error('Dump and Die') },
        explain: () => Promise.resolve([]),
        simple: () => (q as any).simple(),
        toText: () => String(q),
        toParams: () => (q as any).values?.() ?? [],
        withTimeout: () => this as any,
        abort: () => this as any,
        lockForUpdate: () => this as any,
        sharedLock: () => this as any,
        withCTE: () => this as any,
        withRecursive: () => this as any,
        cache: () => this as any,
        clone: () => this as any,
        withTrashed: () => this as any,
        onlyTrashed: () => this as any,
        scope: () => this as any,
        // Type-only properties
        get rows() { return [] as any },
        get row() { return undefined as any },
      }

      // Helper function to create a new subquery builder with updated SQL
      function createSubQueryBuilder(newQ: any) {
        return {
          ...base,
          toSQL: () => makeExecutableQuery(newQ) as any,
          execute: () => runWithHooks<any[]>(newQ, 'select'),
          get: () => runWithHooks<any[]>(newQ, 'select'),
          first: async () => {
            const rows = await runWithHooks<any[]>(newQ, 'select')
            return Array.isArray(rows) ? rows[0] : rows
          },
          firstOrFail: async () => {
            const rows = await runWithHooks<any[]>(newQ, 'select')
            const first = Array.isArray(rows) ? rows[0] : rows
            if (!first)
              throw new Error('No rows found')
            return first
          },
          exists: async () => {
            const countQ = sql`SELECT EXISTS(${newQ}) as exists`
            const result = await runWithHooks<any[]>(countQ, 'select')
            return result?.[0]?.exists === true
          },
          doesntExist: async () => {
            const exists = await base.exists()
            return !exists
          },
          values: () => (newQ as any).values(),
          raw: () => (newQ as any).raw(),
          cancel: () => {
            try {
              ;(newQ as any).cancel()
            }
            catch {}
          },
          simple: () => (newQ as any).simple(),
          toText: () => String(newQ),
          toParams: () => (newQ as any).values?.() ?? [],
        }
      }

      // Helper function to apply where conditions
      function applyWhereCondition(query: any, expr: any, op?: WhereOperator, value?: any, prefix: 'WHERE' | 'AND' | 'OR' = 'WHERE') {
        if (typeof expr === 'string' && op !== undefined) {
          const clause = Array.isArray(value) ? `${expr} IN (?)` : `${expr} ${op} ?`
          return sql`${query} ${sql(prefix)} ${sql(clause)}`
        }
        else if (Array.isArray(expr) && expr.length === 3) {
          const [column, operator, val] = expr
          const clause = Array.isArray(val) ? `${column} IN (?)` : `${column} ${operator} ?`
          return sql`${query} ${sql(prefix)} ${sql(clause)}`
        }
        else if (typeof expr === 'object' && expr !== null) {
          const conditions = Object.entries(expr).map(([key, val]) => {
            const clause = Array.isArray(val) ? `${key} IN (?)` : `${key} = ?`
            return sql`${sql(clause)}`
          })
          const combined = conditions.reduce((acc, cond, i) =>
            i === 0 ? cond : sql`${acc} AND ${cond}`,
          )
          return sql`${query} ${sql(prefix)} ${combined}`
        }
        return query
      }

      return base as any
    },
    insertInto<TTable extends keyof DB & string>(table: TTable) {
      let built: any
      let sqlText = ''
      const params: any[] = []

      return {
        values(data: Partial<any> | Partial<any>[]) {
          const rows = Array.isArray(data) ? data : [data]
          const rowCount = rows.length
          if (rowCount === 0) {
            built = (_sql as any).unsafe('SELECT 1')
            return this
          }

          const firstRow = rows[0]
          const keys = Object.keys(firstRow)
          const colCount = keys.length

          // Pre-allocate params array
          const totalParams = rowCount * colCount
          params.length = totalParams

          // Build SQL - optimize for single row case
          const columnList = keys.join(',')

          if (rowCount === 1) {
            // Fast path for single row
            sqlText = `INSERT INTO ${table}(${columnList})VALUES(`
            for (let c = 0; c < colCount; c++) {
              if (c > 0)
                sqlText += ','
              sqlText += `$${c + 1}`
              params[c] = firstRow[keys[c]]
            }
            sqlText += ')'
          }
          else {
            // Multi-row path
            sqlText = `INSERT INTO ${table}(${columnList})VALUES`
            let pidx = 0
            for (let r = 0; r < rowCount; r++) {
              const row = rows[r]
              if (r === 0) {
                sqlText += '('
              }
              else {
                sqlText += '),('
              }

              for (let c = 0; c < colCount; c++) {
                if (c > 0)
                  sqlText += ','
                sqlText += `$${pidx + 1}`
                params[pidx++] = row[keys[c]]
              }
            }
            sqlText += ')'
          }

          built = (_sql as any).unsafe(sqlText, params)
          return this
        },
        returning(...cols: (keyof any & string)[]) {
          const q = _sql`${built} RETURNING ${_sql(cols as any)}`
          return {
            where: () => this,
            andWhere: () => this,
            orWhere: () => this,
            orderBy: () => this,
            limit: () => this,
            offset: () => this,
            toSQL: () => makeExecutableQuery(q, computeSqlText(q)) as any,
            execute: () => runWithHooks<any[]>(q, 'insert'),
          }
        },
        toSQL: () => makeExecutableQuery(built, sqlText) as any,
        execute: () => runWithHooks(built, 'insert'),
      } as any as TypedInsertQueryBuilder<DB, TTable>
    },
    updateTable(table) {
      let built: any
      let sqlText = `UPDATE ${String(table)}`
      const params: any[] = []

      return {
        set(values) {
          const keys = Object.keys(values)
          const len = keys.length
          const setClauses: string[] = Array.from({ length: len })
          for (let i = 0; i < len; i++) {
            const key = keys[i]
            setClauses[i] = `${key} = $${i + 1}`
            params.push((values as any)[key])
          }
          sqlText = `${sqlText} SET ${setClauses.join(', ')}`
          built = (_sql as any).unsafe(sqlText, params)
          return this
        },
        where(expr) {
          // Handle WHERE using the new optimized approach
          if (Array.isArray(expr)) {
            const [col, op, val] = expr
            const paramIndex = params.length + 1
            sqlText = `${sqlText} WHERE ${String(col)} ${String(op)} $${paramIndex}`
            params.push(val)
            built = (_sql as any).unsafe(sqlText, params)
          }
          else if (expr && typeof expr === 'object' && !('raw' in expr)) {
            const keys = Object.keys(expr)
            const len = keys.length
            const baseIdx = params.length
            const conditions: string[] = Array.from({ length: len })
            for (let i = 0; i < len; i++) {
              conditions[i] = `${keys[i]} = $${baseIdx + i + 1}`
              params.push((expr as any)[keys[i]])
            }
            sqlText = `${sqlText} WHERE ${conditions.join(' AND ')}`
            built = (_sql as any).unsafe(sqlText, params)
          }
          return this
        },
        returning(...cols) {
          const q = _sql`${built} RETURNING ${_sql(cols as any)}`
          const obj: any = {
            where: () => obj,
            andWhere: () => obj,
            orWhere: () => obj,
            orderBy: () => obj,
            limit: () => obj,
            offset: () => obj,
            toSQL: () => makeExecutableQuery(q, computeSqlText(q)) as any,
            execute: () => runWithHooks<any[]>(q, 'update'),
          }
          return obj
        },
        toSQL() {
          return makeExecutableQuery(built, sqlText) as any
        },
        execute() {
          return runWithHooks<number>(built, 'update')
        },
      }
    },
    deleteFrom(table) {
      let built = _sql`DELETE FROM ${_sql(String(table))}`
      let whereCondition: any = null
      return {
        where(expr) {
          whereCondition = expr
          built = applyWhere(({} as any), built, expr)
          return this
        },
        returning(...cols) {
          const q = _sql`${built} RETURNING ${_sql(cols as any)}`
          const obj: any = {
            where: () => obj,
            andWhere: () => obj,
            orWhere: () => obj,
            orderBy: () => obj,
            limit: () => obj,
            offset: () => obj,
            toSQL: () => makeExecutableQuery(q, computeSqlText(q)) as any,
            execute: () => runWithHooks<any[]>(q, 'delete'),
          }
          return obj
        },
        toSQL() {
          return makeExecutableQuery(built, computeSqlText(built)) as any
        },
        async execute() {
          try {
            await config.hooks?.beforeDelete?.({ table: String(table), where: whereCondition })
          }
          catch (err) {
            throw err
          }

          const result = await runWithHooks<number>(built, 'delete')

          try {
            await config.hooks?.afterDelete?.({ table: String(table), where: whereCondition, result })
          }
          catch {}

          return result
        },
      }
    },
    table(tableName) {
      const self = this as any
      return {
        insert(data) {
          return self.insertInto(tableName).values(data)
        },
        update(values) {
          return self.updateTable(tableName).set(values)
        },
        delete() {
          return self.deleteFrom(tableName)
        },
        select(...columns) {
          if (columns.length === 0) {
            return self.selectFrom(tableName)
          }
          return self.select(tableName, ...columns)
        },
      }
    },
    sql: _sql,
    raw(strings: TemplateStringsArray, ...values: any[]) {
      return _sql(strings, ...values)
    },
    simple(strings: TemplateStringsArray, ...values: any[]) {
      return (_sql(strings, ...values) as any).simple()
    },
    async advisoryLock(key: number | string): Promise<void> {
      if (config.dialect !== 'postgres')
        return
      const s = String(key)
      let hash = 7
      for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
      const k = typeof key === 'number' ? key : Math.abs(hash)
      const q = bunSql`SELECT pg_advisory_lock(${k})`
      await runWithHooks<any[]>(q, 'raw')
    },
    async tryAdvisoryLock(key: number | string): Promise<boolean> {
      if (config.dialect !== 'postgres')
        return false
      const s = String(key)
      let hash = 7
      for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0
      const k = typeof key === 'number' ? key : Math.abs(hash)
      const q = bunSql`SELECT pg_try_advisory_lock(${k}) as ok`
      const rows = await runWithHooks<any[]>(q, 'raw')
      return Boolean(rows?.[0]?.ok)
    },
    unsafe(query: string, params?: any[]) {
      return (bunSql as any).unsafe(query, params)
    },
    file(path: string, params?: any[]) {
      return (bunSql as any).file(path, params)
    },
    async reserve() {
      const reserved = await (bunSql as any).reserve()
      const qb = createQueryBuilder<DB>({ sql: reserved, meta, schema }) as any
      qb.release = () => reserved.release()
      return qb
    },
    async close(opts?: { timeout?: number }) {
      await (bunSql as any).close(opts)
    },
    async listen(channel: string, handler?: (payload: any) => void) {
      // Placeholder until Bun exposes LISTEN/NOTIFY API. Use a polling fallback or raw SQL when available
      // await (bunSql as any)`LISTEN ${bunSql(channel)}`
      if (handler) {
        // Users can wire their own NOTIFY handling with triggers/server side until native support lands
      }
    },
    async unlisten(_channel?: string) {
      // Placeholder for UNLISTEN channel/all
    },
    async notify(_channel: string, _payload?: any) {
      // Placeholder; when Bun exposes, use NOTIFY channel, 'payload'
      // await (bunSql as any)`NOTIFY ${bunSql(channel)}, ${bunSql(JSON.stringify(payload ?? null))}`
    },
    async copyTo(_queryOrTable: string, _options?: Record<string, any>) {
      // Placeholder for future COPY support
      throw new Error('COPY TO is not yet supported by Bun.sql; placeholder')
    },
    async copyFrom(_queryOrTable: string, _source: AsyncIterable<any> | Iterable<any>, _options?: Record<string, any>) {
      // Placeholder for future COPY support
      throw new Error('COPY FROM is not yet supported by Bun.sql; placeholder')
    },
    async ping() {
      try {
        const q = bunSql`SELECT 1`
        await runWithHooks<any[]>(q, 'select')
        return true
      }
      catch {
        return false
      }
    },
    async waitForReady(opts?: { attempts?: number, delayMs?: number }) {
      const attempts = Math.max(1, opts?.attempts ?? 10)
      const delay = Math.max(10, opts?.delayMs ?? 100)
      for (let i = 0; i < attempts; i++) {
        if (await (this as any).ping())
          return
        await new Promise(resolve => setTimeout(resolve, delay))
      }
      throw new Error('Database not ready after waiting')
    },
    async transaction(fn, options) {
      const defaults = state?.txDefaults
      const opts: TransactionOptions = { ...defaults, ...options }
      const runWith = async (attempt: number): Promise<any> => {
        opts.logger?.({ type: 'start', attempt })
        const start = Date.now()
        return await (bunSql as any).begin(async (tx: any) => {
          const qb = createQueryBuilder<DB>({ sql: tx, meta, schema })
          if (opts?.isolation) {
            const level = opts.isolation
            const lvl = level === 'read committed' ? bunSql`READ COMMITTED` : level === 'repeatable read' ? bunSql`REPEATABLE READ` : bunSql`SERIALIZABLE`
            await (tx as any)`${bunSql`SET TRANSACTION ISOLATION LEVEL`} ${lvl}`.execute()
          }
          if (opts?.readOnly) {
            try {
              await (tx as any)`${bunSql`SET TRANSACTION READ ONLY`}`.execute()
            }
            catch {}
          }
          const res = await fn(qb)
          const durationMs = Date.now() - start
          opts.logger?.({ type: 'commit', attempt, durationMs })
          return res
        })
      }
      const retries = Math.max(0, opts?.retries ?? 0)
      let attempt = 0
      // Retry on common serialization/deadlock errors
      for (;;) {
        try {
          const out = await runWith(attempt + 1)
          opts?.afterCommit?.()
          return out
        }
        catch (err: any) {
          const retriable = isRetriableTxError(err) || matchesSqlState(err, opts.sqlStates)
          if (attempt < retries && retriable) {
            attempt++
            opts?.onRetry?.(attempt, err)
            const delay = computeBackoffMs(attempt, opts.backoff)
            if (delay > 0)
              await sleep(delay)
            continue
          }
          try {
            opts.onRollback?.(err)
          }
          catch {}
          try {
            opts.afterRollback?.()
          }
          catch {}
          throw err
        }
      }
    },
    async savepoint(fn) {
      const s: any = _sql
      if (!s || typeof s.savepoint !== 'function')
        throw new Error('savepoint() must be called inside a transaction')
      return await s.savepoint(async (sp: any) => {
        const qb = createQueryBuilder<DB>({ sql: sp, meta, schema })
        return await fn(qb)
      })
    },
    async beginDistributed(name, fn) {
      const res = await (bunSql as any).beginDistributed(name, async (tx: any) => {
        const qb = createQueryBuilder<DB>({ sql: tx, meta, schema })
        return await fn(qb)
      })
      return res as any
    },
    async commitDistributed(name) {
      await (bunSql as any).commitDistributed(name)
    },
    async rollbackDistributed(name) {
      await (bunSql as any).rollbackDistributed(name)
    },
    setTransactionDefaults(defaults) {
      state = { ...state, txDefaults: { ...state?.txDefaults, ...defaults } }
    },
    transactional(fn, options) {
      return ((...args: unknown[]) => {
        return (this as any).transaction((tx: any) => fn(tx, ...(args as any)), options)
      }) as any
    },
    async insertOrIgnore(table, values) {
      const built = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)} ON CONFLICT DO NOTHING`
      return (built as any).execute()
    },
    async insertGetId(table, values, idColumn = 'id' as any) {
      if (config.dialect === 'mysql') {
        // MySQL doesn't support RETURNING, so we need to insert and then get the last insert ID
        // Use a single query to avoid connection issues
        const insertQuery = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)}`
        const result = await insertQuery.execute()

        // For MySQL, the result should contain the insertId
        if (result && typeof result === 'object' && 'insertId' in result) {
          return result.insertId
        }

        // Fallback: try to get LAST_INSERT_ID() in the same connection
        const [lastIdResult] = await bunSql`SELECT LAST_INSERT_ID() as id`.execute()
        return lastIdResult?.id
      }
      else {
        // PostgreSQL and other databases that support RETURNING
        const q = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)} RETURNING ${bunSql(String(idColumn))} as id`
        const [row] = await q.execute()
        return row?.id
      }
    },
    async updateOrInsert(table, match, values) {
      const whereParts = Object.keys(match).map(k => bunSql`${bunSql(String(k))} = ${bunSql((match as any)[k])}`)
      const existsQ = bunSql`SELECT 1 FROM ${bunSql(String(table))} WHERE ${bunSql(whereParts as any)} LIMIT 1`
      const existsRows = await (existsQ as any).execute()
      if (existsRows.length) {
        const upd = bunSql`UPDATE ${bunSql(String(table))} SET ${bunSql(values as any)} WHERE ${bunSql(whereParts as any)}`
        await (upd as any).execute()
        return true
      }
      else {
        const ins = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql({ ...match, ...values } as any)}`
        await (ins as any).execute()
        return true
      }
    },
    async upsert(table, rows, conflictColumns, mergeColumns) {
      const targetCols = conflictColumns.map(c => String(c))
      const setCols = (mergeColumns ?? []).map(c => String(c))
      const built = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(rows as any)} ON CONFLICT (${bunSql(targetCols as any)}) DO UPDATE SET ${bunSql(setCols.reduce((acc, c) => ({ ...acc, [c]: (bunSql as any)(`EXCLUDED.${c}`) }), {}))}`
      return (built as any).execute()
    },
    async save(table, values) {
      const pk = meta?.primaryKeys[String(table)] ?? 'id'
      const id = (values as any)[pk]
      if (id != null) {
        // First check if the row exists
        const existingRow = await (this as any).selectFrom(table).find(id)

        if (existingRow) {
          // Row exists, update it
          await (this as any).updateTable(table).set(values as any).where({ [pk]: id } as any).execute()

          // Retrieve the updated row
          const updatedRow = await (this as any).selectFrom(table).find(id)
          if (!updatedRow)
            throw new Error('save() failed to retrieve updated row')
          return updatedRow
        }
        else {
          // Row doesn't exist, create it
          return await (this as any).create(table, values)
        }
      }
      return await (this as any).create(table, values)
    },
    async remove(table, id) {
      return await (this as any).deleteFrom(table).where({ id } as any).execute()
    },
    async find(table, id) {
      return await (this as any).selectFrom(table).find(id)
    },
    async findOrFail(table, id) {
      return await (this as any).selectFrom(table).findOrFail(id)
    },
    async findMany(table, ids) {
      return await (this as any).selectFrom(table).findMany(ids)
    },
    async latest(table, column) {
      return await (this as any).selectFrom(table).latest(column as any).first()
    },
    async oldest(table, column) {
      return await (this as any).selectFrom(table).oldest(column as any).first()
    },
    skip(table, count) {
      return (this as any).selectFrom(table).offset(count)
    },
    async rawQuery(query: string) {
      const start = Date.now()
      try {
        config.hooks?.onQueryStart?.({ sql: query, kind: 'raw' })
        const res = await (bunSql as any).unsafe(query)
        config.hooks?.onQueryEnd?.({ sql: query, durationMs: Date.now() - start, kind: 'raw' })
        return res
      }
      catch (err) {
        config.hooks?.onQueryError?.({ sql: query, error: err, durationMs: Date.now() - start, kind: 'raw' })
        throw err
      }
    },
    async create(table, values) {
      const pk = meta?.primaryKeys[String(table)] ?? 'id'

      // beforeCreate hook
      try {
        await config.hooks?.beforeCreate?.({ table: String(table), data: values })
      }
      catch (err) {
        throw err
      }

      if (config.dialect === 'postgres') {
        // For PostgreSQL, use RETURNING to get the ID, then fetch the full row
        const q = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)} RETURNING ${bunSql(String(pk))} as id`
        const [result] = await q.execute()

        console.log('resultId', result)

        if (!result?.id) {
          console.error(`create() failed to get insert ID for table ${String(table)}`)
          console.error('Inserted values:', values)
          throw new Error(`create() failed to get insert ID for table ${String(table)}`)
        }

        const row = await (this as any).selectFrom(table).find(result.id)

        if (!row) {
          console.error(`create() failed to retrieve inserted row for table ${String(table)} with id ${result.id}`)
          console.error('Inserted values:', values)
          throw new Error(`create() failed to retrieve inserted row for table ${String(table)} with id ${result.id}`)
        }

        // afterCreate hook
        try {
          await config.hooks?.afterCreate?.({ table: String(table), data: values, result: row })
        }
        catch {}

        return row
      }
      else {
        // For MySQL and other databases
        const id = await (this as any).insertGetId(table, values, pk)

        if (id == null) {
          throw new Error(`create() failed to get insert ID for table ${String(table)}`)
        }

        const row = await (this as any).selectFrom(table).find(id)

        if (!row) {
          console.error(`create() failed to retrieve inserted row for table ${String(table)} with id ${id}`)
          console.error('Inserted values:', values)
          throw new Error(`create() failed to retrieve inserted row for table ${String(table)} with id ${id}`)
        }

        // afterCreate hook
        try {
          await config.hooks?.afterCreate?.({ table: String(table), data: values, result: row })
        }
        catch {}

        return row
      }
    },
    async createMany(table, rows) {
      if (!rows?.length)
        return

      const firstRow = rows[0]
      const keys = Object.keys(firstRow)
      const colCount = keys.length
      const rowCount = rows.length
      const params = Array.from({ length: rowCount * colCount })

      let sql = `INSERT INTO ${table}(${keys.join(',')})VALUES`
      let pidx = 0
      for (let r = 0; r < rowCount; r++) {
        if (r > 0)
          sql += ','
        sql += '('
        const row = rows[r]
        for (let c = 0; c < colCount; c++) {
          if (c > 0)
            sql += ','
          sql += `$${pidx + 1}`
          params[pidx++] = row[keys[c]]
        }
        sql += ')'
      }

      return (_sql as any).unsafe(sql, params).execute()
    },
    async insertMany(table, rows) {
      if (!rows?.length)
        return

      const firstRow = rows[0]
      const keys = Object.keys(firstRow)
      const colCount = keys.length
      const rowCount = rows.length
      const params = Array.from({ length: rowCount * colCount })

      // Build SQL
      let sql = `INSERT INTO ${table}(${keys.join(',')})VALUES`
      let pidx = 0
      for (let r = 0; r < rowCount; r++) {
        const row = rows[r]
        sql += r > 0 ? '),(' : '('
        for (let c = 0; c < colCount; c++) {
          sql += c > 0 ? ',$' : '$'
          sql += pidx + 1
          params[pidx++] = row[keys[c]]
        }
      }
      sql += ')'

      return (_sql as any).unsafe(sql, params).execute()
    },
    async updateMany(table, conditions, data) {
      // Ultra-optimized direct SQL construction
      const dataKeys = Object.keys(data)
      const dataLen = dataKeys.length
      if (dataLen === 0)
        return 0

      const params: any[] = []

      // Build SET clause using array join
      const setClauses: string[] = Array.from({ length: dataLen })
      for (let i = 0; i < dataLen; i++) {
        setClauses[i] = `${dataKeys[i]}=$${i + 1}`
        params.push((data as any)[dataKeys[i]])
      }

      let sql = `UPDATE ${table} SET ${setClauses.join(',')}`

      // Build WHERE clause
      if (Array.isArray(conditions)) {
        sql += ` WHERE ${conditions[0]}${conditions[1]}$${params.length + 1}`
        params.push(conditions[2])
      }
      else if (conditions && typeof conditions === 'object' && !('raw' in conditions)) {
        const condKeys = Object.keys(conditions)
        const condLen = condKeys.length
        if (condLen > 0) {
          const baseIdx = params.length
          const whereClauses: string[] = Array.from({ length: condLen })
          for (let i = 0; i < condLen; i++) {
            whereClauses[i] = `${condKeys[i]}=$${baseIdx + i + 1}`
            params.push((conditions as any)[condKeys[i]])
          }
          sql += ` WHERE ${whereClauses.join(' AND ')}`
        }
      }

      return (_sql as any).unsafe(sql, params).execute()
    },
    async deleteMany(table, ids) {
      if (!Array.isArray(ids) || ids.length === 0)
        return 0
      const pk = meta?.primaryKeys[String(table)] ?? 'id'
      return await (this as any).deleteFrom(table).where([pk, 'in', ids] as any).execute()
    },
    async firstOrCreate(table, match, defaults) {
      const existing = await (this as any).selectFrom(table).where(match as any).first()
      if (existing)
        return existing
      return await (this as any).create(table, { ...(match as any), ...(defaults as any) })
    },
    async updateOrCreate(table, match, values) {
      const existing = await (this as any).selectFrom(table).where(match as any).first()
      if (existing) {
        await (this as any).updateTable(table).set(values as any).where(match as any).execute()
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        const id = (existing as any)[pk]
        const refreshed = id != null
          ? await (this as any).selectFrom(table).find(id)
          : await (this as any).selectFrom(table).where(match as any).first()
        if (!refreshed)
          throw new Error('updateOrCreate() failed to retrieve updated row')
        return refreshed
      }
      return await (this as any).create(table, { ...(match as any), ...(values as any) })
    },
    async count(table, column) {
      const col = column ? bunSql(String(column)) : bunSql`*`
      const q = bunSql`SELECT COUNT(${col}) as c FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.c ?? 0) as any)
    },
    async sum(table, column) {
      const q = bunSql`SELECT SUM(${bunSql(String(column))}) as s FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.s ?? 0) as any)
    },
    async avg(table, column) {
      const q = bunSql`SELECT AVG(${bunSql(String(column))}) as a FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return Number((row?.a ?? 0) as any)
    },
    async min(table, column) {
      const q = bunSql`SELECT MIN(${bunSql(String(column))}) as m FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return (row?.m as any)
    },
    async max(table, column) {
      const q = bunSql`SELECT MAX(${bunSql(String(column))}) as m FROM ${bunSql(String(table))}`
      const [row] = await (q as any).execute()
      return (row?.m as any)
    },
    /**
     * Get all relationships defined for a table
     */
    getRelationships(table: string) {
      if (!meta?.relations)
        return {}
      const tableRels = meta.relations[table]
      if (!tableRels)
        return {}

      const result: Record<string, any> = {}
      for (const [type, relations] of Object.entries(tableRels)) {
        if (relations && typeof relations === 'object' && Object.keys(relations).length > 0) {
          result[type] = relations
        }
      }
      return result
    },
    /**
     * Check if a table has a specific relationship
     */
    hasRelationship(table: string, relationName: string): boolean {
      if (!meta?.relations)
        return false
      const rels = meta.relations[table]
      if (!rels)
        return false

      return Object.values(rels).some(
        relMap => relMap && typeof relMap === 'object' && relationName in relMap,
      )
    },
    /**
     * Get the type of a relationship
     */
    getRelationshipType(table: string, relationName: string): string | null {
      if (!meta?.relations)
        return null
      const rels = meta.relations[table]
      if (!rels)
        return null

      for (const [_type, relMap] of Object.entries(rels)) {
        if (relMap && typeof relMap === 'object' && relationName in relMap) {
          return _type
        }
      }
      return null
    },
    /**
     * Get the target table of a relationship
     */
    getRelationshipTarget(table: string, relationName: string): string | null {
      if (!meta?.relations)
        return null
      const rels = meta.relations[table]
      if (!rels)
        return null

      for (const [_type, relMap] of Object.entries(rels)) {
        if (relMap && typeof relMap === 'object' && relationName in relMap) {
          const targetModel = (relMap as any)[relationName]
          if (typeof targetModel === 'string') {
            return meta.modelToTable[targetModel] || targetModel
          }
          else if (targetModel && typeof targetModel === 'object' && 'target' in targetModel) {
            return meta.modelToTable[targetModel.target] || targetModel.target
          }
        }
      }
      return null
    },

  }
}

/**
 * # `clearQueryCache()`
 *
 * Clears all cached query results.
 *
 * @example
 * ```ts
 * clearQueryCache()
 * ```
 */
export function clearQueryCache(): void {
  queryCache.clear()
}

/**
 * # `setQueryCacheMaxSize(size)`
 *
 * Sets the maximum number of cached queries (default 100).
 *
 * @example
 * ```ts
 * setQueryCacheMaxSize(500)
 * ```
 */
export function setQueryCacheMaxSize(size: number): void {
  queryCache.setMaxSize(size)
}
