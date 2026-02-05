/**
 * Dynamic ORM for bun-query-builder
 *
 * Creates fully-featured model classes from Stacks-style model definitions
 * without any code generation. Provides precise TypeScript inference.
 *
 * @example
 * ```ts
 * import { createModel } from 'bun-query-builder'
 *
 * const User = createModel({
 *   name: 'User',
 *   table: 'users',
 *   attributes: {
 *     name: { type: 'string', fillable: true },
 *     email: { type: 'string', fillable: true, unique: true },
 *     age: { type: 'number', fillable: true },
 *     status: { type: ['active', 'inactive'] as const, fillable: true },
 *   }
 * } as const)
 *
 * const user = User.find(1)
 * user?.get('status') // type: 'active' | 'inactive'
 * ```
 */

import { Database, type SQLQueryBindings } from 'bun:sqlite'

// Binding helper type for SQL queries
type Bindings = SQLQueryBindings[]

// Primitive type mappings
type PrimitiveTypeMap = {
  string: string
  number: number
  boolean: boolean
  date: Date
  json: Record<string, unknown>
}

// Infer the actual TS type from attribute type definition
type InferType<T> =
  T extends keyof PrimitiveTypeMap ? PrimitiveTypeMap[T] :
  T extends readonly (infer U)[] ? U :
  T extends (infer U)[] ? U :
  unknown

// Attribute definition with explicit type
export interface TypedAttribute<T = unknown> {
  type?: T
  order?: number
  fillable?: boolean
  unique?: boolean
  hidden?: boolean
  guarded?: boolean
  nullable?: boolean
  default?: InferType<T>
  validation?: {
    rule: unknown
    message?: Record<string, string>
  }
  factory?: (faker: unknown) => InferType<T>
}

// Base model definition
export interface ModelDefinition {
  readonly name: string
  readonly table: string
  readonly primaryKey?: string
  readonly autoIncrement?: boolean
  readonly connection?: string
  readonly traits?: {
    readonly useUuid?: boolean
    readonly useTimestamps?: boolean
    readonly useSoftDeletes?: boolean
    readonly useSearch?: {
      readonly displayable?: readonly string[]
      readonly searchable?: readonly string[]
      readonly sortable?: readonly string[]
      readonly filterable?: readonly string[]
    }
    readonly useSeeder?: {
      readonly count: number
    }
    readonly useApi?: {
      readonly uri: string
      readonly routes: readonly string[]
    }
  }
  readonly belongsTo?: readonly string[]
  readonly hasMany?: readonly string[]
  readonly hasOne?: readonly string[]
  readonly attributes: {
    readonly [key: string]: TypedAttribute<unknown>
  }
  readonly get?: Record<string, (attributes: Record<string, unknown>) => unknown>
  readonly set?: Record<string, (attributes: Record<string, unknown>) => unknown>
}

// Extract attribute keys from definition
type AttributeKeys<TDef extends ModelDefinition> = keyof TDef['attributes'] & string

// Infer single attribute type
type InferAttributeType<TAttr> =
  TAttr extends { type: infer T } ? InferType<T> :
  TAttr extends { factory: (faker: unknown) => infer R } ? R :
  unknown

// Build the full attributes type from definition
type InferModelAttributes<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: InferAttributeType<TDef['attributes'][K]>
}

// System fields added by traits
type SystemFields<TDef extends ModelDefinition> =
  { id: number } &
  (TDef['traits'] extends { useUuid: true } ? { uuid: string } : {}) &
  (TDef['traits'] extends { useTimestamps: true } ? { created_at: string; updated_at: string } : {}) &
  (TDef['traits'] extends { useSoftDeletes: true } ? { deleted_at: string | null } : {})

// Complete model type
type ModelAttributes<TDef extends ModelDefinition> =
  InferModelAttributes<TDef> & SystemFields<TDef>

