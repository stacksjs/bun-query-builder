import type { SchemaMeta } from './meta'
import type { DatabaseSchema } from './schema'
import { sql as bunSql } from 'bun'
import { config } from './config'

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

function applyWhere(columns: Record<string, unknown>, q: any, expr?: WhereExpression<any>) {
  if (!expr)
    return q
  if (Array.isArray(expr)) {
    const [col, op, val] = expr
    switch (op) {
      case 'in':
        return bunSql`${q} WHERE ${bunSql(String(col))} IN ${bunSql(val as any)}`
      case 'not in':
        return bunSql`${q} WHERE ${bunSql(String(col))} NOT IN ${bunSql(val as any)}`
      case 'like':
        return bunSql`${q} WHERE ${bunSql(String(col))} LIKE ${val as any}`
      case 'is':
        return bunSql`${q} WHERE ${bunSql(String(col))} IS ${val as any}`
      case 'is not':
        return bunSql`${q} WHERE ${bunSql(String(col))} IS NOT ${val as any}`
      case '!=':
        return bunSql`${q} WHERE ${bunSql(String(col))} <> ${val as any}`
      case '<':
      case '>':
      case '<=':
      case '>=':
      case '=':
      default:
        return bunSql`${q} WHERE ${bunSql(String(col))} ${op} ${val as any}`
    }
  }
  if ('raw' in (expr as any)) {
    return bunSql`${q} WHERE ${(expr as WhereRaw).raw}`
  }
  const parts: any[] = []
  for (const key of Object.keys(expr)) {
    const value = (expr as any)[key]
    if (Array.isArray(value))
      parts.push(bunSql`${bunSql(key)} IN ${bunSql(value)}`)
    else parts.push(bunSql`${bunSql(key)} = ${value}`)
  }
  if (parts.length === 0)
    return q
  return bunSql`${q} WHERE ${parts.reduce((acc, p, i) => (i === 0 ? p : bunSql`${acc} AND ${p}`))}`
}

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
  const _sql = state?.sql ?? bunSql
  const meta = state?.meta
  const schema = state?.schema

  function computeSqlText(q: any): string {
    const prev = config.debug?.captureText
    if (config.debug)
      config.debug.captureText = true
    const s = String(q)
    if (config.debug)
      config.debug.captureText = prev as boolean
    return s
  }

  function runWithHooks<T = any>(q: any, kind: 'select' | 'insert' | 'update' | 'delete' | 'raw', opts?: { signal?: AbortSignal, timeoutMs?: number }) {
    const text = computeSqlText(q)
    const hooks = config.hooks
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

    const execPromise = (q as any).execute() as Promise<any>

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
        return rows as T
      })
      .catch((err) => {
        clearTimeout(timeoutId)
        finish(err)
        throw err
      })
  }

  function makeExecutableQuery(q: any, text?: string) {
    return {
      toString: () => (text ?? computeSqlText(q)),
      execute: () => (q as any).execute(),
      values: () => (q as any).values(),
      raw: () => (q as any).raw(),
    }
  }

  function makeSelect<TTable extends keyof DB & string>(table: TTable): TypedSelectQueryBuilder<DB, TTable, any, TTable, `SELECT * FROM ${TTable}`>
  function makeSelect<TTable extends keyof DB & string>(table: TTable, columns: string[]): TypedSelectQueryBuilder<DB, TTable, any, TTable, `SELECT ${string} FROM ${TTable}`>
  function makeSelect<TTable extends keyof DB & string>(table: TTable, columns?: string[]): any {
    let built = (columns && columns.length > 0)
      ? bunSql`SELECT ${bunSql(columns as any)} FROM ${bunSql(String(table))}`
      : bunSql`SELECT * FROM ${bunSql(String(table))}`
    // Maintain lightweight textual representation for tests/debugging
    let text = (columns && columns.length > 0)
      ? `SELECT ${columns.join(', ')} FROM ${String(table)}`
      : `SELECT * FROM ${String(table)}`
    const addWhereText = (prefix: 'WHERE' | 'AND' | 'OR', clause: string) => {
      const hasWhere = /\bWHERE\b/i.test(text)
      const p = hasWhere ? prefix : 'WHERE'
      text = `${text} ${p} ${clause}`
    }

    const joinedTables = new Set<string>()
    let timeoutMs: number | undefined
    let abortSignal: AbortSignal | undefined
    let includeTrashed = false
    let onlyTrashed = false

    // Build the base API; then wrap with a proxy that exposes dynamic where/orWhere/andWhere methods

    const base: BaseSelectQueryBuilder<DB, TTable, any, TTable> = {
      distinct() {
        const rest = String(built).replace(/^SELECT\s+/i, '')
        built = bunSql`SELECT DISTINCT ${bunSql``}${bunSql(rest)}`
        return this as any
      },
      distinctOn(...columns: any[]) {
        const match = /^SELECT\s+(\S+)\s+FROM/i.exec(String(built))
        const body = match ? `${match[1]} FROM` : String(built)
        built = bunSql`SELECT DISTINCT ON (${bunSql(columns as any)}) ${bunSql``}${bunSql(body)}`
        return this as any
      },
      selectRaw(fragment: any) {
        built = bunSql`${built} , ${fragment}`
        return this as any
      },
      rowNumber(alias = 'row_number', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const parts: any[] = []
        if (partitionBy) {
          const cols = Array.isArray(partitionBy) ? partitionBy : [partitionBy]
          parts.push(bunSql`PARTITION BY ${bunSql(cols as any)}`)
        }
        if (orderBy && orderBy.length) {
          const ob = orderBy.map(([c, d]) => bunSql`${bunSql(c)} ${d === 'desc' ? bunSql`DESC` : bunSql`ASC`}`)
          const expr = ob.reduce((acc, p, i) => (i === 0 ? p : bunSql`${acc}, ${p}`))
          parts.push(bunSql`ORDER BY ${expr}`)
        }
        const over = parts.length ? bunSql`OVER (${bunSql(parts as any)})` : bunSql`OVER ()`
        built = bunSql`${built} , ROW_NUMBER() ${over} AS ${bunSql(alias)}`
        return this as any
      },
      denseRank(alias = 'dense_rank', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const cols = Array.isArray(partitionBy) ? partitionBy : (partitionBy ? [partitionBy] : [])
        const parts: any[] = []
        if (cols.length)
          parts.push(bunSql`PARTITION BY ${bunSql(cols as any)}`)
        if (orderBy && orderBy.length) {
          const ob = orderBy.map(([c, d]) => bunSql`${bunSql(c)} ${d === 'desc' ? bunSql`DESC` : bunSql`ASC`}`)
          const expr = ob.reduce((acc, p, i) => (i === 0 ? p : bunSql`${acc}, ${p}`))
          parts.push(bunSql`ORDER BY ${expr}`)
        }
        const over = parts.length ? bunSql`OVER (${bunSql(parts as any)})` : bunSql`OVER ()`
        built = bunSql`${built} , DENSE_RANK() ${over} AS ${bunSql(alias)}`
        return this as any
      },
      rank(alias = 'rank', partitionBy?: string | string[], orderBy?: [string, 'asc' | 'desc'][]) {
        const cols = Array.isArray(partitionBy) ? partitionBy : (partitionBy ? [partitionBy] : [])
        const parts: any[] = []
        if (cols.length)
          parts.push(bunSql`PARTITION BY ${bunSql(cols as any)}`)
        if (orderBy && orderBy.length) {
          const ob = orderBy.map(([c, d]) => bunSql`${bunSql(c)} ${d === 'desc' ? bunSql`DESC` : bunSql`ASC`}`)
          const expr = ob.reduce((acc, p, i) => (i === 0 ? p : bunSql`${acc}, ${p}`))
          parts.push(bunSql`ORDER BY ${expr}`)
        }
        const over = parts.length ? bunSql`OVER (${bunSql(parts as any)})` : bunSql`OVER ()`
        built = bunSql`${built} , RANK() ${over} AS ${bunSql(alias)}`
        return this as any
      },
      selectAll() {
        return this as any
      },
      addSelect(...columns: string[]) {
        if (!columns.length)
          return this as any
        // inject additional columns into SELECT list
        const body = String(built).replace(/^SELECT\s+/i, '')
        built = bunSql`SELECT ${bunSql(columns as any)} , ${bunSql(body)} `
        return this as any
      },
      with(...relations: string[]) {
        if (!meta || relations.length === 0)
          return this as any
        const parentTable = String(table)

        const singularize = (name: string) => {
          if (config.relations.singularizeStrategy === 'none')
            return name
          return name.endsWith('s') ? name.slice(0, -1) : name
        }

        const addJoin = (fromTable: string, relationKey: string) => {
          const rels = meta.relations?.[fromTable]
          const resolveTarget = (): string | undefined => {
            const pick = (m?: Record<string, string>) => {
              const modelName = m?.[relationKey]
              return modelName ? meta.modelToTable[modelName] : undefined
            }
            return pick(rels?.hasOne) || pick(rels?.hasMany) || pick(rels?.belongsTo) || pick(rels?.belongsToMany)
          }
          const targetTable = resolveTarget() ?? (meta.modelToTable[relationKey] || meta.tableToModel[relationKey] ? (meta.modelToTable[relationKey] ?? relationKey) : relationKey)
          const childTable = String(targetTable)
          if (!childTable || childTable === fromTable)
            return fromTable

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
            built = bunSql`${built} LEFT JOIN ${bunSql(pivot)} ON ${bunSql(`${pivot}.${fkA}`)} = ${bunSql(`${fromTable}.${fromPk}`)} LEFT JOIN ${bunSql(childTable)} ON ${bunSql(`${childTable}.${childPk}`)} = ${bunSql(`${pivot}.${fkB}`)}`
            joinedTables.add(pivot)
            joinedTables.add(childTable)
            return childTable
          }

          // belongsTo: parent has fk to child
          const isBt = Boolean(rels?.belongsTo?.[relationKey])
          if (isBt) {
            const fkInParent = `${singularize(childTable)}_id`
            const childPk = meta.primaryKeys[childTable] ?? 'id'
            built = bunSql`${built} LEFT JOIN ${bunSql(childTable)} ON ${bunSql(`${fromTable}.${fkInParent}`)} = ${bunSql(`${childTable}.${childPk}`)}`
            joinedTables.add(childTable)
            return childTable
          }

          // hasOne/hasMany: child has fk to parent
          const fkInChild = `${singularize(fromTable)}_id`
          const pk = meta.primaryKeys[fromTable] ?? 'id'
          built = bunSql`${built} LEFT JOIN ${bunSql(childTable)} ON ${bunSql(`${childTable}.${fkInChild}`)} = ${bunSql(`${fromTable}.${pk}`)}`
          joinedTables.add(childTable)
          return childTable
        }

        for (const rel of relations) {
          const parts = rel.split('.')
          let from = parentTable
          for (const part of parts) {
            const next = addJoin(from, part) || from
            from = next
          }
        }
        return this as any
      },
      where(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          built = applyWhere(({} as any), built, [expr, op, value])
          try {
            addWhereText('WHERE', `${String(expr)} ${String(op).toUpperCase()} ?`)
          }
          catch {}
          return this
        }
        built = applyWhere(({} as any), built, expr)
        // best-effort textual representation for common shapes
        try {
          if (Array.isArray(expr)) {
            const [col, op] = expr as [string, string, any]
            const opText = String(op).toUpperCase().replace('NOT IN', 'NOT IN').replace('IN', 'IN')
            addWhereText('WHERE', `${String(col)} ${opText} ?`)
          }
          else if (expr && typeof expr === 'object' && !('raw' in expr)) {
            const parts: string[] = []
            for (const k of Object.keys(expr)) {
              const v: any = (expr as any)[k]
              parts.push(Array.isArray(v) ? `${k} IN (?)` : `${k} = ?`)
            }
            if (parts.length)
              addWhereText('WHERE', parts.join(' AND '))
          }
          else if (expr && typeof (expr as any).raw !== 'undefined') {
            addWhereText('WHERE', '[raw]')
          }
        }
        catch {}
        return this
      },
      // where helpers
      whereNull(column: string) {
        built = bunSql`${built} WHERE ${bunSql(String(column))} IS NULL`
        return this
      },
      whereNotNull(column: string) {
        built = bunSql`${built} WHERE ${bunSql(String(column))} IS NOT NULL`
        return this
      },
      whereBetween(column: string, start: any, end: any) {
        built = bunSql`${built} WHERE ${bunSql(String(column))} BETWEEN ${start} AND ${end}`
        return this
      },
      whereExists(subquery: { toSQL: () => any }) {
        built = bunSql`${built} WHERE EXISTS (${subquery.toSQL()})`
        return this
      },
      whereJsonContains(column: string, json: unknown) {
        built = bunSql`${built} WHERE ${bunSql(String(column))} @> ${bunSql(JSON.stringify(json))}`
        addWhereText('WHERE', `${String(column)} @> ?`)
        return this as any
      },
      whereJsonPath(path: string, op: WhereOperator, value: any) {
        const dialect = config.dialect
        if (dialect === 'postgres') {
          built = bunSql`${built} WHERE ${bunSql(path)} ${op} ${value}`
        }
        else if (dialect === 'mysql') {
          built = bunSql`${built} WHERE JSON_EXTRACT(${bunSql(path)}) ${op} ${value}`
        }
        else {
          built = bunSql`${built} WHERE json_extract(${bunSql(path)}) ${op} ${value}`
        }
        return this as any
      },
      whereLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? bunSql`${bunSql(String(column))} LIKE ${pattern}` : bunSql`LOWER(${bunSql(String(column))}) LIKE LOWER(${pattern})`
        built = bunSql`${built} WHERE ${expr}`
        addWhereText('WHERE', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} LIKE ${caseSensitive ? '?' : 'LOWER(?)'}`)
        return this as any
      },
      whereILike(column: string, pattern: string) {
        if (config.dialect === 'postgres') {
          built = bunSql`${built} WHERE ${bunSql(String(column))} ILIKE ${pattern}`
          addWhereText('WHERE', `${String(column)} ILIKE ?`)
        }
        else {
          const expr = bunSql`LOWER(${bunSql(String(column))}) LIKE LOWER(${pattern})`
          built = bunSql`${built} WHERE ${expr}`
          addWhereText('WHERE', `LOWER(${String(column)}) LIKE LOWER(?)`)
        }
        return this as any
      },
      orWhereLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? bunSql`${bunSql(String(column))} LIKE ${pattern}` : bunSql`LOWER(${bunSql(String(column))}) LIKE LOWER(${pattern})`
        built = bunSql`${built} OR ${expr}`
        addWhereText('OR', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} LIKE ${caseSensitive ? '?' : 'LOWER(?)'}`)
        return this as any
      },
      orWhereILike(column: string, pattern: string) {
        if (config.dialect === 'postgres') {
          built = bunSql`${built} OR ${bunSql(String(column))} ILIKE ${pattern}`
          addWhereText('OR', `${String(column)} ILIKE ?`)
        }
        else {
          const expr = bunSql`LOWER(${bunSql(String(column))}) LIKE LOWER(${pattern})`
          built = bunSql`${built} OR ${expr}`
          addWhereText('OR', `LOWER(${String(column)}) LIKE LOWER(?)`)
        }
        return this as any
      },
      whereNotLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? bunSql`${bunSql(String(column))} NOT LIKE ${pattern}` : bunSql`LOWER(${bunSql(String(column))}) NOT LIKE LOWER(${pattern})`
        built = bunSql`${built} WHERE ${expr}`
        addWhereText('WHERE', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} NOT LIKE ${caseSensitive ? '?' : 'LOWER(?)'}`)
        return this as any
      },
      whereNotILike(column: string, pattern: string) {
        if (config.dialect === 'postgres') {
          built = bunSql`${built} WHERE ${bunSql(String(column))} NOT ILIKE ${pattern}`
          addWhereText('WHERE', `${String(column)} NOT ILIKE ?`)
        }
        else {
          const expr = bunSql`LOWER(${bunSql(String(column))}) NOT LIKE LOWER(${pattern})`
          built = bunSql`${built} WHERE ${expr}`
          addWhereText('WHERE', `LOWER(${String(column)}) NOT LIKE LOWER(?)`)
        }
        return this as any
      },
      orWhereNotLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? bunSql`${bunSql(String(column))} NOT LIKE ${pattern}` : bunSql`LOWER(${bunSql(String(column))}) NOT LIKE LOWER(${pattern})`
        built = bunSql`${built} OR ${expr}`
        addWhereText('OR', `${caseSensitive ? String(column) : `LOWER(${String(column)})`} NOT LIKE ${caseSensitive ? '?' : 'LOWER(?)'}`)
        return this as any
      },
      orWhereNotILike(column: string, pattern: string) {
        if (config.dialect === 'postgres') {
          built = bunSql`${built} OR ${bunSql(String(column))} NOT ILIKE ${pattern}`
          addWhereText('OR', `${String(column)} NOT ILIKE ?`)
        }
        else {
          const expr = bunSql`LOWER(${bunSql(String(column))}) NOT LIKE LOWER(${pattern})`
          built = bunSql`${built} OR ${expr}`
          addWhereText('OR', `LOWER(${String(column)}) NOT LIKE LOWER(?)`)
        }
        return this as any
      },
      whereAny(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0)
          return this as any
        const parts = cols.map(c => bunSql`${bunSql(String(c))} ${op} ${value}`)
        const expr = parts.reduce((acc, p, i) => (i === 0 ? p : bunSql`${acc} OR ${p}`))
        built = bunSql`${built} WHERE (${expr})`
        return this as any
      },
      whereAll(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0)
          return this as any
        const parts = cols.map(c => bunSql`${bunSql(String(c))} ${op} ${value}`)
        const expr = parts.reduce((acc, p, i) => (i === 0 ? p : bunSql`${acc} AND ${p}`))
        built = bunSql`${built} WHERE (${expr})`
        return this as any
      },
      whereNone(cols: string[], op: WhereOperator, value: any) {
        if (cols.length === 0)
          return this as any
        const parts = cols.map(c => bunSql`${bunSql(String(c))} ${op} ${value}`)
        const expr = parts.reduce((acc, p, i) => (i === 0 ? p : bunSql`${acc} OR ${p}`))
        built = bunSql`${built} WHERE NOT (${expr})`
        return this as any
      },
      whereNotBetween(column: string, start: any, end: any) {
        built = bunSql`${built} WHERE ${bunSql(String(column))} NOT BETWEEN ${start} AND ${end}`
        return this as any
      },
      whereDate(column: string, op: WhereOperator, date: string | Date) {
        built = bunSql`${built} WHERE ${bunSql(String(column))} ${op} ${bunSql(String(date))}`
        return this as any
      },
      whereRaw(fragment: any) {
        built = bunSql`${built} WHERE ${fragment}`
        return this as any
      },
      whereColumn(left: string, op: WhereOperator, right: string) {
        built = bunSql`${built} WHERE ${bunSql(left)} ${op} ${bunSql(right)}`
        return this as any
      },
      orWhereColumn(left: string, op: WhereOperator, right: string) {
        built = bunSql`${built} OR ${bunSql(left)} ${op} ${bunSql(right)}`
        return this as any
      },
      whereIn(column: string, values: any[] | { toSQL: () => any }) {
        const v = Array.isArray(values) ? bunSql(values as any) : bunSql`(${(values as any).toSQL()})`
        built = bunSql`${built} WHERE ${bunSql(String(column))} IN ${v}`
        return this as any
      },
      orWhereIn(column: string, values: any[] | { toSQL: () => any }) {
        const v = Array.isArray(values) ? bunSql(values as any) : bunSql`(${(values as any).toSQL()})`
        built = bunSql`${built} OR ${bunSql(String(column))} IN ${v}`
        return this as any
      },
      whereNotIn(column: string, values: any[] | { toSQL: () => any }) {
        const v = Array.isArray(values) ? bunSql(values as any) : bunSql`(${(values as any).toSQL()})`
        built = bunSql`${built} WHERE ${bunSql(String(column))} NOT IN ${v}`
        return this as any
      },
      orWhereNotIn(column: string, values: any[] | { toSQL: () => any }) {
        const v = Array.isArray(values) ? bunSql(values as any) : bunSql`(${(values as any).toSQL()})`
        built = bunSql`${built} OR ${bunSql(String(column))} NOT IN ${v}`
        return this as any
      },
      whereNested(fragment: any) {
        built = bunSql`${built} WHERE (${fragment.toSQL ? fragment.toSQL() : fragment})`
        return this as any
      },
      orWhereNested(fragment: any) {
        built = bunSql`${built} OR (${fragment.toSQL ? fragment.toSQL() : fragment})`
        return this as any
      },
      andWhere(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          built = bunSql`${built} AND ${applyWhere(({} as any), bunSql``, [expr, op, value])}`
          try {
            addWhereText('AND', `${String(expr)} ${String(op).toUpperCase()} ?`)
          }
          catch {}
          return this
        }
        built = bunSql`${built} AND ${applyWhere(({} as any), bunSql``, expr)}`
        try {
          if (Array.isArray(expr)) {
            const [col, op] = expr as [string, string, any]
            addWhereText('AND', `${String(col)} ${String(op).toUpperCase()} ?`)
          }
          else if (expr && typeof expr === 'object' && !('raw' in expr)) {
            const parts: string[] = []
            for (const k of Object.keys(expr)) {
              const v: any = (expr as any)[k]
              parts.push(Array.isArray(v) ? `${k} IN (?)` : `${k} = ?`)
            }
            if (parts.length)
              addWhereText('AND', parts.join(' AND '))
          }
          else if (expr && typeof (expr as any).raw !== 'undefined') {
            addWhereText('AND', '[raw]')
          }
        }
        catch {}
        return this
      },
      orWhere(expr: any, op?: WhereOperator, value?: any) {
        if (typeof expr === 'string' && op !== undefined) {
          built = bunSql`${built} OR ${applyWhere(({} as any), bunSql``, [expr, op, value])}`
          try {
            addWhereText('OR', `${String(expr)} ${String(op).toUpperCase()} ?`)
          }
          catch {}
          return this
        }
        built = bunSql`${built} OR ${applyWhere(({} as any), bunSql``, expr)}`
        try {
          if (Array.isArray(expr)) {
            const [col, op] = expr as [string, string, any]
            addWhereText('OR', `${String(col)} ${String(op).toUpperCase()} ?`)
          }
          else if (expr && typeof expr === 'object' && !('raw' in expr)) {
            const parts: string[] = []
            for (const k of Object.keys(expr)) {
              const v: any = (expr as any)[k]
              parts.push(Array.isArray(v) ? `${k} IN (?)` : `${k} = ?`)
            }
            if (parts.length)
              addWhereText('OR', parts.join(' AND '))
          }
          else if (expr && typeof (expr as any).raw !== 'undefined') {
            addWhereText('OR', '[raw]')
          }
        }
        catch {}
        return this
      },
      orderBy(column: string, direction: 'asc' | 'desc' = 'asc') {
        built = bunSql`${built} ORDER BY ${bunSql(String(column))} ${direction === 'asc' ? bunSql`ASC` : bunSql`DESC`}`
        return this
      },
      orderByDesc(column: string) {
        built = bunSql`${built} ORDER BY ${bunSql(String(column))} DESC`
        return this as any
      },
      inRandomOrder() {
        const rnd = config.sql.randomFunction === 'RAND()' ? bunSql`RAND()` : bunSql`RANDOM()`
        built = bunSql`${built} ORDER BY ${rnd}`
        return this as any
      },
      reorder(column: string, direction: 'asc' | 'desc' = 'asc') {
        built = bunSql`${bunSql(String(built).replace(/ORDER BY[\s\S]*$/i, ''))} ORDER BY ${bunSql(column)} ${direction === 'asc' ? bunSql`ASC` : bunSql`DESC`}`
        return this as any
      },
      latest(column?: any) {
        const col = column ?? config.timestamps.defaultOrderColumn
        built = bunSql`${built} ORDER BY ${bunSql(String(col))} DESC`
        return this as any
      },
      oldest(column?: any) {
        const col = column ?? config.timestamps.defaultOrderColumn
        built = bunSql`${built} ORDER BY ${bunSql(String(col))} ASC`
        return this as any
      },
      limit(n: number) {
        built = bunSql`${built} LIMIT ${n}`
        return this
      },
      offset(n: number) {
        built = bunSql`${built} OFFSET ${n}`
        return this
      },
      join(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        built = bunSql`${built} JOIN ${bunSql(String(table2))} ON ${bunSql(String(onLeft))} ${operator} ${bunSql(String(onRight))}`
        joinedTables.add(String(table2))
        return this as any
      },
      joinSub(sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) {
        built = bunSql`${built} JOIN (${sub.toSQL()}) AS ${bunSql(alias)} ON ${bunSql(onLeft)} ${operator} ${bunSql(onRight)}`
        joinedTables.add(alias)
        return this as any
      },
      innerJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        built = bunSql`${built} INNER JOIN ${bunSql(String(table2))} ON ${bunSql(String(onLeft))} ${operator} ${bunSql(String(onRight))}`
        joinedTables.add(String(table2))
        return this as any
      },
      leftJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        built = bunSql`${built} LEFT JOIN ${bunSql(String(table2))} ON ${bunSql(String(onLeft))} ${operator} ${bunSql(String(onRight))}`
        joinedTables.add(String(table2))
        return this as any
      },
      leftJoinSub(sub: { toSQL: () => any }, alias: string, onLeft: string, operator: WhereOperator, onRight: string) {
        built = bunSql`${built} LEFT JOIN (${sub.toSQL()}) AS ${bunSql(alias)} ON ${bunSql(onLeft)} ${operator} ${bunSql(onRight)}`
        joinedTables.add(alias)
        return this as any
      },
      rightJoin(table2: string, onLeft: string, operator: WhereOperator, onRight: string) {
        built = bunSql`${built} RIGHT JOIN ${bunSql(String(table2))} ON ${bunSql(String(onLeft))} ${operator} ${bunSql(String(onRight))}`
        joinedTables.add(String(table2))
        return this as any
      },
      crossJoin(table2: string) {
        built = bunSql`${built} CROSS JOIN ${bunSql(String(table2))}`
        joinedTables.add(String(table2))
        return this as any
      },
      crossJoinSub(sub: { toSQL: () => any }, alias: string) {
        built = bunSql`${built} CROSS JOIN (${sub.toSQL()}) AS ${bunSql(alias)}`
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
          parts.push(bunSql`${bunSql(parent)}.*`)
        for (const jt of joinedTables) {
          const cols = Object.keys((schema as any)[jt]?.columns ?? {})
          for (const c of cols) {
            const alias = config.aliasing.relationColumnAliasFormat === 'camelCase'
              ? `${jt}_${c}`.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
              : config.aliasing.relationColumnAliasFormat === 'table.dot.column'
                ? `${jt}.${c}`
                : `${jt}_${c}`
            parts.push(bunSql`${bunSql(`${jt}.${c}`)} AS ${bunSql(alias)}`)
          }
        }
        if (parts.length > 0) {
          built = bunSql`SELECT ${bunSql(parts as any)} FROM ${bunSql(parent)} ${bunSql``}`
        }
        return this as any
      },
      groupBy(...cols: string[]) {
        if (cols.length > 0)
          built = bunSql`${built} GROUP BY ${bunSql(cols as any)}`
        return this as any
      },
      groupByRaw(fragment: any) {
        built = bunSql`${built} GROUP BY ${fragment}`
        return this as any
      },
      having(expr: any) {
        built = bunSql`${built} HAVING ${applyWhere(({} as any), bunSql``, expr)}`
        return this as any
      },
      havingRaw(fragment: any) {
        built = bunSql`${built} HAVING ${fragment}`
        return this as any
      },
      orderByRaw(fragment: any) {
        built = bunSql`${built} ORDER BY ${fragment}`
        return this as any
      },
      union(other: { toSQL: () => any }) {
        built = bunSql`${built} UNION ${other.toSQL()}`
        return this as any
      },
      unionAll(other: { toSQL: () => any }) {
        built = bunSql`${built} UNION ALL ${other.toSQL()}`
        return this as any
      },
      forPage(page: number, perPage: number) {
        const p = Math.max(1, Math.floor(page))
        const pp = Math.max(1, Math.floor(perPage))
        built = bunSql`${built} LIMIT ${pp} OFFSET ${(p - 1) * pp}`
        return this as any
      },
      toSQL() {
        return makeExecutableQuery(built, text) as any
      },
      async value(column: string) {
        const q = bunSql`${built} LIMIT 1`
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
        const q = bunSql`SELECT EXISTS (${built}) as e`
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Boolean(row?.e)
      },
      async doesntExist() {
        const e = await (this as any).exists()
        return !e
      },
      async paginate(perPage: number, page = 1) {
        const countQ = bunSql`SELECT COUNT(*) as c FROM (${built}) as sub`
        const cRows = await runWithHooks<any[]>(countQ, 'select', { signal: abortSignal, timeoutMs })
        const [cRow] = cRows
        const total = Number(cRow?.c ?? 0)
        const lastPage = Math.max(1, Math.ceil(total / perPage))
        const p = Math.max(1, Math.min(page, lastPage))
        const offset = (p - 1) * perPage
        const data = await runWithHooks<any[]>(bunSql`${built} LIMIT ${perPage} OFFSET ${offset}`, 'select', { signal: abortSignal, timeoutMs })
        return { data, meta: { perPage, page: p, total, lastPage } }
      },
      async simplePaginate(perPage: number, page = 1) {
        const p = Math.max(1, page)
        const offset = (p - 1) * perPage
        const data = await runWithHooks<any[]>(bunSql`${built} LIMIT ${perPage + 1} OFFSET ${offset}`, 'select', { signal: abortSignal, timeoutMs })
        const hasMore = data.length > perPage
        return { data: hasMore ? data.slice(0, perPage) : data, meta: { perPage, page: p, hasMore } }
      },
      async cursorPaginate(perPage: number, cursor?: any, column: string | string[] = 'id', direction: 'asc' | 'desc' = 'asc') {
        let q = built
        if (cursor !== undefined && cursor !== null) {
          if (Array.isArray(column)) {
            const cols = column.map(c => bunSql(String(c)))
            const comp = direction === 'asc' ? bunSql`>` : bunSql`<`
            const tupleCols = bunSql`(${bunSql(cols as any)})`
            const tupleVals = bunSql`(${bunSql(cursor as any)})`
            q = bunSql`${q} WHERE ${tupleCols} ${comp} ${tupleVals}`
          }
          else {
            q = direction === 'asc'
              ? bunSql`${q} WHERE ${bunSql(String(column))} > ${cursor}`
              : bunSql`${q} WHERE ${bunSql(String(column))} < ${cursor}`
          }
        }
        if (Array.isArray(column)) {
          const orderParts = column.map(c => bunSql`${bunSql(String(c))} ${direction === 'asc' ? bunSql`ASC` : bunSql`DESC`}`)
          const orderExpr = orderParts.reduce((acc, p, i) => (i === 0 ? p : bunSql`${acc}, ${p}`))
          q = bunSql`${q} ORDER BY ${orderExpr} LIMIT ${perPage + 1}`
        }
        else {
          q = bunSql`${q} ORDER BY ${bunSql(String(column))} ${direction === 'asc' ? bunSql`ASC` : bunSql`DESC`} LIMIT ${perPage + 1}`
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
      async explain() {
        const q = bunSql`EXPLAIN ${built}`
        return await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
      },
      simple() {
        return (built as any).simple()
      },
      toText() {
        return text
      },
      async get() {
        // Apply soft-deletes default filter if enabled and table has the column
        if (config.softDeletes?.enabled && config.softDeletes.defaultFilter && !includeTrashed) {
          const col = config.softDeletes.column
          const tbl = String(table)
          const hasCol = schema ? Boolean((schema as any)[tbl]?.columns?.[col]) : true
          if (hasCol && !/\bdeleted_at\b/i.test(text)) {
            built = bunSql`${built} WHERE ${bunSql(String(col))} IS ${onlyTrashed ? bunSql`NOT NULL` : bunSql`NULL`}`
            addWhereText('WHERE', `${String(col)} IS ${onlyTrashed ? 'NOT ' : ''}NULL`)
          }
        }
        return await runWithHooks<any[]>(built, 'select', { signal: abortSignal, timeoutMs })
      },
      async executeTakeFirst() {
        const rows = await runWithHooks<any[]>(built, 'select', { signal: abortSignal, timeoutMs })
        return Array.isArray(rows) ? rows[0] : rows
      },
      async first() {
        const rows = await runWithHooks<any[]>(bunSql`${built} LIMIT 1`, 'select', { signal: abortSignal, timeoutMs })
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
        const rows = await runWithHooks<any[]>(bunSql`${built} WHERE ${bunSql(pk)} = ${id} LIMIT 1`, 'select', { signal: abortSignal, timeoutMs })
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
        const rows = await runWithHooks<any[]>(bunSql`${built} WHERE ${bunSql(String(pk))} IN ${bunSql(ids as any)}`, 'select', { signal: abortSignal, timeoutMs })
        return rows as any
      },
      async* lazy() {
        let cursor: any
        const pk = meta?.primaryKeys[String(table)] ?? 'id'
        while (true) {
          const q = cursor == null
            ? bunSql`${built} ORDER BY ${bunSql(String(pk))} ASC LIMIT 100`
            : bunSql`${built} WHERE ${bunSql(String(pk))} > ${cursor} ORDER BY ${bunSql(String(pk))} ASC LIMIT 100`
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
            ? bunSql`${built} ORDER BY ${bunSql(String(pk))} ASC LIMIT 100`
            : bunSql`${built} WHERE ${bunSql(String(pk))} > ${cursor} ORDER BY ${bunSql(String(pk))} ASC LIMIT 100`
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
        const q = bunSql`SELECT COUNT(*) as c FROM (${built}) as sub`
        const rows = await runWithHooks<any[]>(q, 'select', { signal: abortSignal, timeoutMs })
        const [row] = rows
        return Number(row?.c ?? 0)
      },
      lockForUpdate() {
        built = bunSql`${built} FOR UPDATE`
        return this as any
      },
      sharedLock() {
        const syntax = config.sql.sharedLockSyntax === 'LOCK IN SHARE MODE' ? bunSql`LOCK IN SHARE MODE` : bunSql`FOR SHARE`
        built = bunSql`${built} ${syntax}`
        return this as any
      },
      withCTE(name: string, sub: any) {
        built = bunSql`WITH ${bunSql(name)} AS (${sub.toSQL()}) ${built}`
        return this as any
      },
      withRecursive(name: string, sub: any) {
        built = bunSql`WITH RECURSIVE ${bunSql(name)} AS (${sub.toSQL()}) ${built}`
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
              ? bunSql`${bunSql(String(chosen))} IN ${bunSql(value as any)}`
              : bunSql`${bunSql(String(chosen))} = ${value}`
            built = isOr
              ? bunSql`${built} OR ${expr}`
              : isAnd
                ? bunSql`${built} AND ${expr}`
                : bunSql`${built} WHERE ${expr}`
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
      if (!/^[A-Z_][\w.]*$/i.test(name))
        throw new Error(`Invalid identifier: ${name}`)
      return bunSql(String(name))
    },
    ids(...names: string[]) {
      for (const n of names) {
        if (!/^[A-Z_][\w.]*$/i.test(n))
          throw new Error(`Invalid identifier: ${n}`)
      }
      return bunSql(names as any)
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
      const q = bunSql`SELECT * FROM (${sub.toSQL()}) AS ${bunSql(alias)}`
      return {
        where: (_: any) => this,
        andWhere: (_: any) => this,
        orWhere: (_: any) => this,
        orderBy: () => this,
        limit: () => this,
        offset: () => this,
        toSQL: () => makeExecutableQuery(q) as any,
        execute: () => runWithHooks<any[]>(q, 'select'),
        values: () => (q as any).values(),
        raw: () => (q as any).raw(),
        cancel: () => {
          try {
            ;(q as any).cancel()
          }
          catch {}
        },
      } as any
    },
    insertInto<TTable extends keyof DB & string>(table: TTable) {
      let built = bunSql`INSERT INTO ${bunSql(String(table))}`
      const api: any = {
        values(data: Partial<any> | Partial<any>[]) {
          built = bunSql`${built} ${bunSql(data as any)}`
          return api
        },
        returning(...cols: (keyof any & string)[]) {
          const q = bunSql`${built} RETURNING ${bunSql(cols as any)}`
          const obj: any = {
            where: () => obj,
            andWhere: () => obj,
            orWhere: () => obj,
            orderBy: () => obj,
            limit: () => obj,
            offset: () => obj,
            toSQL: () => makeExecutableQuery(q, computeSqlText(q)) as any,
            execute: () => runWithHooks<any[]>(q, 'insert'),
          }
          return obj
        },
        toSQL() {
          return makeExecutableQuery(built, computeSqlText(built)) as any
        },
        execute() {
          return runWithHooks<number | any[]>(built, 'insert')
        },
      }
      return api as TypedInsertQueryBuilder<DB, TTable>
    },
    updateTable(table) {
      let built = bunSql`UPDATE ${bunSql(String(table))}`
      return {
        set(values) {
          built = bunSql`${built} SET ${bunSql(values as any)}`
          return this
        },
        where(expr) {
          built = applyWhere(({} as any), built, expr)
          return this
        },
        returning(...cols) {
          const q = bunSql`${built} RETURNING ${bunSql(cols as any)}`
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
          return makeExecutableQuery(built, computeSqlText(built)) as any
        },
        execute() {
          return runWithHooks<number>(built, 'update')
        },
      }
    },
    deleteFrom(table) {
      let built = bunSql`DELETE FROM ${bunSql(String(table))}`
      return {
        where(expr) {
          built = applyWhere(({} as any), built, expr)
          return this
        },
        returning(...cols) {
          const q = bunSql`${built} RETURNING ${bunSql(cols as any)}`
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
        execute() {
          return runWithHooks<number>(built, 'delete')
        },
      }
    },
    sql: bunSql,
    raw(strings: TemplateStringsArray, ...values: any[]) {
      return bunSql(strings, ...values)
    },
    simple(strings: TemplateStringsArray, ...values: any[]) {
      return (bunSql(strings, ...values) as any).simple()
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
      const q = bunSql`INSERT INTO ${bunSql(String(table))} ${bunSql(values as any)} RETURNING ${bunSql(String(idColumn))} as id`
      const [row] = await (q as any).execute()
      return row?.id
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
        } else {
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
      const id = await (this as any).insertGetId(table, values, pk)
      const row = await (this as any).selectFrom(table).find(id)
      if (!row)
        throw new Error('create() failed to retrieve inserted row')
      return row
    },
    async createMany(table, rows) {
      await (this as any).insertInto(table).values(rows).execute()
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

  }
}
