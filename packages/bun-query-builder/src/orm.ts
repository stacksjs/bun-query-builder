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
import type { Faker } from 'ts-mocker'

// Lazy reference to model registry to avoid circular dependency
let _getModel: ((name: string) => any) | null = null
function getModelFromRegistry(name: string): any {
  if (!_getModel) {
    try { _getModel = require('./model').getModel } catch { _getModel = () => undefined }
  }
  return _getModel!(name)
}

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
  factory?: (faker: Faker) => InferType<T>
}

/** Structural type for model instances passed to lifecycle hooks. */
// eslint-disable-next-line ts/no-empty-object-type
export interface ModelHookInstance extends Record<string, unknown> {
  get(key: string): unknown
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
    readonly useTimestamps?: boolean | object
    readonly timestampable?: boolean | object
    readonly useSoftDeletes?: boolean | object
    readonly softDeletable?: boolean | object
    readonly useSearch?: boolean | {
      readonly displayable?: readonly string[]
      readonly searchable?: readonly string[]
      readonly sortable?: readonly string[]
      readonly filterable?: readonly string[]
    }
    readonly useSeeder?: boolean | {
      readonly count: number
    }
    readonly seedable?: boolean | {
      readonly count: number
    }
    readonly useApi?: boolean | {
      readonly uri?: string
      readonly routes?: readonly string[]
      readonly middleware?: readonly string[]
    }
    readonly useAuth?: boolean | {
      readonly usePasskey?: boolean
      readonly useTwoFactor?: boolean
    }
    readonly authenticatable?: boolean | object
    readonly observe?: boolean | readonly string[]
    readonly billable?: boolean
    readonly likeable?: boolean | object
    readonly taggable?: boolean
    readonly categorizable?: boolean
    readonly commentables?: boolean
    readonly useActivityLog?: boolean | object
    readonly useSocials?: readonly string[]
  }
  readonly belongsTo?: readonly string[] | Readonly<Record<string, string>>
  readonly hasMany?: readonly string[] | Readonly<Record<string, string>>
  readonly hasOne?: readonly string[] | Readonly<Record<string, string>>
  readonly belongsToMany?: readonly (string | object)[] | Readonly<Record<string, string | object>>
  readonly hasOneThrough?: readonly (string | object)[] | Readonly<Record<string, string | object>>
  readonly hasManyThrough?: readonly (string | object)[] | Readonly<Record<string, string | object>>
  readonly morphOne?: string | object | Readonly<Record<string, string>>
  readonly morphMany?: readonly (string | object)[] | Readonly<Record<string, string | object>>
  readonly morphTo?: object
  readonly morphToMany?: readonly string[]
  readonly morphedByMany?: readonly string[]
  readonly attributes: {
    readonly [key: string]: TypedAttribute<unknown>
  }
  readonly get?: Record<string, (attributes: Record<string, unknown>) => unknown>
  readonly set?: Record<string, (attributes: Record<string, unknown>) => unknown>
  readonly scopes?: Record<string, (value: unknown) => unknown>
  readonly indexes?: readonly object[]
  readonly dashboard?: { readonly highlight?: boolean | number }
  readonly hooks?: {
    readonly beforeCreate?: (data: Record<string, unknown>) => void | Promise<void>
    readonly afterCreate?: (model: ModelHookInstance) => void | Promise<void>
    readonly beforeUpdate?: (model: ModelHookInstance, data: Record<string, unknown>) => void | Promise<void>
    readonly afterUpdate?: (model: ModelHookInstance) => void | Promise<void>
    readonly beforeDelete?: (model: ModelHookInstance) => void | Promise<void>
    readonly afterDelete?: (model: ModelHookInstance) => void | Promise<void>
  }
}

// Extract attribute keys from definition
type AttributeKeys<TDef extends ModelDefinition> = keyof TDef['attributes'] & string

// Infer single attribute type
type InferAttributeType<TAttr> =
  TAttr extends { type: infer T } ? InferType<T> :
  TAttr extends { factory: (faker: Faker) => infer R } ? R :
  unknown

// Build the full attributes type from definition
type InferModelAttributes<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: InferAttributeType<TDef['attributes'][K]>
}

// System fields added by traits
type SystemFields<TDef extends ModelDefinition> =
  { id: number } &
  (TDef['traits'] extends { useUuid: true } ? { uuid: string } : {}) &
  (TDef['traits'] extends { useTimestamps: true } ? { created_at: string; updated_at: string | null } : {}) &
  (TDef['traits'] extends { timestampable: true | object } ? { created_at: string; updated_at: string | null } : {}) &
  (TDef['traits'] extends { useSoftDeletes: true } ? { deleted_at: string | null } : {}) &
  (TDef['traits'] extends { softDeletable: true | object } ? { deleted_at: string | null } : {}) &
  (TDef['traits'] extends { useAuth: true | object } ? { two_factor_secret: string | null; public_key: string | null } : {}) &
  (TDef['traits'] extends { billable: true | object } ? { stripe_id: string | null } : {})