// All valid column names
type ColumnName<TDef extends ModelDefinition> =
  | AttributeKeys<TDef>
  | 'id'
  | (TDef['traits'] extends { useUuid: true } ? 'uuid' : never)
  | (TDef['traits'] extends { useTimestamps: true } ? 'created_at' | 'updated_at' : never)
  | (TDef['traits'] extends { useSoftDeletes: true } ? 'deleted_at' : never)

// Hidden fields
type HiddenKeys<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: TDef['attributes'][K] extends { hidden: true } ? K : never
}[AttributeKeys<TDef>]

// Fillable fields
type FillableKeys<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: TDef['attributes'][K] extends { fillable: true } ? K : never
}[AttributeKeys<TDef>]

type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in' | 'not in'

let globalDb: Database | null = null

export function configureOrm(options: { database?: string | Database; verbose?: boolean }): void {
  if (options.database instanceof Database) {
    globalDb = options.database
  } else {
    globalDb = new Database(options.database || ':memory:', { create: true })
  }
}

export function getDatabase(): Database {
  if (!globalDb) {
    globalDb = new Database(':memory:', { create: true })
  }
  return globalDb
}

/**
 * Model instance - represents a single database record
 */
class ModelInstance<
  TDef extends ModelDefinition,
  TSelected extends ColumnName<TDef> = ColumnName<TDef>
