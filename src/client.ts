import type { SchemaMeta } from './meta'
import type { DatabaseSchema } from './schema'
import { sql as bunSql } from 'bun'

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

export interface SelectQueryBuilder<
  DB extends DatabaseSchema<any>,
  TTable extends keyof DB & string,
  TSelected,
  TJoined extends string = TTable,
> {
  where: (expr: WhereExpression<DB[TTable]['columns']>) => SelectQueryBuilder<DB, TTable, TSelected>
  andWhere: (expr: WhereExpression<DB[TTable]['columns']>) => SelectQueryBuilder<DB, TTable, TSelected>
  orWhere: (expr: WhereExpression<DB[TTable]['columns']>) => SelectQueryBuilder<DB, TTable, TSelected>
  orderBy: (column: keyof DB[TTable]['columns'] & string, direction?: 'asc' | 'desc') => SelectQueryBuilder<DB, TTable, TSelected>
  limit: (n: number) => SelectQueryBuilder<DB, TTable, TSelected>
  offset: (n: number) => SelectQueryBuilder<DB, TTable, TSelected>
  // Joins
  join: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
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
  rightJoin: <T2 extends keyof DB & string>(
    table: T2,
    onLeft: JoinColumn<DB, TJoined | T2>,
    operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like',
    onRight: JoinColumn<DB, TJoined | T2>,
  ) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  crossJoin: <T2 extends keyof DB & string>(table: T2) => SelectQueryBuilder<DB, TTable, TSelected, TJoined | T2>
  groupBy: (...columns: (keyof DB[TTable]['columns'] & string | string)[]) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  having: (expr: WhereExpression<any>) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  union: (other: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  unionAll: (other: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  forPage: (page: number, perPage: number) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // where helpers
  whereNull?: (column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereNotNull?: (column: string) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereBetween?: (column: string, start: any, end: any) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  whereExists?: (subquery: { toSQL: () => any }) => SelectQueryBuilder<DB, TTable, TSelected, TJoined>
  // relations
  with?: (...relations: string[]) => SelectQueryBuilder<DB, TTable, TSelected, any>
  toSQL: () => any
  execute: () => QueryResult
  values: () => Promise<any[][]>
  raw: () => Promise<any[][]>
  cancel: () => void
}

export interface InsertQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  values: (data: Partial<DB[TTable]['columns']> | Partial<DB[TTable]['columns']>[]) => InsertQueryBuilder<DB, TTable>
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  toSQL: () => any
  execute: () => QueryResult
}

export interface UpdateQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  set: (values: Partial<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  where: (expr: WhereExpression<DB[TTable]['columns']>) => UpdateQueryBuilder<DB, TTable>
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  toSQL: () => any
  execute: () => QueryResult
}

export interface DeleteQueryBuilder<DB extends DatabaseSchema<any>, TTable extends keyof DB & string> {
  where: (expr: WhereExpression<DB[TTable]['columns']>) => DeleteQueryBuilder<DB, TTable>
  returning: <K extends keyof DB[TTable]['columns'] & string>(...cols: K[]) => SelectQueryBuilder<DB, TTable, Pick<DB[TTable]['columns'], K>>
  toSQL: () => any
  execute: () => QueryResult
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
  sql: any
  raw: (strings: TemplateStringsArray, ...values: any[]) => any
  transaction: <T>(fn: (tx: QueryBuilder<DB>) => Promise<T> | T) => Promise<T>
  // aggregates
  count: <TTable extends keyof DB & string>(table: TTable, column?: keyof DB[TTable]['columns'] & string) => Promise<number>
  sum: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<number>
  avg: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<number>
  min: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<any>
  max: <TTable extends keyof DB & string>(table: TTable, column: keyof DB[TTable]['columns'] & string) => Promise<any>
}

interface InternalState {
  sql: any
  meta?: SchemaMeta
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

export function createQueryBuilder<DB extends DatabaseSchema<any>>(state?: Partial<InternalState>): QueryBuilder<DB> {
  const _sql = state?.sql ?? bunSql
  const meta = state?.meta

  function makeSelect<TTable extends keyof DB & string>(table: TTable, columns?: string[]): SelectQueryBuilder<DB, TTable, any> {
    let built = (columns && columns.length > 0)
      ? bunSql`SELECT ${bunSql(columns as any)} FROM ${bunSql(String(table))}`
      : bunSql`SELECT * FROM ${bunSql(String(table))}`

    return {
      with(...relations: string[]) {
        if (!meta || relations.length === 0)
          return this as any
        const parentTable = String(table)
        const parentPk = meta.primaryKeys[parentTable] ?? 'id'

        const singularize = (name: string) => name.endsWith('s') ? name.slice(0, -1) : name

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
        }
        return this as any
      },
      where(expr) {
        built = applyWhere(({} as any), built, expr)
        return this
      },
      // where helpers
      // whereNull/whereNotNull/whereBetween/whereExists style convenience
      // We implement them via the existing where/orWhere/andWhere to keep types light
      // Note: These helpers are intentionally not typed on the interface to keep it minimal
      // but remain available at runtime.
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
      andWhere(expr) {
        built = bunSql`${built} AND ${applyWhere(({} as any), bunSql``, expr)}`
        return this
      },
      orWhere(expr) {
        built = bunSql`${built} OR ${applyWhere(({} as any), bunSql``, expr)}`
        return this
      },
      orderBy(column, direction = 'asc') {
        built = bunSql`${built} ORDER BY ${bunSql(String(column))} ${direction === 'asc' ? bunSql`ASC` : bunSql`DESC`}`
        return this
      },
      limit(n) {
        built = bunSql`${built} LIMIT ${n}`
        return this
      },
      offset(n) {
        built = bunSql`${built} OFFSET ${n}`
        return this
      },
      join(table2, onLeft, operator, onRight) {
        built = bunSql`${built} JOIN ${bunSql(String(table2))} ON ${bunSql(String(onLeft))} ${operator} ${bunSql(String(onRight))}`
        return this as any
      },
      innerJoin(table2, onLeft, operator, onRight) {
        built = bunSql`${built} INNER JOIN ${bunSql(String(table2))} ON ${bunSql(String(onLeft))} ${operator} ${bunSql(String(onRight))}`
        return this as any
      },
      leftJoin(table2, onLeft, operator, onRight) {
        built = bunSql`${built} LEFT JOIN ${bunSql(String(table2))} ON ${bunSql(String(onLeft))} ${operator} ${bunSql(String(onRight))}`
        return this as any
      },
      rightJoin(table2, onLeft, operator, onRight) {
        built = bunSql`${built} RIGHT JOIN ${bunSql(String(table2))} ON ${bunSql(String(onLeft))} ${operator} ${bunSql(String(onRight))}`
        return this as any
      },
      crossJoin(table2) {
        built = bunSql`${built} CROSS JOIN ${bunSql(String(table2))}`
        return this as any
      },
      groupBy(...cols) {
        if (cols.length > 0)
          built = bunSql`${built} GROUP BY ${bunSql(cols as any)}`
        return this as any
      },
      having(expr) {
        built = bunSql`${built} HAVING ${applyWhere(({} as any), bunSql``, expr)}`
        return this as any
      },
      union(other) {
        built = bunSql`${built} UNION ${other.toSQL()}`
        return this as any
      },
      unionAll(other) {
        built = bunSql`${built} UNION ALL ${other.toSQL()}`
        return this as any
      },
      forPage(page, perPage) {
        const p = Math.max(1, Math.floor(page))
        const pp = Math.max(1, Math.floor(perPage))
        built = bunSql`${built} LIMIT ${pp} OFFSET ${(p - 1) * pp}`
        return this as any
      },
      toSQL() {
        return built
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
      cancel() {
        try {
          ;(built as any).cancel()
        }
        catch {}
      },
    }
  }

  return {
    select(table, ...columns) {
      return makeSelect<any>(table, columns as string[])
    },
    selectFrom(table) {
      return makeSelect<any>(table)
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
            toSQL: () => q,
            execute: () => (q as any).execute(),
          }
          return obj
        },
        toSQL() {
          return built
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
            toSQL: () => q,
            execute: () => (q as any).execute(),
          }
          return obj
        },
        toSQL() {
          return built
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
            toSQL: () => q,
            execute: () => (q as any).execute(),
          }
          return obj
        },
        toSQL() {
          return built
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
    async transaction(fn) {
      return await (bunSql as any).begin(async (tx: any) => {
        const qb = createQueryBuilder<DB>({ sql: tx })
        return await fn(qb)
      })
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