// Complete model type
type ModelAttributes<TDef extends ModelDefinition> =
  InferModelAttributes<TDef> & SystemFields<TDef>

// All valid column names
type ColumnName<TDef extends ModelDefinition> =
  | AttributeKeys<TDef>
  | 'id'
  | (TDef['traits'] extends { useUuid: true } ? 'uuid' : never)
  | (TDef['traits'] extends { useTimestamps: true } ? 'created_at' | 'updated_at' : never)
  | (TDef['traits'] extends { timestampable: true | object } ? 'created_at' | 'updated_at' : never)
  | (TDef['traits'] extends { useSoftDeletes: true } ? 'deleted_at' : never)
  | (TDef['traits'] extends { softDeletable: true | object } ? 'deleted_at' : never)
  | (TDef['traits'] extends { useAuth: true | object } ? 'two_factor_secret' | 'public_key' : never)
  | (TDef['traits'] extends { billable: true | object } ? 'stripe_id' : never)

// Hidden fields
type HiddenKeys<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: TDef['attributes'][K] extends { hidden: true } ? K : never
}[AttributeKeys<TDef>]

// Fillable fields
type FillableKeys<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: TDef['attributes'][K] extends { fillable: true } ? K : never
}[AttributeKeys<TDef>]

// Numeric attribute columns — constrains aggregate methods (sum, avg, etc.)
type NumericColumns<TDef extends ModelDefinition> = {
  [K in AttributeKeys<TDef>]: TDef['attributes'][K] extends { type: 'number' } ? K : never
}[AttributeKeys<TDef>]

// Infer relation names from model definition (supports both array and object syntax)
type InferBelongsToNames<TDef> =
  (TDef extends { belongsTo: readonly (infer R)[] }
    ? R extends string ? Lowercase<R> : never : never)
  | (TDef extends { belongsTo: Readonly<Record<infer K, unknown>> }
    ? K extends string ? K : never : never)

type InferHasManyNames<TDef> =
  (TDef extends { hasMany: readonly (infer R)[] }
    ? R extends string ? Lowercase<R> : never : never)
  | (TDef extends { hasMany: Readonly<Record<infer K, unknown>> }
    ? K extends string ? K : never : never)

type InferHasOneNames<TDef> =
  (TDef extends { hasOne: readonly (infer R)[] }
    ? R extends string ? Lowercase<R> : never : never)
  | (TDef extends { hasOne: Readonly<Record<infer K, unknown>> }
    ? K extends string ? K : never : never)

type InferBelongsToManyNames<TDef> =
  (TDef extends { belongsToMany: readonly (infer R)[] }
    ? R extends string ? Lowercase<R> : R extends { model: infer M extends string } ? Lowercase<M> : never : never)
  | (TDef extends { belongsToMany: Readonly<Record<infer K, unknown>> }
    ? K extends string ? K : never : never)

type InferHasOneThroughNames<TDef> =
  (TDef extends { hasOneThrough: readonly (infer R)[] }
    ? R extends string ? Lowercase<R> : R extends { model: infer M extends string } ? Lowercase<M> : never : never)
  | (TDef extends { hasOneThrough: Readonly<Record<infer K, unknown>> }
    ? K extends string ? K : never : never)

type InferHasManyThroughNames<TDef> =
  (TDef extends { hasManyThrough: readonly (infer R)[] }
    ? R extends string ? Lowercase<R> : R extends { model: infer M extends string } ? Lowercase<M> : never : never)
  | (TDef extends { hasManyThrough: Readonly<Record<infer K, unknown>> }
    ? K extends string ? K : never : never)

export type InferRelationNames<TDef> =
  | InferBelongsToNames<TDef>
  | InferHasManyNames<TDef>
  | InferHasOneNames<TDef>
  | InferBelongsToManyNames<TDef>
  | InferHasOneThroughNames<TDef>
  | InferHasManyThroughNames<TDef>

type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in' | 'not in'

let globalDb: Database | null = null