> {
  private _attributes: Record<string, unknown>
  private _original: Record<string, unknown>
  private _definition: TDef
  private _hasSaved = false

  constructor(definition: TDef, attributes: Partial<ModelAttributes<TDef>> = {}) {
    this._definition = definition
    this._attributes = { ...attributes }
    this._original = { ...attributes }
  }

  get<K extends TSelected>(key: K): K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : never {
    const getter = this._definition.get?.[key as string]
    if (getter) {
      return getter(this._attributes as Record<string, unknown>) as any
    }
    return this._attributes[key as string] as any
  }

  set<K extends AttributeKeys<TDef>>(
    key: K,
    value: ModelAttributes<TDef>[K]
  ): void {
    this._attributes[key as string] = value
  }

  get attributes(): Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>> {
    return { ...this._attributes } as any
  }

  get id(): number {
    const pk = this._definition.primaryKey || 'id'
    return this._attributes[pk] as number
  }

  isDirty<K extends AttributeKeys<TDef>>(column?: K): boolean {
    if (column) {
      return this._attributes[column] !== this._original[column]
    }
    return Object.keys(this._attributes).some(k => this._attributes[k] !== this._original[k])
  }

  isClean<K extends AttributeKeys<TDef>>(column?: K): boolean {
    return !this.isDirty(column)
  }

  getOriginal<K extends AttributeKeys<TDef>>(column: K): ModelAttributes<TDef>[K] {
    return this._original[column] as any
  }

  getChanges(): Partial<InferModelAttributes<TDef>> {
    const changes: Record<string, unknown> = {}
    for (const key of Object.keys(this._attributes)) {
      if (this._attributes[key] !== this._original[key]) {
        changes[key] = this._attributes[key]
      }
    }
    return changes as any
  }

  fill(data: Partial<Pick<InferModelAttributes<TDef>, FillableKeys<TDef>>>): this {
    const attrs = this._definition.attributes
    for (const [key, value] of Object.entries(data)) {
      const attr = attrs[key]
      if (attr?.fillable && !attr?.guarded) {
        this._attributes[key] = value
      }
    }
    return this
  }

  forceFill(data: Partial<InferModelAttributes<TDef>>): this {
    Object.assign(this._attributes, data)
    return this
  }

  save(): this {
    const db = getDatabase()
    const pk = this._definition.primaryKey || 'id'

    const setters = this._definition.set || {}
    for (const [key, setter] of Object.entries(setters)) {
      if (this.isDirty(key as AttributeKeys<TDef>)) {
        this._attributes[key] = setter(this._attributes as Record<string, unknown>)
      }
    }

    if (this._attributes[pk]) {
      const changes = this.getChanges()
      const changeKeys = Object.keys(changes)
      if (changeKeys.length > 0) {
        const sets = changeKeys.map(k => `${k} = ?`).join(', ')
        const values = [...Object.values(changes), this._attributes[pk]]

        if (this._definition.traits?.useTimestamps) {
          const now = new Date().toISOString()
          db.run(
            `UPDATE ${this._definition.table} SET ${sets}, updated_at = ? WHERE ${pk} = ?`,
            [...Object.values(changes), now, this._attributes[pk]] as Bindings
          )
        } else {
          db.run(`UPDATE ${this._definition.table} SET ${sets} WHERE ${pk} = ?`, values as Bindings)
        }
      }
    } else {
      const attrs = this._definition.attributes
      const data: Record<string, unknown> = {}

      for (const [key, attr] of Object.entries(attrs)) {
        if (attr.fillable && this._attributes[key] !== undefined) {
          data[key] = this._attributes[key]
        }
      }

      if (this._definition.traits?.useTimestamps) {
        const now = new Date().toISOString()
        data.created_at = now
        data.updated_at = now
      }

      if (this._definition.traits?.useUuid && !data.uuid) {
        data.uuid = crypto.randomUUID()
      }

      const columns = Object.keys(data)
      const placeholders = columns.map(() => '?').join(', ')

      const result = db.run(
        `INSERT INTO ${this._definition.table} (${columns.join(', ')}) VALUES (${placeholders})`,
        Object.values(data) as Bindings
      )

      this._attributes[pk] = result.lastInsertRowid
    }

    this._original = { ...this._attributes }
    this._hasSaved = true
    return this
  }

  update(data: Partial<Pick<InferModelAttributes<TDef>, FillableKeys<TDef>>>): this {
    this.fill(data)
    return this.save()
  }

  delete(): boolean {
    const db = getDatabase()
    const pk = this._definition.primaryKey || 'id'
    const pkValue = this._attributes[pk]

    if (!pkValue) throw new Error('Cannot delete a model without a primary key')

    if (this._definition.traits?.useSoftDeletes) {
      db.run(
        `UPDATE ${this._definition.table} SET deleted_at = ? WHERE ${pk} = ?`,
        [new Date().toISOString(), pkValue] as Bindings
      )
    } else {
      db.run(`DELETE FROM ${this._definition.table} WHERE ${pk} = ?`, [pkValue] as Bindings)
    }

    return true
  }

  refresh(): this {
    const db = getDatabase()
    const pk = this._definition.primaryKey || 'id'
    const pkValue = this._attributes[pk]

    if (!pkValue) throw new Error('Cannot refresh a model without a primary key')

    const row = db.query(`SELECT * FROM ${this._definition.table} WHERE ${pk} = ?`).get(pkValue as SQLQueryBindings) as Record<string, unknown> | null
    if (row) {
      this._attributes = row
      this._original = { ...row }
    }

    return this
  }

  toJSON(): Omit<Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>>, HiddenKeys<TDef>> {
    const hidden = new Set<string>()
    for (const [key, attr] of Object.entries(this._definition.attributes)) {
      if (attr.hidden) hidden.add(key)
    }

    const json: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(this._attributes)) {
      if (!hidden.has(key)) json[key] = value
    }
    return json as any
  }
}

/**
 * Query builder with precise type narrowing
 */
class ModelQueryBuilder<
  TDef extends ModelDefinition,
  TSelected extends ColumnName<TDef> = ColumnName<TDef>
