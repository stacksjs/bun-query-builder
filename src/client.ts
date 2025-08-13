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
type TypedDynamicWhereMethods<
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
  TSql extends string = string,
> = SelectQueryBuilder<DB, TTable, TSelected, TJoined> &
  TypedDynamicWhereMethods<DB, TTable, TSelected, TJoined, TSql> & {
    toSQL: () => TSql
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
  distinct: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  distinctOn: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  selectRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  where: (expr: WhereExpression<DB[TTable]['columns']>) => SelectQueryBuilder<DB, TTable, TSelected>
  whereRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereColumn: (left: string, op: WhereOperator, right: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereColumn: (left: string, op: WhereOperator, right: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNotIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereNotIn: (column: keyof DB[TTable]['columns'] & string, values: any[] | { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // convenience like wrappers
  whereLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNotLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereNotLike: (column: keyof DB[TTable]['columns'] & string, pattern: string, caseSensitive?: boolean) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // where any/all/none on list of columns
  whereAny: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereAll: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNone: (columns: (keyof DB[TTable]['columns'] & string)[], op: WhereOperator, value: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNested: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orWhereNested: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // date/json helpers (basic variants)
  whereDate: (column: string, op: WhereOperator, date: string | Date) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereBetween: (column: string, start: any, end: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNotBetween: (column: string, start: any, end: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereJsonContains: (column: string, json: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  andWhere: (expr: WhereExpression<DB[TTable]['columns']>) => SelectQueryBuilder<DB, TTable, TSelected>
  orWhere: (expr: WhereExpression<DB[TTable]['columns']>) => SelectQueryBuilder<DB, TTable, TSelected>
  orderBy: (column: keyof DB[TTable]['columns'] & string, direction?: 'asc' | 'desc') => SelectQueryBuilder<DB, TTable, TSelected>
  orderByDesc: (column: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected>
  inRandomOrder: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  reorder: (column: string, direction?: 'asc' | 'desc') => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  latest: (column?: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected>
  oldest: (column?: keyof DB[TTable]['columns'] & string) => SelectQueryBuilder<DB, TTable, TSelected>
  limit: (n: number) => SelectQueryBuilder<DB, TTable, TSelected>
  offset: (n: number) => SelectQueryBuilder<DB, TTable, TSelected>
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
  groupBy: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  groupByRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  having: (expr: WhereExpression<any>) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  havingRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  addSelect: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  orderByRaw: (fragment: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  union: (other: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  unionAll: (other: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  forPage: (page: number, perPage: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  selectAllRelations?: () => SelectQueryBuilder<DB, TTable, any, TJoined>
  // where helpers
  whereNull?: (column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNotNull?: (column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // whereBetween intentionally omitted here because it is declared above as required
  whereExists?: (subquery: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereJsonDoesntContain?: (column: string, json: unknown) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereJsonContainsKey?: (path: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereJsonDoesntContainKey?: (path: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereJsonLength?: (path: string, opOrLen: WhereOperator | number, len?: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // relations
  with?: (...relations: string[]) => SelectQueryBuilder<DB, TTable, TSelected, any>
  // locks
  lockForUpdate: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  sharedLock: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // ctes
  withCTE: (name: string, sub: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  withRecursive: (name: string, sub: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // results helpers
  value: <K extends keyof TSelected & string>(column: K) => Promise<TSelected[K]>
  pluck: {
    <K extends keyof TSelected & string>(column: K): Promise<TSelected[K][]>
    <K extends keyof TSelected & string, K2 extends keyof TSelected & string>(column: K, key: K2): Promise<Record<string, TSelected[K]>>
  }
  exists: () => Promise<boolean>
  doesntExist: () => Promise<boolean>
  cursorPaginate: (perPage: number, cursor?: string | number, column?: string, direction?: 'asc' | 'desc') => Promise<{ data: any[], meta: { perPage: number, nextCursor: string | number | null } }>
  chunk: (size: number, handler: (rows: any[]) => Promise<void> | void) => Promise<void>
  chunkById: (size: number, column?: string, handler?: (rows: any[]) => Promise<void> | void) => Promise<void>
  eachById: (size: number, column?: string, handler?: (row: any) => Promise<void> | void) => Promise<void>
  when: (condition: any, then: (qb: any) => any, otherwise?: (qb: any) => any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  tap: (fn: (qb: any) => any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  dump: () => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  dd: () => never
  explain: () => Promise<any[]>
  simple: () => any
  toText?: () => string
  paginate: (perPage: number, page?: number) => Promise<{ data: TSelected[], meta: { perPage: number, page: number, total: number, lastPage: number } }>
  simplePaginate: (perPage: number, page?: number) => Promise<{ data: TSelected[], meta: { perPage: number, page: number, hasMore: boolean } }>
  toSQL: () => string
  execute: () => Promise<TSelected[]>
  // Laravel-style retrieval helpers
  get: () => Promise<TSelected[]>
  first: () => Promise<TSelected | undefined>
  firstOrFail: () => Promise<TSelected>
  find: (id: any) => Promise<TSelected | undefined>
  findOrFail: (id: any) => Promise<TSelected>
  findMany: (ids: any[]) => Promise<TSelected[]>
  lazy: () => AsyncIterable<TSelected>
  lazyById: () => AsyncIterable<TSelected>
  pipe: <R>(fn: (qb: SelectQueryBuilder<DB, TTable, TSelected, TJoined>) => R) => R
  count: () => Promise<number>
  // Type-only convenience properties for IDE hovers; not implemented at runtime
  readonly rows: TSelected[]
  readonly row: TSelected
  values: () => Promise<any[][]>
  raw: () => Promise<any[][]>
  cancel: () => void
}

export type SelectQueryBuilder<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> = BaseSelectQueryBuilder<DB, TTable, TSelected, TJoined> & DynamicWhereMethods<DB, TTable, TSelected, TJoined>

export interface InsertQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  values: (data: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => InsertQueryBuilder<DB, TTable>
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  toSQL: () => string
  execute: () => Promise<number | DB[TTable]['columns'] | DB[TTable]['columns'][]>
}

export interface UpdateQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  set: (values: Partial<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  where: (expr: WhereExpression<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  toSQL: () => string
  execute: () => Promise<number>
}

export interface DeleteQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  where: (expr: WhereExpression<DB[TTable]['columns']>) => DeleteQueryBuilder<DB, TTable>
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  toSQL: () => string
  execute: () => Promise<number>
}

export interface QueryBuilder<DB extends DatabaseSchema<any>> {
  // typed select list (column names or raw aliases)
  select: <TTable extends keyof DB & string, K extends keyof DB[TTable]['columns'] & string>(
    table: TTable,
    ...columns: (K | `${string} as ${string}`)[]
  ) => SelectQueryBuilder<DB, TTable, any>
  selectFrom: <TTable extends keyof DB & string>(table: TTable) => SelectQueryBuilder<DB, TTable, DB[TTable]['columns']>
  insertInto: <TTable extends keyof DB & string>(table: TTable) => InsertQueryBuilder<DB, TTable>
  updateTable: <TTable extends keyof DB & string>(table: TTable) => UpdateQueryBuilder<DB, TTable>
  deleteFrom: <TTable extends keyof DB & string>(table: TTable) => DeleteQueryBuilder<DB, TTable>
  selectFromSub: (sub: { toSQL: () => any }, alias: string) => SelectQueryBuilder<DB, keyof DB & string, any>
  sql: any
  raw: (strings: TemplateStringsArray, ...values: any[]) => any
  simple: (strings: TemplateStringsArray, ...values: any[]) => any
  unsafe: (query: string, params?: any[]) => Promise<any>
  file: (path: string, params?: any[]) => Promise<any>
  reserve: () => Promise<(QueryBuilder<DB> & { release: () => void })>
  close: (opts?: { timeout?: number }) => Promise<void>
  // Pub/Sub (stubs until Bun exposes API)
  listen: (channel: string, handler?: (payload: any) => void) => Promise<void>
  unlisten: (channel?: string) => Promise<void>
  notify: (channel: string, payload?: any) => Promise<void>
  // COPY support (stubs until available)
  copyTo: (queryOrTable: string, options?: Record<string, any>) => Promise<any>
  copyFrom: (queryOrTable: string, source: AsyncIterable<any> | Iterable<any>, options?: Record<string, any>) => Promise<any>
  // Pool readiness
  ping: () => Promise<boolean>
  waitForReady: (opts?: { attempts?: number, delayMs?: number }) => Promise<void>
  transaction: <T>(fn: (tx: QueryBuilder<DB>) => Promise<T> | T, options?: TransactionOptions) => Promise<T>
  savepoint: <T>(fn: (sp: QueryBuilder<DB>) => Promise<T> | T) => Promise<T>
  beginDistributed: <T>(name: string, fn: (tx: QueryBuilder<DB>) => Promise<T> | T) => Promise<T>
  commitDistributed: (name: string) => Promise<void>
  rollbackDistributed: (name: string) => Promise<void>
  configure: (opts: Partial<typeof config>) => QueryBuilder<DB>
  setTransactionDefaults: (defaults: TransactionOptions) => void
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

  function makeSelect<TTable extends keyof DB & string>(table: TTable, columns?: string[]): TypedSelectQueryBuilder<DB, TTable, any, TTable, `SELECT ${string} FROM ${TTable}`> {
    let built = (columns && columns.length > 0)
      ? bunSql`SELECT ${bunSql(columns as any)} FROM ${bunSql(String(table))}`
      : bunSql`SELECT * FROM ${bunSql(String(table))}`

    const joinedTables = new Set<string>()

    const dynWhere: any = new Proxy({}, {
      get(_, prop: string) {
        if (prop.startsWith('where') || prop.startsWith('orWhere') || prop.startsWith('andWhere')) {
          const isOr = prop.startsWith('orWhere')
          const isAnd = prop.startsWith('andWhere')
          const raw = prop.replace(/^or?where/i, '')
            .replace(/^andwhere/i, '')
          if (!raw)
            return () => dynWhere as any
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
            return dynWhere as any
          }
        }
        return undefined
      },
    })

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
        const parentPk = meta.primaryKeys[parentTable] ?? 'id'

        const singularize = (name: string) => {
          if (config.relations.singularizeStrategy === 'none')
            return name
          return name.endsWith('s') ? name.slice(0, -1) : name
        }

        for (const rel of relations) {
          const maybeModel = rel
          const targetTable = meta.modelToTable[maybeModel] || meta.tableToModel[maybeModel] ? (meta.modelToTable[maybeModel] ?? maybeModel) : rel
          const childTable = String(targetTable)
          if (!childTable || childTable === parentTable)
            continue
          const _childPk = meta.primaryKeys[childTable] ?? 'id'

          const fkInChild = `${singularize(parentTable)}_id`
          const _fkInParent = `${singularize(childTable)}_id`

          // prefer child.fk = parent.pk
          built = bunSql`${built} LEFT JOIN ${bunSql(childTable)} ON ${bunSql(`${childTable}.${fkInChild}`)} = ${bunSql(`${parentTable}.${parentPk}`)}`
          joinedTables.add(childTable)
        }
        return this as any
      },
      where(expr: any) {
        built = applyWhere(({} as any), built, expr)
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
        return this as any
      },
      whereLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? bunSql`${bunSql(String(column))} LIKE ${pattern}` : bunSql`LOWER(${bunSql(String(column))}) LIKE LOWER(${pattern})`
        built = bunSql`${built} WHERE ${expr}`
        return this as any
      },
      orWhereLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? bunSql`${bunSql(String(column))} LIKE ${pattern}` : bunSql`LOWER(${bunSql(String(column))}) LIKE LOWER(${pattern})`
        built = bunSql`${built} OR ${expr}`
        return this as any
      },
      whereNotLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? bunSql`${bunSql(String(column))} NOT LIKE ${pattern}` : bunSql`LOWER(${bunSql(String(column))}) NOT LIKE LOWER(${pattern})`
        built = bunSql`${built} WHERE ${expr}`
        return this as any
      },
      orWhereNotLike(column: string, pattern: string, caseSensitive = false) {
        const expr = caseSensitive ? bunSql`${bunSql(String(column))} NOT LIKE ${pattern}` : bunSql`LOWER(${bunSql(String(column))}) NOT LIKE LOWER(${pattern})`
        built = bunSql`${built} OR ${expr}`
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
      andWhere(expr: any) {
        built = bunSql`${built} AND ${applyWhere(({} as any), bunSql``, expr)}`
        return this
      },
      orWhere(expr: any) {
        built = bunSql`${built} OR ${applyWhere(({} as any), bunSql``, expr)}`
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
        return String(built)
      },
      async value(column: string) {
        const q = bunSql`${built} LIMIT 1`
        const [row] = await (q as any).execute()
        return row?.[column]
      },
      async pluck(column: any, key?: any) {
        const rows = await (built as any).execute()
        if (key) {
          const out: Record<string, any> = {}
          for (const r of rows) out[String(r?.[key])] = r?.[column]
          return out
        }
        return rows.map((r: any) => r?.[column])
      },
      async exists() {
        const q = bunSql`SELECT EXISTS (${built}) as e`
        const [row] = await (q as any).execute()
        return Boolean(row?.e)
      },
      async doesntExist() {
        const e = await (this as any).exists()
        return !e
      },
      async paginate(perPage: number, page = 1) {
        const countQ = bunSql`SELECT COUNT(*) as c FROM (${built}) as sub`
        const [cRow] = await (countQ as any).execute()
        const total = Number(cRow?.c ?? 0)
        const lastPage = Math.max(1, Math.ceil(total / perPage))
        const p = Math.max(1, Math.min(page, lastPage))
        const offset = (p - 1) * perPage
        const data = await (bunSql`${built} LIMIT ${perPage} OFFSET ${offset}` as any).execute()
        return { data, meta: { perPage, page: p, total, lastPage } }
      },
      async simplePaginate(perPage: number, page = 1) {
        const p = Math.max(1, page)
        const offset = (p - 1) * perPage
        const data = await (bunSql`${built} LIMIT ${perPage + 1} OFFSET ${offset}` as any).execute()
        const hasMore = data.length > perPage
        return { data: hasMore ? data.slice(0, perPage) : data, meta: { perPage, page: p, hasMore } }
      },
      async cursorPaginate(perPage: number, cursor?: string | number, column = 'id', direction: 'asc' | 'desc' = 'asc') {
        let q = built
        if (cursor !== undefined && cursor !== null) {
          q = direction === 'asc'
            ? bunSql`${q} WHERE ${bunSql(String(column))} > ${cursor}`
            : bunSql`${q} WHERE ${bunSql(String(column))} < ${cursor}`
        }
        q = bunSql`${q} ORDER BY ${bunSql(String(column))} ${direction === 'asc' ? bunSql`ASC` : bunSql`DESC`} LIMIT ${perPage + 1}`
        const rows = await (q as any).execute()
        const next = rows.length > perPage ? rows[perPage]?.[column] : null
        return { data: rows.slice(0, perPage), meta: { perPage, nextCursor: next ?? null } }
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
        // eslint-disable-next-line no-console
        console.log(String(built))
        return this as any
      },
      dd() {
        // eslint-disable-next-line no-console
        console.log(String(built))
        throw new Error('Dump and Die')
      },
      async explain() {
        const q = bunSql`EXPLAIN ${built}`
        return await (q as any).execute()
      },
      simple() {
        return (built as any).simple()
      },
      toText() {
        if (!config.debug?.captureText)
          return ''
        return String(built)
      },
      async get() {
        return await (built as any).execute()
      },
      async first() {
        const [row] = await (bunSql`${built} LIMIT 1` as any).execute()
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
        const [row] = await (bunSql`${built} WHERE ${bunSql(pk)} = ${id} LIMIT 1` as any).execute()
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
        const rows = await (bunSql`${built} WHERE ${bunSql(String(pk))} IN ${bunSql(ids as any)}` as any).execute()
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
        const [row] = await (q as any).execute()
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
        return (built as any).execute()
      },
      values() {
        return (built as any).values()
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
          ;(built as any).cancel()
        }
        catch {}
      },
    } as unknown as BaseSelectQueryBuilder<DB, TTable, any, TTable>
    return Object.assign(dynWhere, base) as TypedSelectQueryBuilder<DB, TTable, any, TTable, `SELECT ${string} FROM ${TTable}`>
  }

  return {
    // Create a builder with per-instance option overrides
    configure(opts: Partial<typeof config>) {
      // This keeps types simple; for now, users can set global config via import
      Object.assign(config, opts)
      return this as any
    },
    select(table, ...columns) {
      return makeSelect<any>(table, columns as string[])
    },
    selectFrom(table) {
      return makeSelect<any>(table)
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
        toSQL: () => String(q),
        execute: () => (q as any).execute(),
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
    insertInto(table) {
      let built = bunSql`INSERT INTO ${bunSql(String(table))}`
      return {
        values(data) {
          built = bunSql`${built} ${bunSql(data as any)}`
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
            toSQL: () => String(q),
            execute: () => (q as any).execute(),
          }
          return obj
        },
        toSQL() {
          return String(built)
        },
        execute() {
          return (built as any).execute()
        },
      }
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
            toSQL: () => String(q),
            execute: () => (q as any).execute(),
          }
          return obj
        },
        toSQL() {
          return String(built)
        },
        execute() {
          return (built as any).execute()
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
            toSQL: () => String(q),
            execute: () => (q as any).execute(),
          }
          return obj
        },
        toSQL() {
          return String(built)
        },
        execute() {
          return (built as any).execute()
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
        await (q as any).execute()
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