export function configureOrm(options: { database?: string | Database; verbose?: boolean }): void {
  if (options.database instanceof Database) {
    globalDb = options.database
  }
else {
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
  private _relations: Record<string, ModelInstance<any, any>[] | ModelInstance<any, any> | null> = {}

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

  set<K extends ColumnName<TDef>>(
    key: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): void {
    this._attributes[key as string] = value
  }

  /**
   * Get a loaded relation by name.
   * Returns the related instance(s) if the relation was loaded via .with(),
   * or undefined if the relation wasn't loaded.
   */
  getRelation(name: string): ModelInstance<any, any>[] | ModelInstance<any, any> | null | undefined {
    return this._relations[name]
  }

  /**
   * Set loaded relation data (used internally by eager loading).
   */
  setRelation(name: string, data: ModelInstance<any, any>[] | ModelInstance<any, any> | null): void {
    this._relations[name] = data
  }

  /**
   * Get all loaded relations.
   */
  getLoadedRelations(): Record<string, ModelInstance<any, any>[] | ModelInstance<any, any> | null> {
    return { ...this._relations }
  }

  get attributes(): Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>> {
    return { ...this._attributes } as any
  }

  get id(): number {
    const pk = this._definition.primaryKey || 'id'
    return this._attributes[pk] as number
  }

  isDirty(column?: ColumnName<TDef>): boolean {
    if (column) {
      return this._attributes[column as string] !== this._original[column as string]
    }
    return Object.keys(this._attributes).some(k => this._attributes[k] !== this._original[k])
  }

  isClean(column?: ColumnName<TDef>): boolean {
    return !this.isDirty(column)
  }

  getOriginal<K extends ColumnName<TDef>>(column: K): K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown {
    return this._original[column as string] as any
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
    const hooks = this._definition.hooks

    const setters = this._definition.set || {}
    for (const [key, setter] of Object.entries(setters)) {
      if (this.isDirty(key as ColumnName<TDef>)) {
        this._attributes[key] = setter(this._attributes as Record<string, unknown>)
      }
    }

    if (this._attributes[pk]) {
      // Update
      hooks?.beforeUpdate?.(this as unknown as ModelHookInstance, this.getChanges())

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
        }
    else {
          db.run(`UPDATE ${this._definition.table} SET ${sets} WHERE ${pk} = ?`, values as Bindings)
        }
      }

      hooks?.afterUpdate?.(this as unknown as ModelHookInstance)
    }
    else {
      // Create
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

      hooks?.beforeCreate?.(data)

      const columns = Object.keys(data)
      const placeholders = columns.map(() => '?').join(', ')

      const result = db.run(
        `INSERT INTO ${this._definition.table} (${columns.join(', ')}) VALUES (${placeholders})`,
        Object.values(data) as Bindings
      )

      this._attributes[pk] = result.lastInsertRowid

      hooks?.afterCreate?.(this as unknown as ModelHookInstance)
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
    const hooks = this._definition.hooks

    if (!pkValue) throw new Error('Cannot delete a model without a primary key')

    hooks?.beforeDelete?.(this as unknown as ModelHookInstance)

    if (this._definition.traits?.useSoftDeletes) {
      db.run(
        `UPDATE ${this._definition.table} SET deleted_at = ? WHERE ${pk} = ?`,
        [new Date().toISOString(), pkValue] as Bindings
      )
    }
    else {
      db.run(`DELETE FROM ${this._definition.table} WHERE ${pk} = ?`, [pkValue] as Bindings)
    }

    hooks?.afterDelete?.(this as unknown as ModelHookInstance)

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

  /**
   * Create a copy of this model without the primary key (ready to save as new).
   *
   * @example
   * ```ts
   * const original = User.find(1)
   * const copy = original.replicate()
   * copy.set('email', 'new@example.com')
   * copy.save() // inserts as a new record
   * ```
   */
  replicate(): ModelInstance<TDef, TSelected> {
    const pk = this._definition.primaryKey || 'id'
    const attrs = { ...this._attributes }
    delete attrs[pk]
    delete attrs.uuid
    delete attrs.created_at
    delete attrs.updated_at
    return new ModelInstance<TDef, TSelected>(this._definition, attrs as any)
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

    for (const [relName, relData] of Object.entries(this._relations)) {
      if (Array.isArray(relData)) {
        json[relName] = relData.map(r => r.toJSON())
      }
      else if (relData) {
        json[relName] = relData.toJSON()
      }
      else {
        json[relName] = null
      }
    }

    return json as any
  }

  /** Alias for toJSON() */
  toArray(): Omit<Pick<ModelAttributes<TDef>, TSelected & keyof ModelAttributes<TDef>>, HiddenKeys<TDef>> {
    return this.toJSON()
  }
}

// Memoization caches for hot-path string conversions
const snakeCaseCache = new Map<string, string>()
const tableNameCache = new Map<string, string>()
const relationCache = new Map<string, ReturnType<typeof resolveRelation>>()

/**
 * Convert PascalCase model name to snake_case for foreign key convention.
 * e.g., 'OrderItem' -> 'order_item', 'User' -> 'user'
 */
function toSnakeCase(str: string): string {
  let cached = snakeCaseCache.get(str)
  if (cached !== undefined) return cached
  cached = str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')
  snakeCaseCache.set(str, cached)
  return cached
}

/**
 * Convert PascalCase model name to its conventional table name (snake_case, pluralized).
 * e.g., 'OrderItem' -> 'order_items', 'User' -> 'users', 'Category' -> 'categories'
 */
function toTableName(modelName: string): string {
  let cached = tableNameCache.get(modelName)
  if (cached !== undefined) return cached
  const snake = toSnakeCase(modelName)
  if (snake.endsWith('y') && !snake.endsWith('ay') && !snake.endsWith('ey') && !snake.endsWith('oy') && !snake.endsWith('uy')) {
    cached = snake.slice(0, -1) + 'ies'
  }
  else if (snake.endsWith('s') || snake.endsWith('x') || snake.endsWith('ch') || snake.endsWith('sh')) {
    cached = snake + 'es'
  }
  else {
    cached = snake + 's'
  }
  tableNameCache.set(modelName, cached)
  return cached
}

/**
 * Resolve a relation from its name and the parent model's definition.
 * Uses the model registry to find the related model's definition.
 *
 * Supports both syntaxes:
 *   Array syntax:  hasMany: ['Order']        → relation name is 'order', model is 'Order'
 *   Object syntax: hasMany: { orders: 'Order' } → relation name is 'orders', model is 'Order'
 */
function resolveRelation(definition: ModelDefinition, relationName: string): {
  type: 'hasMany' | 'hasOne' | 'belongsTo' | 'belongsToMany'
  relatedModelName: string
  relatedTable: string
  foreignKey: string
  localKey: string
} | null {
  const parentName = definition.name
  const parentPk = definition.primaryKey || 'id'

  /**
   * Search a relation field for a matching relation name.
   * Handles both array format (['Order']) and object format ({ orders: 'Order' }).
   * Returns the model name if found, or null otherwise.
   */
  function findModelName(
    rel: readonly (string | object)[] | Readonly<Record<string, string | object>> | undefined,
  ): string | null {
    if (!rel) return null

    // Array syntax: hasMany: ['Order'] → relation name is lowercased model name
    if (Array.isArray(rel)) {
      for (const item of rel) {
        const modelName = typeof item === 'string' ? item : (item as any)?.model || ''
        if (modelName && modelName.toLowerCase() === relationName.toLowerCase()) {
          return modelName
        }
      }
      return null
    }

    // Object syntax: hasMany: { orders: 'Order' } → relation name is the key
    if (typeof rel === 'object') {
      for (const [key, value] of Object.entries(rel)) {
        if (key === relationName || key.toLowerCase() === relationName.toLowerCase()) {
          return typeof value === 'string' ? value : (value as any)?.model || (value as any)?.target || key
        }
      }
    }

    return null
  }

  // Check hasMany
  const hasManyModel = findModelName(definition.hasMany)
  if (hasManyModel) {
    const relatedModel = getModelFromRegistry(hasManyModel)
    const relatedTable = relatedModel?.getTable?.() || toTableName(hasManyModel)
    const foreignKey = toSnakeCase(parentName) + '_id'
    return { type: 'hasMany', relatedModelName: hasManyModel, relatedTable, foreignKey, localKey: parentPk }
  }

  // Check hasOne
  const hasOneModel = findModelName(definition.hasOne)
  if (hasOneModel) {
    const relatedModel = getModelFromRegistry(hasOneModel)
    const relatedTable = relatedModel?.getTable?.() || toTableName(hasOneModel)
    const foreignKey = toSnakeCase(parentName) + '_id'
    return { type: 'hasOne', relatedModelName: hasOneModel, relatedTable, foreignKey, localKey: parentPk }
  }

  // Check belongsTo
  const belongsToModel = findModelName(definition.belongsTo)
  if (belongsToModel) {
    const relatedModel = getModelFromRegistry(belongsToModel)
    const relatedTable = relatedModel?.getTable?.() || toTableName(belongsToModel)
    const relatedPk = relatedModel?.getDefinition?.()?.primaryKey || 'id'
    const foreignKey = toSnakeCase(belongsToModel) + '_id'
    return { type: 'belongsTo', relatedModelName: belongsToModel, relatedTable, foreignKey, localKey: relatedPk }
  }

  // Check belongsToMany
  const belongsToManyModel = findModelName(definition.belongsToMany)
  if (belongsToManyModel) {
    const relatedModel = getModelFromRegistry(belongsToManyModel)
    const relatedTable = relatedModel?.getTable?.() || toTableName(belongsToManyModel)
    // Pivot table convention: alphabetical order of both table names
    const tables = [definition.table, relatedTable].sort()
    // eslint-disable-next-line no-unused-vars
    const _pivotTable = tables.join('_')
    const foreignKey = toSnakeCase(parentName) + '_id'
    return { type: 'belongsToMany', relatedModelName: belongsToManyModel, relatedTable, foreignKey, localKey: parentPk }
  }

  return null
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
  private _withRelations: string[] = []

  constructor(definition: TDef) {
    this._definition = definition
  }

  // Two-arg form: .where('column', value)
  where<K extends ColumnName<TDef>>(
    column: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected>

  // Three-arg form: .where('column', operator, value)
  where<K extends ColumnName<TDef>>(
    column: K,
    operator: WhereOperator,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected>

  // Implementation signature (hidden from consumers):
  where<K extends ColumnName<TDef>>(
    column: K,
    operatorOrValue: WhereOperator | unknown,
    value?: unknown
  ): ModelQueryBuilder<TDef, TSelected> {
    if (value === undefined) {
      this._wheres.push({ column: column as string, operator: '=', value: operatorOrValue, boolean: 'and' })
    }
    else {
      this._wheres.push({ column: column as string, operator: operatorOrValue as WhereOperator, value, boolean: 'and' })
    }
    return this
  }

  // Two-arg form: .orWhere('column', value)
  orWhere<K extends ColumnName<TDef>>(
    column: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected>

  // Three-arg form: .orWhere('column', operator, value)
  orWhere<K extends ColumnName<TDef>>(
    column: K,
    operator: WhereOperator,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef, TSelected>

  // Implementation signature (hidden from consumers):
  orWhere<K extends ColumnName<TDef>>(
    column: K,
    operatorOrValue: WhereOperator | unknown,
    value?: unknown
  ): ModelQueryBuilder<TDef, TSelected> {
    if (value === undefined) {
      this._wheres.push({ column: column as string, operator: '=', value: operatorOrValue, boolean: 'or' })
    }
    else {
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

  whereBetween<K extends ColumnName<TDef>>(
    column: K,
    range: [min: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown, max: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown],
  ): ModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: '>=', value: range[0], boolean: 'and' })
    this._wheres.push({ column: column as string, operator: '<=', value: range[1], boolean: 'and' })
    return this
  }

  whereNotBetween<K extends ColumnName<TDef>>(
    column: K,
    range: [min: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown, max: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown],
  ): ModelQueryBuilder<TDef, TSelected> {
    // NOT BETWEEN is equivalent to (col < min OR col > max)
    this._wheres.push({ column: column as string, operator: '<', value: range[0], boolean: 'and' })
    this._wheres.push({ column: column as string, operator: '>', value: range[1], boolean: 'or' })
    return this
  }

  /**
   * Conditionally apply a query modification.
   * When the condition is truthy, the callback is invoked with the builder.
   *
   * @example
   * ```ts
   * User.query()
   *   .when(status, (q) => q.where('status', status))
   *   .when(search, (q) => q.whereLike('name', `%${search}%`))
   *   .get()
   * ```
   */
  when(
    condition: unknown,
    callback: (builder: ModelQueryBuilder<TDef, TSelected>) => ModelQueryBuilder<TDef, TSelected>,
  ): ModelQueryBuilder<TDef, TSelected> {
    if (condition) {
      return callback(this)
    }
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

  with<R extends InferRelationNames<TDef>>(
    ...relations: R[]
  ): ModelQueryBuilder<TDef, TSelected> {
    this._withRelations = relations as string[]
    return this
  }

  getWithRelations(): string[] {
    return this._withRelations
  }

  /**
   * Build WHERE clause string and push params into the given array.
   * Shared by buildQuery, count, aggregates, delete, and update.
   */
  private buildWhereClauses(params: unknown[]): string {
    const clauses: string[] = []
    for (let i = 0; i < this._wheres.length; i++) {
      const w = this._wheres[i]
      let clause: string

      if (w.value === null) {
        clause = w.operator === '=' ? `${w.column} IS NULL` : `${w.column} IS NOT NULL`
      }
      else if (w.operator === 'in' || w.operator === 'not in') {
        const arr = w.value as unknown[]
        clause = `${w.column} ${w.operator.toUpperCase()} (${arr.map(() => '?').join(', ')})`
        params.push(...arr)
      }
      else {
        clause = `${w.column} ${w.operator} ?`
        params.push(w.value)
      }

      clauses.push(i === 0 ? clause : `${w.boolean.toUpperCase()} ${clause}`)
    }
    return clauses.join(' ')
  }

  private buildQuery(): { sql: string; params: unknown[] } {
    const params: unknown[] = []
    let sql = `SELECT ${this._select.join(', ')} FROM ${this._definition.table}`

    if (this._wheres.length > 0) {
      sql += ` WHERE ${this.buildWhereClauses(params)}`
    }

    if (this._orderBy.length > 0) {
      sql += ` ORDER BY ${this._orderBy.map(o => `${o.column} ${o.direction.toUpperCase()}`).join(', ')}`
    }

    if (this._limit !== undefined) sql += ` LIMIT ${this._limit}`
    if (this._offset !== undefined) sql += ` OFFSET ${this._offset}`

    return { sql, params }
  }

  /**
   * Return the raw SQL and parameters for debugging without executing.
   *
   * @example
   * ```ts
   * const { sql, params } = User.where('active', true).toSql()
   * console.log(sql) // SELECT * FROM users WHERE active = ?
   * ```
   */
  toSql(): { sql: string; params: unknown[] } {
    return this.buildQuery()
  }

  /**
   * Eager load relations onto a set of already-fetched instances.
   * Uses separate queries per relation (N+1 prevention via batch loading).
   */
  private eagerLoadRelations(instances: ModelInstance<TDef, TSelected>[]): void {
    if (instances.length === 0 || this._withRelations.length === 0) return

    const db = getDatabase()
    const pk = this._definition.primaryKey || 'id'

    for (const relationName of this._withRelations) {
      // Cache relation resolution per model+relation pair
      const cacheKey = `${this._definition.name}:${relationName}`
      let rel = relationCache.get(cacheKey)
      if (rel === undefined) {
        rel = resolveRelation(this._definition as ModelDefinition, relationName)
        relationCache.set(cacheKey, rel)
      }
      if (!rel) continue

      if (rel.type === 'hasMany' || rel.type === 'hasOne') {
        // Get parent IDs
        const parentIds = instances.map(i => i.get(pk as any)).filter(id => id != null)
        if (parentIds.length === 0) continue

        const placeholders = parentIds.map(() => '?').join(', ')
        const rows = db.query(
          `SELECT * FROM ${rel.relatedTable} WHERE ${rel.foreignKey} IN (${placeholders})`,
        ).all(...(parentIds as any[])) as Record<string, unknown>[]

        // Try to get the related model's definition for proper instances
        const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
        const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || this._definition

        if (rel.type === 'hasMany') {
          // Group by foreign key
          const grouped = new Map<unknown, Record<string, unknown>[]>()
          for (const row of rows) {
            const fkVal = row[rel.foreignKey]
            if (!grouped.has(fkVal)) grouped.set(fkVal, [])
            grouped.get(fkVal)!.push(row)
          }
          for (const instance of instances) {
            const related = grouped.get(instance.get(pk as any)) || []
            instance.setRelation(relationName, related.map(r => new ModelInstance(relDef as any, r as any)))
          }
        }
        else {
          // hasOne - single record per parent
          const byFk = new Map<unknown, Record<string, unknown>>()
          for (const row of rows) {
            byFk.set(row[rel.foreignKey], row)
          }
          for (const instance of instances) {
            const row = byFk.get(instance.get(pk as any))
            instance.setRelation(relationName, row ? new ModelInstance(relDef as any, row as any) : null)
          }
        }
      }

      if (rel.type === 'belongsTo') {
        // Get foreign key values from instances
        const fkValues = instances.map(i => (i as any)._attributes[rel.foreignKey]).filter(v => v != null)
        const uniqueFkValues = [...new Set(fkValues)]
        if (uniqueFkValues.length === 0) continue

        const placeholders = uniqueFkValues.map(() => '?').join(', ')
        const rows = db.query(
          `SELECT * FROM ${rel.relatedTable} WHERE ${rel.localKey} IN (${placeholders})`,
        ).all(...(uniqueFkValues as any[])) as Record<string, unknown>[]

        const relatedModelDef = getModelFromRegistry(rel.relatedModelName)
        const relDef = relatedModelDef?.getDefinition?.() || relatedModelDef?.definition || this._definition

        const byPk = new Map<unknown, Record<string, unknown>>()
        for (const row of rows) {
          byPk.set(row[rel.localKey], row)
        }

        for (const instance of instances) {
          const fkVal = (instance as any)._attributes[rel.foreignKey]
          const row = byPk.get(fkVal)
          instance.setRelation(relationName, row ? new ModelInstance(relDef as any, row as any) : null)
        }
      }
    }
  }

  get(): ModelInstance<TDef, TSelected>[] {
    const db = getDatabase()
    const { sql, params } = this.buildQuery()
    const rows = db.query(sql).all(...(params as Bindings)) as Record<string, unknown>[]
    const instances = rows.map(row => new ModelInstance<TDef, TSelected>(this._definition, row as any))

    // Eager load relations
    if (this._withRelations.length > 0) {
      this.eagerLoadRelations(instances)
    }

    return instances
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
      sql += ` WHERE ${this.buildWhereClauses(params)}`
    }

    return (db.query(sql).get(...(params as Bindings)) as { count: number }).count
  }

  exists(): boolean {
    return this.count() > 0
  }

  doesntExist(): boolean {
    return this.count() === 0
  }

  /**
   * Get a single record, throwing if zero or more than one match.
   *
   * @example
   * ```ts
   * const admin = User.where('role', 'admin').sole()
   * ```
   */
  sole(): ModelInstance<TDef, TSelected> {
    this._limit = 2 // fetch 2 to detect duplicates
    const results = this.get()
    if (results.length === 0) throw new Error(`No ${this._definition.name} found`)
    if (results.length > 1) throw new Error(`Expected one ${this._definition.name}, found multiple`)
    return results[0]
  }

  /**
   * Increment a numeric column by the given amount.
   *
   * @example
   * ```ts
   * Post.where('id', 1).increment('views')
   * Post.where('id', 1).increment('views', 5)
   * ```
   */
  increment<K extends NumericColumns<TDef>>(column: K, amount = 1): number {
    const db = getDatabase()
    const params: unknown[] = [amount]

    let sql = `UPDATE ${this._definition.table} SET ${column as string} = ${column as string} + ?`

    if (this._definition.traits?.useTimestamps) {
      sql += `, updated_at = ?`
      params.push(new Date().toISOString())
    }

    if (this._wheres.length > 0) {
      const clauses = this.buildWhereClauses(params)
      sql += ` WHERE ${clauses}`
    }

    return db.run(sql, params as Bindings).changes
  }

  /**
   * Decrement a numeric column by the given amount.
   *
   * @example
   * ```ts
   * Product.where('id', 1).decrement('stock')
   * Product.where('id', 1).decrement('stock', 3)
   * ```
   */
  decrement<K extends NumericColumns<TDef>>(column: K, amount = 1): number {
    return this.increment(column, -amount)
  }

  /**
   * Process results in chunks to avoid memory issues with large datasets.
   *
   * @example
   * ```ts
   * User.query().chunk(100, (users) => {
   *   for (const user of users) { ... }
   * })
   * ```
   */
  chunk(size: number, callback: (items: ModelInstance<TDef, TSelected>[]) => void | false): void {
    let page = 0
    while (true) {
      const builder = new ModelQueryBuilder<TDef, TSelected>(this._definition)
      // Copy wheres, orders, and relations
      builder._wheres = [...this._wheres]
      builder._orderBy = [...this._orderBy]
      builder._select = [...this._select]
      builder._withRelations = [...this._withRelations]
      builder._limit = size
      builder._offset = page * size

      const results = builder.get()
      if (results.length === 0) break

      const result = callback(results)
      if (result === false) break
      if (results.length < size) break

      page++
    }
  }

  paginate(page = 1, perPage = 15): {
    data: ModelInstance<TDef, TSelected>[]
    total: number
    page: number
    perPage: number
    lastPage: number
    hasMorePages: boolean
    isEmpty: boolean
    from: number | null
    to: number | null
  } {
    const total = this.count()
    const lastPage = Math.ceil(total / perPage)
    this._limit = perPage
    this._offset = (page - 1) * perPage
    const data = this.get()
    return {
      data,
      total,
      page,
      perPage,
      lastPage,
      hasMorePages: page < lastPage,
      isEmpty: data.length === 0,
      from: data.length > 0 ? (page - 1) * perPage + 1 : null,
      to: data.length > 0 ? (page - 1) * perPage + data.length : null,
    }
  }

  pluck<K extends ColumnName<TDef>>(
    column: K
  ): (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[] {
    this._select = [column as string]
    return this.get().map(r => r.get(column as any)) as any
  }

  private aggregate(fn: string, column: string): number | null {
    const db = getDatabase()
    const params: unknown[] = []
    let sql = `SELECT ${fn}(${column}) as v FROM ${this._definition.table}`

    if (this._wheres.length > 0) {
      sql += ` WHERE ${this.buildWhereClauses(params)}`
    }

    return (db.query(sql).get(...(params as Bindings)) as { v: number | null }).v
  }

  max<K extends ColumnName<TDef>>(column: K): number | null {
    return this.aggregate('MAX', column as string)
  }

  min<K extends ColumnName<TDef>>(column: K): number | null {
    return this.aggregate('MIN', column as string)
  }

  avg<K extends NumericColumns<TDef>>(column: K): number {
    return this.aggregate('AVG', column as string) || 0
  }

  sum<K extends NumericColumns<TDef>>(column: K): number {
    return this.aggregate('SUM', column as string) || 0
  }

  delete(): number {
    const db = getDatabase()
    const params: unknown[] = []
    let sql = `DELETE FROM ${this._definition.table}`

    if (this._wheres.length > 0) {
      sql += ` WHERE ${this.buildWhereClauses(params)}`
    }

    return db.run(sql, params as Bindings).changes
  }

  update(data: Partial<Pick<InferModelAttributes<TDef>, FillableKeys<TDef>>>): number {
    const db = getDatabase()
    const entries = Object.entries(data)
    const sets = entries.map(([k]) => `${k} = ?`).join(', ')
    const params: unknown[] = entries.map(([, v]) => v)

    if (this._definition.traits?.useTimestamps) {
      params.push(new Date().toISOString())
    }

    let sql = `UPDATE ${this._definition.table} SET ${sets}${this._definition.traits?.useTimestamps ? ', updated_at = ?' : ''}`

    if (this._wheres.length > 0) {
      sql += ` WHERE ${this.buildWhereClauses(params)}`
    }

    return db.run(sql, params as Bindings).changes
  }
}

/**
 * Overloaded where/orWhere signatures for static model methods.
 * Object literals cannot have overloaded methods, so we express them as an interface
 * and intersect with the concrete model object via a type assertion.
 */
interface StaticWhereOverloads<TDef extends ModelDefinition> {
  where<K extends ColumnName<TDef>>(
    column: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef>
  where<K extends ColumnName<TDef>>(
    column: K,
    operator: WhereOperator,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef>

  orWhere<K extends ColumnName<TDef>>(
    column: K,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef>
  orWhere<K extends ColumnName<TDef>>(
    column: K,
    operator: WhereOperator,
    value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown
  ): ModelQueryBuilder<TDef>
}

/**
 * Create a model class from a definition with full type inference
 */
export function createModel<const TDef extends ModelDefinition>(definition: TDef) {
  type Attrs = ModelAttributes<TDef>
  type Cols = ColumnName<TDef>
  type AttrKeys = AttributeKeys<TDef>
  type Fillable = FillableKeys<TDef>
  type Numeric = NumericColumns<TDef>

  const model = {
    query: () => new ModelQueryBuilder<TDef>(definition),

    where(
      column: Cols,
      operatorOrValue: unknown,
      value?: unknown
    ) {
      return new ModelQueryBuilder<TDef>(definition).where(column, operatorOrValue as any, value as any)
    },

    orWhere(
      column: Cols,
      operatorOrValue: unknown,
      value?: unknown
    ) {
      return new ModelQueryBuilder<TDef>(definition).orWhere(column, operatorOrValue as any, value as any)
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

    with<R extends InferRelationNames<TDef>>(...relations: R[]) {
      return new ModelQueryBuilder<TDef>(definition).with(...relations)
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
      const result = model.find(id)
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
    doesntExist: () => new ModelQueryBuilder<TDef>(definition).doesntExist(),
    paginate: (page?: number, perPage?: number) => new ModelQueryBuilder<TDef>(definition).paginate(page, perPage),

    whereBetween<K extends Cols>(column: K, range: [min: K extends keyof Attrs ? Attrs[K] : unknown, max: K extends keyof Attrs ? Attrs[K] : unknown]) {
      return new ModelQueryBuilder<TDef>(definition).whereBetween(column, range as any)
    },

    whereNotBetween<K extends Cols>(column: K, range: [min: K extends keyof Attrs ? Attrs[K] : unknown, max: K extends keyof Attrs ? Attrs[K] : unknown]) {
      return new ModelQueryBuilder<TDef>(definition).whereNotBetween(column, range as any)
    },

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

    max: <K extends Cols>(column: K) => new ModelQueryBuilder<TDef>(definition).max(column),
    min: <K extends Cols>(column: K) => new ModelQueryBuilder<TDef>(definition).min(column),
    avg: <K extends Numeric>(column: K) => new ModelQueryBuilder<TDef>(definition).avg(column),
    sum: <K extends Numeric>(column: K) => new ModelQueryBuilder<TDef>(definition).sum(column),

    pluck<K extends ColumnName<TDef>>(column: K): (K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown)[] {
      return new ModelQueryBuilder<TDef>(definition).pluck(column)
    },
  }

  // Wrap in Proxy to support dynamic whereColumn methods (e.g., whereEmail, whereName)
  return new Proxy(model, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('where') && prop.length > 5) {
        const columnPascal = prop.slice(5)
        const column = columnPascal.charAt(0).toLowerCase() + columnPascal.slice(1)

        if (column in definition.attributes || column === 'id' || column === definition.primaryKey) {
          return (value: unknown) => new ModelQueryBuilder<TDef>(definition).where(column as ColumnName<TDef>, value as any)
        }
      }
      return Reflect.get(target, prop)
    },
  }) as Omit<typeof model, 'where' | 'orWhere'> & StaticWhereOverloads<TDef> & {
    [K in AttributeKeys<TDef> as `where${Capitalize<K>}`]: (value: K extends keyof ModelAttributes<TDef> ? ModelAttributes<TDef>[K] : unknown) => ModelQueryBuilder<TDef>
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

function createFakerCompatLayer(tsMocker: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(tsMocker, {
    get(target, prop: string) {
      if (prop === 'location') return target.address
      if (prop === 'datatype') {
        const rng = target.random as Record<string, (...args: unknown[]) => unknown> | undefined
        const num = target.number as Record<string, (...args: unknown[]) => unknown> | undefined
        const str = target.string as Record<string, (...args: unknown[]) => unknown> | undefined
        return {
          boolean: () => rng?.boolean?.(),
          number: (opts?: { min?: number; max?: number }) => num?.int?.(opts),
          float: (opts?: { min?: number; max?: number }) => num?.float?.(opts),
          uuid: () => crypto.randomUUID(),
          string: (length?: number) => str?.alphanumeric?.(length ?? 10),
        }
      }
      return target[prop]
    },
  })
}

export async function seedModel(definition: ModelDefinition, count?: number, faker?: Record<string, unknown>): Promise<void> {
  const db = getDatabase()
  const seeder = definition.traits?.useSeeder
  const seedCount = count ?? (typeof seeder === 'object' && seeder ? seeder.count : 10)

  if (!faker) {
    try {
      const tsMocker = await (import('ts-mocker' as string) as Promise<{ faker: Record<string, unknown> }>)
      faker = createFakerCompatLayer(tsMocker.faker)
    }
catch {
      console.warn('ts-mocker not found. Install it for seeding support.')
      return
    }
  }

  for (let i = 0; i < seedCount; i++) {
    const data: Record<string, unknown> = {}

    for (const [name, attr] of Object.entries(definition.attributes)) {
      if (attr.factory) data[name] = (attr.factory as (_f: unknown) => unknown)(faker)
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

export type {
  ModelInstance,
  ModelQueryBuilder,
  ModelAttributes,
  InferModelAttributes,
  InferAttributeType,
  SystemFields,
  ColumnName,
  AttributeKeys,
  FillableKeys,
  HiddenKeys,
}