> {
  private _definition: TDef
  private _wheres: { column: string; operator: WhereOperator; value: unknown; boolean: 'and' | 'or' }[] = []
  private _orderBy: { column: string; direction: 'asc' | 'desc' }[] = []
  private _limit?: number
  private _offset?: number
  private _select: string[] = ['*']

  constructor(definition: TDef) {
    this._definition = definition
  }

  where<K extends ColumnName<TDef>>(
    column: K,
    operatorOrValue: WhereOperator | (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown),
    value?: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected> {
    if (value === undefined) {
      this._wheres.push({ column: column as string, operator: '=', value: operatorOrValue, boolean: 'and' })
    } else {
      this._wheres.push({ column: column as string, operator: operatorOrValue as WhereOperator, value, boolean: 'and' })
    }
    return this
  }

  orWhere<K extends ColumnName<TDef>>(
    column: K,
    operatorOrValue: WhereOperator | (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown),
    value?: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected> {
    if (value === undefined) {
      this._wheres.push({ column: column as string, operator: '=', value: operatorOrValue, boolean: 'or' })
    } else {
      this._wheres.push({ column: column as string, operator: operatorOrValue as WhereOperator, value, boolean: 'or' })
    }
    return this
  }

  whereIn<K extends ColumnName<TDef>>(
    column: K,
    values: (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]
  ): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'in', value: values, boolean: 'and' })
    return this
  }

  whereNotIn<K extends ColumnName<TDef>>(
    column: K,
    values: (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[]
  ): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not in', value: values, boolean: 'and' })
    return this
  }

  whereNull<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: '=', value: null, boolean: 'and' })
    return this
  }

  whereNotNull<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: '!=', value: null, boolean: 'and' })
    return this
  }

  whereLike<K extends ColumnName<TDef>>(column: K, pattern: string): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'like', value: pattern, boolean: 'and' })
    return this
  }

  orderBy<K extends ColumnName<TDef>>(column: K, direction: 'asc' | 'desc' = 'asc'): ModelQueryBuilder<TDef, TSelected> {
    this._orderBy.push({ column: column as string, direction })
    return this
  }

  orderByDesc<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    return this.orderBy(column, 'desc')
  }

  orderByAsc<K extends ColumnName<TDef>>(column: K): ModelQueryBuilder<TDef, TSelected> {
    return this.orderBy(column, 'asc')
  }

  limit(count: number): ModelQueryBuilder<TDef, TSelected> {
    this._limit = count
    return this
  }

  take(count: number): ModelQueryBuilder<TDef, TSelected> {
    return this.limit(count)
  }

  offset(count: number): ModelQueryBuilder<TDef, TSelected> {
    this._offset = count
    return this
  }

  skip(count: number): ModelQueryBuilder<TDef, TSelected> {
    return this.offset(count)
  }

  select<K extends ColumnName<TDef>>(...columns: K[]): ModelQueryBuilder<TDef, K> {
    this._select = columns as string[]
    return this as unknown as ModelQueryBuilder<TDef, K>
  }

  private buildQuery(): { sql: string; params: unknown[] } {
    const params: unknown[] = []
    let sql = `SELECT ${this._select.join(', ')} FROM ${this._definition.table}`

    if (this._wheres.length > 0) {
      const clauses: string[] = []
      for (let i = 0; i < this._wheres.length; i++) {
        const w = this._wheres[i]
        let clause: string

        if (w.value === null) {
          clause = w.operator === '=' ? `${w.column} IS NULL` : `${w.column} IS NOT NULL`
        } else if (w.operator === 'in' || w.operator === 'not in') {
          const arr = w.value as unknown[]
          clause = `${w.column} ${w.operator.toUpperCase()} (${arr.map(() => '?').join(', ')})`
          params.push(...arr)
        } else {
          clause = `${w.column} ${w.operator} ?`
          params.push(w.value)
        }

        clauses.push(i === 0 ? clause : `${w.boolean.toUpperCase()} ${clause}`)
      }
      sql += ` WHERE ${clauses.join(' ')}`
    }

    if (this._orderBy.length > 0) {
      sql += ` ORDER BY ${this._orderBy.map(o => `${o.column} ${o.direction.toUpperCase()}`).join(', ')}`
    }

    if (this._limit !== undefined) sql += ` LIMIT ${this._limit}`
    if (this._offset !== undefined) sql += ` OFFSET ${this._offset}`

    return { sql, params }
  }

  get(): ModelInstance<TDef, TSelected>[] {
    const db = getDatabase()
    const { sql, params } = this.buildQuery()
    const rows = db.query(sql).all(...(params as Bindings)) as Record<string, unknown>[]
    return rows.map(row => new ModelInstance<TDef, TSelected>(this._definition, row as any))
  }

  first(): ModelInstance<TDef, TSelected> | undefined {
    this._limit = 1
    return this.get()[0]
  }

  firstOrFail(): ModelInstance<TDef, TSelected> {
    const result = this.first()
    if (!result) throw new Error(`No ${this._definition.name} found`)
    return result
  }

  last(): ModelInstance<TDef, TSelected> | undefined {
    const pk = this._definition.primaryKey || 'id'
    this._orderBy = [{ column: pk, direction: 'desc' }]
    this._limit = 1
    return this.get()[0]
  }

  count(): number {
    const db = getDatabase()
    const params: unknown[] = []
    let sql = `SELECT COUNT(*) as count FROM ${this._definition.table}`

    if (this._wheres.length > 0) {
      const clauses: string[] = []
      for (let i = 0; i < this._wheres.length; i++) {
        const w = this._wheres[i]
        let clause: string

        if (w.value === null) {
          clause = w.operator === '=' ? `${w.column} IS NULL` : `${w.column} IS NOT NULL`
        } else if (w.operator === 'in' || w.operator === 'not in') {
          const arr = w.value as unknown[]
          clause = `${w.column} ${w.operator.toUpperCase()} (${arr.map(() => '?').join(', ')})`
          params.push(...arr)
        } else {
          clause = `${w.column} ${w.operator} ?`
          params.push(w.value)
        }

        clauses.push(i === 0 ? clause : `${w.boolean.toUpperCase()} ${clause}`)
      }
      sql += ` WHERE ${clauses.join(' ')}`
    }

    return (db.query(sql).get(...(params as Bindings)) as { count: number }).count
  }

  exists(): boolean {
    return this.count() > 0
  }

  paginate(page = 1, perPage = 15) {
    const total = this.count()
    this._limit = perPage
    this._offset = (page - 1) * perPage
    return {
      data: this.get(),
      total,
      page,
      perPage,
      lastPage: Math.ceil(total / perPage),
    }
  }

  pluck<K extends ColumnName<TDef>>(
    column: K
  ): (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[] {
    this._select = [column as string]
    return this.get().map(r => r.get(column as any)) as any
  }

  max<K extends AttributeKeys<TDef>>(column: K): number {
    const db = getDatabase()
    return (db.query(`SELECT MAX(${column}) as v FROM ${this._definition.table}`).get() as { v: number }).v || 0
  }

  min<K extends AttributeKeys<TDef>>(column: K): number {
    const db = getDatabase()
    return (db.query(`SELECT MIN(${column}) as v FROM ${this._definition.table}`).get() as { v: number }).v || 0
  }

  avg<K extends AttributeKeys<TDef>>(column: K): number {
    const db = getDatabase()
    return (db.query(`SELECT AVG(${column}) as v FROM ${this._definition.table}`).get() as { v: number }).v || 0
  }

  sum<K extends AttributeKeys<TDef>>(column: K): number {
    const db = getDatabase()
    return (db.query(`SELECT SUM(${column}) as v FROM ${this._definition.table}`).get() as { v: number }).v || 0
  }

  delete(): number {
    const db = getDatabase()
    const params: unknown[] = []
    let sql = `DELETE FROM ${this._definition.table}`

    if (this._wheres.length > 0) {
      const clauses: string[] = []
      for (let i = 0; i < this._wheres.length; i++) {
        const w = this._wheres[i]
        clauses.push(i === 0 ? `${w.column} ${w.operator} ?` : `${w.boolean.toUpperCase()} ${w.column} ${w.operator} ?`)
        params.push(w.value)
      }
      sql += ` WHERE ${clauses.join(' ')}`
    }

    return db.run(sql, params as Bindings).changes
  }

  update(data: Partial<Pick<InferModelAttributes<TDef>, FillableKeys<TDef>>>): number {
    const db = getDatabase()
    const entries = Object.entries(data)
    const sets = entries.map(([k]) => `${k} = ?`).join(', ')
    const params: unknown[] = entries.map(([, v]) => v)

    let sql = `UPDATE ${this._definition.table} SET ${sets}`

    if (this._wheres.length > 0) {
      const clauses: string[] = []
      for (let i = 0; i < this._wheres.length; i++) {
        const w = this._wheres[i]
        clauses.push(i === 0 ? `${w.column} ${w.operator} ?` : `${w.boolean.toUpperCase()} ${w.column} ${w.operator} ?`)
        params.push(w.value)
      }
      sql += ` WHERE ${clauses.join(' ')}`
    }

    return db.run(sql, params as Bindings).changes
  }
}

/**
 * Create a model class from a definition with full type inference
 */
export function createModel<const TDef extends ModelDefinition>(definition: TDef) {
  type Attrs = ModelAttributes<TDef>
  type Cols = ColumnName<TDef>
  type AttrKeys = AttributeKeys<TDef>
  type Fillable = FillableKeys<TDef>

  const model = {
    query: () => new ModelQueryBuilder<TDef>(definition),

    where<K extends Cols>(
      column: K,
      operatorOrValue: WhereOperator | (K extends keyof Attrs ? Attrs[K] : unknown),
      value?: K extends keyof Attrs ? Attrs[K] : unknown
    ) {
      return new ModelQueryBuilder<TDef>(definition).where(column, operatorOrValue as any, value)
    },

    orWhere<K extends Cols>(
      column: K,
      operatorOrValue: WhereOperator | (K extends keyof Attrs ? Attrs[K] : unknown),
      value?: K extends keyof Attrs ? Attrs[K] : unknown
    ) {
      return new ModelQueryBuilder<TDef>(definition).orWhere(column, operatorOrValue as any, value)
    },

    whereIn<K extends Cols>(column: K, values: (K extends keyof Attrs ? Attrs[K] : unknown)[]) {
      return new ModelQueryBuilder<TDef>(definition).whereIn(column, values)
    },

    whereNotIn<K extends Cols>(column: K, values: (K extends keyof Attrs ? Attrs[K] : unknown)[]) {
      return new ModelQueryBuilder<TDef>(definition).whereNotIn(column, values)
    },

    whereNull<K extends Cols>(column: K) {
      return new ModelQueryBuilder<TDef>(definition).whereNull(column)
    },

    whereNotNull<K extends Cols>(column: K) {
      return new ModelQueryBuilder<TDef>(definition).whereNotNull(column)
    },

    whereLike<K extends Cols>(column: K, pattern: string) {
      return new ModelQueryBuilder<TDef>(definition).whereLike(column, pattern)
    },

    orderBy<K extends Cols>(column: K, direction: 'asc' | 'desc' = 'asc') {
      return new ModelQueryBuilder<TDef>(definition).orderBy(column, direction)
    },

    orderByDesc<K extends Cols>(column: K) {
      return new ModelQueryBuilder<TDef>(definition).orderByDesc(column)
    },

    select<K extends Cols>(...columns: K[]) {
      return new ModelQueryBuilder<TDef>(definition).select(...columns)
    },

    limit: (count: number) => new ModelQueryBuilder<TDef>(definition).limit(count),
    take: (count: number) => new ModelQueryBuilder<TDef>(definition).take(count),
    skip: (count: number) => new ModelQueryBuilder<TDef>(definition).skip(count),

    find(id: number | string): ModelInstance<TDef> | undefined {
      const db = getDatabase()
      const pk = definition.primaryKey || 'id'
      const row = db.query(`SELECT * FROM ${definition.table} WHERE ${pk} = ?`).get(id) as Record<string, unknown> | null
      return row ? new ModelInstance<TDef>(definition, row as any) : undefined
    },

    findOrFail(id: number | string): ModelInstance<TDef> {
      const result = this.find(id)
      if (!result) throw new Error(`${definition.name} with id ${id} not found`)
      return result
    },

    findMany(ids: (number | string)[]): ModelInstance<TDef>[] {
      const db = getDatabase()
      const pk = definition.primaryKey || 'id'
      const rows = db.query(`SELECT * FROM ${definition.table} WHERE ${pk} IN (${ids.map(() => '?').join(', ')})`).all(...(ids as Bindings)) as Record<string, unknown>[]
      return rows.map(row => new ModelInstance<TDef>(definition, row as any))
    },

    all: () => new ModelQueryBuilder<TDef>(definition).get(),
    first: () => new ModelQueryBuilder<TDef>(definition).first(),
    firstOrFail: () => new ModelQueryBuilder<TDef>(definition).firstOrFail(),
    last: () => new ModelQueryBuilder<TDef>(definition).last(),
    count: () => new ModelQueryBuilder<TDef>(definition).count(),
    exists: () => new ModelQueryBuilder<TDef>(definition).exists(),
    paginate: (page?: number, perPage?: number) => new ModelQueryBuilder<TDef>(definition).paginate(page, perPage),

    create(data: Partial<Pick<InferModelAttributes<TDef>, Fillable>>): ModelInstance<TDef> {
      const instance = new ModelInstance<TDef>(definition, data as any)
      instance.save()
      return instance
    },

    createMany(items: Partial<Pick<InferModelAttributes<TDef>, Fillable>>[]): ModelInstance<TDef>[] {
      return items.map(data => this.create(data))
    },

    updateOrCreate(
      search: Partial<Attrs>,
      data: Partial<Pick<InferModelAttributes<TDef>, Fillable>>
    ): ModelInstance<TDef> {
      let query = new ModelQueryBuilder<TDef>(definition)
      for (const [key, value] of Object.entries(search)) {
        query = query.where(key as Cols, value as any)
      }
      const existing = query.first()
      if (existing) {
        existing.update(data)
        return existing
      }
      return this.create({ ...search, ...data } as any)
    },

    firstOrCreate(
      search: Partial<Attrs>,
      data: Partial<Pick<InferModelAttributes<TDef>, Fillable>>
    ): ModelInstance<TDef> {
      let query = new ModelQueryBuilder<TDef>(definition)
      for (const [key, value] of Object.entries(search)) {
        query = query.where(key as Cols, value as any)
      }
      const existing = query.first()
      return existing || this.create({ ...search, ...data } as any)
    },

    destroy(id: number | string): boolean {
      const db = getDatabase()
      const pk = definition.primaryKey || 'id'
      return db.run(`DELETE FROM ${definition.table} WHERE ${pk} = ?`, [id] as Bindings).changes > 0
    },

    remove(id: number | string): boolean {
      return this.destroy(id)
    },

    truncate(): void {
      getDatabase().run(`DELETE FROM ${definition.table}`)
    },

    getDefinition: () => definition,
    getTable: () => definition.table,

    make(data: Partial<Attrs> = {}): ModelInstance<TDef> {
      return new ModelInstance<TDef>(definition, data as any)
    },

    latest: (column: Cols = 'created_at' as Cols) => new ModelQueryBuilder<TDef>(definition).orderByDesc(column),
    oldest: (column: Cols = 'created_at' as Cols) => new ModelQueryBuilder<TDef>(definition).orderBy(column, 'asc'),

    max: <K extends AttrKeys>(column: K) => new ModelQueryBuilder<TDef>(definition).max(column),
    min: <K extends AttrKeys>(column: K) => new ModelQueryBuilder<TDef>(definition).min(column),
    avg: <K extends AttrKeys>(column: K) => new ModelQueryBuilder<TDef>(definition).avg(column),
    sum: <K extends AttrKeys>(column: K) => new ModelQueryBuilder<TDef>(definition).sum(column),

    pluck<K extends Cols>(column: K) {
      return new ModelQueryBuilder<TDef>(definition).pluck(column)
    },
  }

  // Wrap in Proxy to support dynamic whereColumn methods (e.g., whereEmail, whereName)
  return new Proxy(model, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('where') && prop.length > 5) {
        // Extract column name: whereEmail -> email, whereName -> name
        const columnPascal = prop.slice(5) // Remove 'where' prefix
        const column = columnPascal.charAt(0).toLowerCase() + columnPascal.slice(1)

        // Check if this column exists in attributes
        if (column in definition.attributes || column === 'id' || column === definition.primaryKey) {
          return (value: unknown) => new ModelQueryBuilder<TDef>(definition).where(column as Cols, value as any)
        }
      }
      return Reflect.get(target, prop)
    },
  }) as typeof model & {
    [K in AttrKeys as `where${Capitalize<K>}`]: (value: K extends keyof Attrs ? Attrs[K] : unknown) => ModelQueryBuilder<TDef>
  }
}

export function createTableFromModel(definition: ModelDefinition): void {
  const db = getDatabase()
  const pk = definition.primaryKey || 'id'
  const columns: string[] = []

  columns.push(definition.autoIncrement !== false
    ? `${pk} INTEGER PRIMARY KEY AUTOINCREMENT`
    : `${pk} INTEGER PRIMARY KEY`)

  if (definition.traits?.useUuid) columns.push('uuid TEXT UNIQUE')

  for (const [name, attr] of Object.entries(definition.attributes)) {
    let colType = 'TEXT'
    if (attr.type === 'number') colType = 'REAL'
    else if (attr.type === 'boolean') colType = 'INTEGER'
    columns.push(`${name} ${colType}${attr.unique ? ' UNIQUE' : ''}`)
  }

  if (definition.traits?.useTimestamps) {
    columns.push('created_at TEXT', 'updated_at TEXT')
  }
  if (definition.traits?.useSoftDeletes) {
    columns.push('deleted_at TEXT')
  }

  db.run(`CREATE TABLE IF NOT EXISTS ${definition.table} (${columns.join(', ')})`)
}

function createFakerCompatLayer(tsMocker: any): any {
  return new Proxy(tsMocker, {
    get(target, prop) {
      if (prop === 'location') return target.address
      if (prop === 'datatype') {
        return {
          boolean: () => target.random.boolean(),
          number: (opts?: { min?: number; max?: number }) => target.number.int(opts),
          float: (opts?: { min?: number; max?: number }) => target.number.float(opts),
          uuid: () => crypto.randomUUID(),
          string: (length?: number) => target.string.alphanumeric(length ?? 10),
        }
      }
      return target[prop]
    },
  })
}

export async function seedModel(definition: ModelDefinition, count?: number, faker?: any): Promise<void> {
  const db = getDatabase()
  const seedCount = count ?? definition.traits?.useSeeder?.count ?? 10

  if (!faker) {
    try {
      const tsMocker = await import('ts-mocker')
      faker = createFakerCompatLayer(tsMocker.faker)
    } catch {
      console.warn('ts-mocker not found. Install it for seeding support.')
      return
    }
  }

  for (let i = 0; i < seedCount; i++) {
    const data: Record<string, unknown> = {}

    for (const [name, attr] of Object.entries(definition.attributes)) {
      if (attr.factory) data[name] = (attr.factory as (f: unknown) => unknown)(faker)
    }

    if (definition.traits?.useTimestamps) {
      const now = new Date().toISOString()
      data.created_at = now
      data.updated_at = now
    }

    if (definition.traits?.useUuid) data.uuid = crypto.randomUUID()

    const columns = Object.keys(data)
    db.run(
      `INSERT INTO ${definition.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(data) as Bindings
    )
  }
}

export type { ModelInstance, ModelQueryBuilder }
