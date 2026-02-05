/**
 * Dynamic ORM for bun-query-builder
 *
 * Creates fully-featured model classes from Stacks-style model definitions
 * without any code generation. Just define your model and use it.
 *
 * @example
 * ```ts
 * import { createModel } from 'bun-query-builder'
 *
 * const User = createModel({
 *   name: 'User',
 *   table: 'users',
 *   attributes: {
 *     name: { fillable: true },
 *     email: { fillable: true, unique: true },
 *     password: { fillable: true, hidden: true },
 *   }
 * })
 *
 * // Now use Laravel-style API
 * const users = await User.where('active', true).get()
 * const user = await User.find(1)
 * const newUser = await User.create({ name: 'John', email: 'john@example.com' })
 * ```
 */

import { Database } from 'bun:sqlite'

// Types for model definition
export interface ModelAttribute {
  order?: number
  fillable?: boolean
  unique?: boolean
  hidden?: boolean
  guarded?: boolean
  validation?: {
    rule: any
    message?: Record<string, string>
  }
  factory?: (faker: any) => any
}

export interface ModelDefinition {
  name: string
  table: string
  primaryKey?: string
  autoIncrement?: boolean
  connection?: string
  traits?: {
    useUuid?: boolean
    useTimestamps?: boolean
    useSoftDeletes?: boolean
    useSearch?: {
      displayable?: string[]
      searchable?: string[]
      sortable?: string[]
      filterable?: string[]
    }
    useSeeder?: {
      count: number
    }
    useApi?: {
      uri: string
      routes: string[]
    }
  }
  belongsTo?: string[]
  hasMany?: string[]
  hasOne?: string[]
  attributes: Record<string, ModelAttribute>
  get?: Record<string, (attributes: Record<string, any>) => any>
  set?: Record<string, (attributes: Record<string, any>) => any | Promise<any>>
}

type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in' | 'not in'

// Global database instance
let globalDb: Database | null = null

/**
 * Configure the ORM with a database connection
 */
export function configureOrm(options: {
  database?: string | Database
  verbose?: boolean
}): void {
  if (options.database instanceof Database) {
    globalDb = options.database
  } else {
    globalDb = new Database(options.database || ':memory:', {
      create: true,
    })
  }
}

/**
 * Get the current database instance
 */
export function getDatabase(): Database {
  if (!globalDb) {
    // Auto-create in-memory database if not configured
    globalDb = new Database(':memory:', { create: true })
  }
  return globalDb
}

/**
 * Model instance class - represents a single record
 */
class ModelInstance<T extends Record<string, any>> {
  private _attributes: T
  private _original: T
  private _definition: ModelDefinition
  private _hasSaved: boolean = false

  constructor(definition: ModelDefinition, attributes: Partial<T> = {}) {
    this._definition = definition
    this._attributes = { ...attributes } as T
    this._original = { ...attributes } as T
  }

  // Dynamic getter for any attribute
  get(key: keyof T): T[keyof T] {
    // Check for custom getter
    if (this._definition.get?.[key as string]) {
      return this._definition.get[key as string](this._attributes)
    }
    return this._attributes[key]
  }

  // Dynamic setter for any attribute
  set(key: keyof T, value: any): void {
    this._attributes[key] = value
  }

  // Get all attributes
  get attributes(): T {
    return { ...this._attributes }
  }

  // Get primary key value
  get id(): number | undefined {
    const pk = this._definition.primaryKey || 'id'
    return this._attributes[pk as keyof T] as number | undefined
  }

  /**
   * Check if model or specific attribute has been modified
   */
  isDirty(column?: keyof T): boolean {
    if (column) {
      return this._attributes[column] !== this._original[column]
    }
    return Object.keys(this._attributes).some(
      key => this._attributes[key as keyof T] !== this._original[key as keyof T]
    )
  }

  /**
   * Check if model or specific attribute is unchanged
   */
  isClean(column?: keyof T): boolean {
    return !this.isDirty(column)
  }

  /**
   * Check if model was changed after last save
   */
  wasChanged(column?: keyof T): boolean {
    return this._hasSaved && this.isDirty(column)
  }

  /**
   * Get original attribute value(s)
   */
  getOriginal<K extends keyof T>(column?: K): K extends keyof T ? T[K] : T {
    if (column) {
      return this._original[column] as any
    }
    return { ...this._original } as any
  }

  /**
   * Get changed attributes
   */
  getChanges(): Partial<T> {
    const changes: Partial<T> = {}
    for (const key of Object.keys(this._attributes)) {
      if (this._attributes[key as keyof T] !== this._original[key as keyof T]) {
        changes[key as keyof T] = this._attributes[key as keyof T]
      }
    }
    return changes
  }

  /**
   * Fill attributes (respecting fillable/guarded)
   */
  fill(data: Partial<T>): this {
    const fillable = Object.entries(this._definition.attributes)
      .filter(([_, attr]) => attr.fillable)
      .map(([key]) => key)

    const guarded = Object.entries(this._definition.attributes)
      .filter(([_, attr]) => attr.guarded)
      .map(([key]) => key)

    for (const [key, value] of Object.entries(data)) {
      if (!guarded.includes(key) && fillable.includes(key)) {
        this._attributes[key as keyof T] = value as T[keyof T]
      }
    }
    return this
  }

  /**
   * Force fill all attributes (ignoring fillable/guarded)
   */
  forceFill(data: Partial<T>): this {
    for (const [key, value] of Object.entries(data)) {
      this._attributes[key as keyof T] = value as T[keyof T]
    }
    return this
  }

  /**
   * Save the model to database
   */
  async save(): Promise<this> {
    const db = getDatabase()
    const pk = this._definition.primaryKey || 'id'

    // Apply setters
    for (const [key, setter] of Object.entries(this._definition.set || {})) {
      if (this.isDirty(key as keyof T)) {
        const result = setter(this._attributes)
        this._attributes[key as keyof T] = result instanceof Promise ? await result : result
      }
    }

    if (this._attributes[pk as keyof T]) {
      // Update existing record
      const changes = this.getChanges()
      if (Object.keys(changes).length > 0) {
        const sets = Object.keys(changes).map(k => `${k} = ?`).join(', ')
        const values = [...Object.values(changes), this._attributes[pk as keyof T]]

        if (this._definition.traits?.useTimestamps) {
          const now = new Date().toISOString()
          db.run(
            `UPDATE ${this._definition.table} SET ${sets}, updated_at = ? WHERE ${pk} = ?`,
            [...Object.values(changes), now, this._attributes[pk as keyof T]]
          )
        } else {
          db.run(
            `UPDATE ${this._definition.table} SET ${sets} WHERE ${pk} = ?`,
            values
          )
        }
      }
    } else {
      // Insert new record
      const fillable = Object.entries(this._definition.attributes)
        .filter(([_, attr]) => attr.fillable)
        .map(([key]) => key)

      const data: Record<string, any> = {}
      for (const key of fillable) {
        if (this._attributes[key as keyof T] !== undefined) {
          data[key] = this._attributes[key as keyof T]
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
      const values = Object.values(data)

      const result = db.run(
        `INSERT INTO ${this._definition.table} (${columns.join(', ')}) VALUES (${placeholders})`,
        values
      )

      this._attributes[pk as keyof T] = result.lastInsertRowid as T[keyof T]
    }

    this._original = { ...this._attributes }
    this._hasSaved = true
    return this
  }

  /**
   * Update the model
   */
  async update(data: Partial<T>): Promise<this> {
    this.fill(data)
    return this.save()
  }

  /**
   * Delete the model
   */
  async delete(): Promise<boolean> {
    const db = getDatabase()
    const pk = this._definition.primaryKey || 'id'
    const pkValue = this._attributes[pk as keyof T]

    if (!pkValue) {
      throw new Error('Cannot delete a model without a primary key')
    }

    if (this._definition.traits?.useSoftDeletes) {
      db.run(
        `UPDATE ${this._definition.table} SET deleted_at = ? WHERE ${pk} = ?`,
        [new Date().toISOString(), pkValue]
      )
    } else {
      db.run(`DELETE FROM ${this._definition.table} WHERE ${pk} = ?`, [pkValue])
    }

    return true
  }

  /**
   * Refresh the model from database
   */
  async refresh(): Promise<this> {
    const db = getDatabase()
    const pk = this._definition.primaryKey || 'id'
    const pkValue = this._attributes[pk as keyof T]

    if (!pkValue) {
      throw new Error('Cannot refresh a model without a primary key')
    }

    const row = db.query(`SELECT * FROM ${this._definition.table} WHERE ${pk} = ?`).get(pkValue)
    if (row) {
      this._attributes = row as T
      this._original = { ...row } as T
    }

    return this
  }

  /**
   * Convert to JSON (excluding hidden fields)
   */
  toJSON(): Partial<T> {
    const hidden = Object.entries(this._definition.attributes)
      .filter(([_, attr]) => attr.hidden)
      .map(([key]) => key)

    const json = { ...this._attributes }
    for (const field of hidden) {
      delete json[field as keyof T]
    }
    return json
  }
}

/**
 * Query builder class for model queries
 */
class ModelQueryBuilder<T extends Record<string, any>> {
  private _definition: ModelDefinition
  private _wheres: { column: string; operator: WhereOperator; value: any; boolean: 'and' | 'or' }[] = []
  private _orderBy: { column: string; direction: 'asc' | 'desc' }[] = []
  private _limit?: number
  private _offset?: number
  private _select: string[] = ['*']
  private _with: string[] = []

  constructor(definition: ModelDefinition) {
    this._definition = definition
  }

  /**
   * Add a where clause
   */
  where(column: string, operatorOrValue: WhereOperator | any, value?: any): this {
    if (value === undefined) {
      this._wheres.push({ column, operator: '=', value: operatorOrValue, boolean: 'and' })
    } else {
      this._wheres.push({ column, operator: operatorOrValue, value, boolean: 'and' })
    }
    return this
  }

  /**
   * Add an OR where clause
   */
  orWhere(column: string, operatorOrValue: WhereOperator | any, value?: any): this {
    if (value === undefined) {
      this._wheres.push({ column, operator: '=', value: operatorOrValue, boolean: 'or' })
    } else {
      this._wheres.push({ column, operator: operatorOrValue, value, boolean: 'or' })
    }
    return this
  }

  /**
   * Where column is in array
   */
  whereIn(column: string, values: any[]): this {
    this._wheres.push({ column, operator: 'in', value: values, boolean: 'and' })
    return this
  }

  /**
   * Where column is not in array
   */
  whereNotIn(column: string, values: any[]): this {
    this._wheres.push({ column, operator: 'not in', value: values, boolean: 'and' })
    return this
  }

  /**
   * Where column is null
   */
  whereNull(column: string): this {
    this._wheres.push({ column, operator: '=', value: null, boolean: 'and' })
    return this
  }

  /**
   * Where column is not null
   */
  whereNotNull(column: string): this {
    this._wheres.push({ column, operator: '!=', value: null, boolean: 'and' })
    return this
  }

  /**
   * Where column matches pattern
   */
  whereLike(column: string, pattern: string): this {
    this._wheres.push({ column, operator: 'like', value: pattern, boolean: 'and' })
    return this
  }

  /**
   * Order by column
   */
  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    this._orderBy.push({ column, direction })
    return this
  }

  /**
   * Order by descending
   */
  orderByDesc(column: string): this {
    return this.orderBy(column, 'desc')
  }

  /**
   * Order by ascending
   */
  orderByAsc(column: string): this {
    return this.orderBy(column, 'asc')
  }

  /**
   * Limit results
   */
  limit(count: number): this {
    this._limit = count
    return this
  }

  /**
   * Alias for limit
   */
  take(count: number): this {
    return this.limit(count)
  }

  /**
   * Offset results
   */
  offset(count: number): this {
    this._offset = count
    return this
  }

  /**
   * Alias for offset
   */
  skip(count: number): this {
    return this.offset(count)
  }

  /**
   * Select specific columns
   */
  select(...columns: string[]): this {
    this._select = columns
    return this
  }

  /**
   * Eager load relations
   */
  with(...relations: string[]): this {
    this._with.push(...relations)
    return this
  }

  /**
   * Build the SQL query
   */
  private buildQuery(): { sql: string; params: any[] } {
    const params: any[] = []
    let sql = `SELECT ${this._select.join(', ')} FROM ${this._definition.table}`

    // Build WHERE clause
    if (this._wheres.length > 0) {
      const whereClauses: string[] = []
      for (let i = 0; i < this._wheres.length; i++) {
        const w = this._wheres[i]
        let clause = ''

        if (w.value === null) {
          clause = w.operator === '=' ? `${w.column} IS NULL` : `${w.column} IS NOT NULL`
        } else if (w.operator === 'in' || w.operator === 'not in') {
          const placeholders = w.value.map(() => '?').join(', ')
          clause = `${w.column} ${w.operator.toUpperCase()} (${placeholders})`
          params.push(...w.value)
        } else {
          clause = `${w.column} ${w.operator} ?`
          params.push(w.value)
        }

        if (i === 0) {
          whereClauses.push(clause)
        } else {
          whereClauses.push(`${w.boolean.toUpperCase()} ${clause}`)
        }
      }
      sql += ` WHERE ${whereClauses.join(' ')}`
    }

    // Build ORDER BY clause
    if (this._orderBy.length > 0) {
      const orderClauses = this._orderBy.map(o => `${o.column} ${o.direction.toUpperCase()}`)
      sql += ` ORDER BY ${orderClauses.join(', ')}`
    }

    // Build LIMIT/OFFSET
    if (this._limit !== undefined) {
      sql += ` LIMIT ${this._limit}`
    }
    if (this._offset !== undefined) {
      sql += ` OFFSET ${this._offset}`
    }

    return { sql, params }
  }

  /**
   * Execute query and get all results
   */
  async get(): Promise<ModelInstance<T>[]> {
    const db = getDatabase()
    const { sql, params } = this.buildQuery()
    const rows = db.query(sql).all(...params)
    return rows.map(row => new ModelInstance<T>(this._definition, row as T))
  }

  /**
   * Get the first result
   */
  async first(): Promise<ModelInstance<T> | undefined> {
    this._limit = 1
    const results = await this.get()
    return results[0]
  }

  /**
   * Get the first result or throw
   */
  async firstOrFail(): Promise<ModelInstance<T>> {
    const result = await this.first()
    if (!result) {
      throw new Error(`No ${this._definition.name} found`)
    }
    return result
  }

  /**
   * Get the last result
   */
  async last(): Promise<ModelInstance<T> | undefined> {
    const pk = this._definition.primaryKey || 'id'
    this._orderBy = [{ column: pk, direction: 'desc' }]
    this._limit = 1
    const results = await this.get()
    return results[0]
  }

  /**
   * Count results
   */
  async count(): Promise<number> {
    const db = getDatabase()
    const params: any[] = []
    let sql = `SELECT COUNT(*) as count FROM ${this._definition.table}`

    if (this._wheres.length > 0) {
      const whereClauses: string[] = []
      for (let i = 0; i < this._wheres.length; i++) {
        const w = this._wheres[i]
        let clause = ''

        if (w.value === null) {
          clause = w.operator === '=' ? `${w.column} IS NULL` : `${w.column} IS NOT NULL`
        } else if (w.operator === 'in' || w.operator === 'not in') {
          const placeholders = w.value.map(() => '?').join(', ')
          clause = `${w.column} ${w.operator.toUpperCase()} (${placeholders})`
          params.push(...w.value)
        } else {
          clause = `${w.column} ${w.operator} ?`
          params.push(w.value)
        }

        if (i === 0) {
          whereClauses.push(clause)
        } else {
          whereClauses.push(`${w.boolean.toUpperCase()} ${clause}`)
        }
      }
      sql += ` WHERE ${whereClauses.join(' ')}`
    }

    const result = db.query(sql).get(...params) as { count: number }
    return result.count
  }

  /**
   * Check if any results exist
   */
  async exists(): Promise<boolean> {
    return (await this.count()) > 0
  }

  /**
   * Paginate results
   */
  async paginate(page: number = 1, perPage: number = 15): Promise<{
    data: ModelInstance<T>[]
    total: number
    page: number
    perPage: number
    lastPage: number
  }> {
    const total = await this.count()
    const lastPage = Math.ceil(total / perPage)

    this._limit = perPage
    this._offset = (page - 1) * perPage

    const data = await this.get()

    return {
      data,
      total,
      page,
      perPage,
      lastPage,
    }
  }

  /**
   * Pluck a single column
   */
  async pluck<K extends keyof T>(column: K): Promise<T[K][]> {
    this._select = [column as string]
    const results = await this.get()
    return results.map(r => r.get(column))
  }

  /**
   * Get max value of column
   */
  async max(column: string): Promise<number> {
    const db = getDatabase()
    const result = db.query(`SELECT MAX(${column}) as max FROM ${this._definition.table}`).get() as { max: number }
    return result.max || 0
  }

  /**
   * Get min value of column
   */
  async min(column: string): Promise<number> {
    const db = getDatabase()
    const result = db.query(`SELECT MIN(${column}) as min FROM ${this._definition.table}`).get() as { min: number }
    return result.min || 0
  }

  /**
   * Get average value of column
   */
  async avg(column: string): Promise<number> {
    const db = getDatabase()
    const result = db.query(`SELECT AVG(${column}) as avg FROM ${this._definition.table}`).get() as { avg: number }
    return result.avg || 0
  }

  /**
   * Get sum of column
   */
  async sum(column: string): Promise<number> {
    const db = getDatabase()
    const result = db.query(`SELECT SUM(${column}) as sum FROM ${this._definition.table}`).get() as { sum: number }
    return result.sum || 0
  }

  /**
   * Delete matching records
   */
  async delete(): Promise<number> {
    const db = getDatabase()
    const params: any[] = []
    let sql = `DELETE FROM ${this._definition.table}`

    if (this._wheres.length > 0) {
      const whereClauses: string[] = []
      for (let i = 0; i < this._wheres.length; i++) {
        const w = this._wheres[i]
        let clause = `${w.column} ${w.operator} ?`
        params.push(w.value)

        if (i === 0) {
          whereClauses.push(clause)
        } else {
          whereClauses.push(`${w.boolean.toUpperCase()} ${clause}`)
        }
      }
      sql += ` WHERE ${whereClauses.join(' ')}`
    }

    const result = db.run(sql, params)
    return result.changes
  }

  /**
   * Update matching records
   */
  async update(data: Partial<T>): Promise<number> {
    const db = getDatabase()
    const params: any[] = []

    const sets = Object.keys(data).map(k => `${k} = ?`).join(', ')
    params.push(...Object.values(data))

    let sql = `UPDATE ${this._definition.table} SET ${sets}`

    if (this._wheres.length > 0) {
      const whereClauses: string[] = []
      for (let i = 0; i < this._wheres.length; i++) {
        const w = this._wheres[i]
        let clause = `${w.column} ${w.operator} ?`
        params.push(w.value)

        if (i === 0) {
          whereClauses.push(clause)
        } else {
          whereClauses.push(`${w.boolean.toUpperCase()} ${clause}`)
        }
      }
      sql += ` WHERE ${whereClauses.join(' ')}`
    }

    const result = db.run(sql, params)
    return result.changes
  }
}

/**
 * Create a model class from a definition
 */
export function createModel<T extends Record<string, any> = Record<string, any>>(
  definition: ModelDefinition
) {
  // Create a class with static methods
  const ModelClass = class {
    private static _definition = definition

    /**
     * Create a new query builder
     */
    static query(): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition)
    }

    /**
     * Start a where query
     */
    static where(column: string, operatorOrValue: WhereOperator | any, value?: any): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).where(column, operatorOrValue, value)
    }

    /**
     * Start an orWhere query
     */
    static orWhere(column: string, operatorOrValue: WhereOperator | any, value?: any): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).orWhere(column, operatorOrValue, value)
    }

    /**
     * Where in array
     */
    static whereIn(column: string, values: any[]): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).whereIn(column, values)
    }

    /**
     * Where not in array
     */
    static whereNotIn(column: string, values: any[]): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).whereNotIn(column, values)
    }

    /**
     * Where null
     */
    static whereNull(column: string): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).whereNull(column)
    }

    /**
     * Where not null
     */
    static whereNotNull(column: string): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).whereNotNull(column)
    }

    /**
     * Where like
     */
    static whereLike(column: string, pattern: string): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).whereLike(column, pattern)
    }

    /**
     * Order by
     */
    static orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).orderBy(column, direction)
    }

    /**
     * Order by descending
     */
    static orderByDesc(column: string): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).orderByDesc(column)
    }

    /**
     * Select columns
     */
    static select(...columns: string[]): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).select(...columns)
    }

    /**
     * Limit results
     */
    static limit(count: number): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).limit(count)
    }

    /**
     * Alias for limit
     */
    static take(count: number): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).take(count)
    }

    /**
     * Skip/offset results
     */
    static skip(count: number): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).skip(count)
    }

    /**
     * Eager load relations
     */
    static with(...relations: string[]): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).with(...relations)
    }

    /**
     * Find by primary key
     */
    static async find(id: number | string): Promise<ModelInstance<T> | undefined> {
      const db = getDatabase()
      const pk = definition.primaryKey || 'id'
      const row = db.query(`SELECT * FROM ${definition.table} WHERE ${pk} = ?`).get(id)
      return row ? new ModelInstance<T>(definition, row as T) : undefined
    }

    /**
     * Find by primary key or throw
     */
    static async findOrFail(id: number | string): Promise<ModelInstance<T>> {
      const result = await this.find(id)
      if (!result) {
        throw new Error(`${definition.name} with id ${id} not found`)
      }
      return result
    }

    /**
     * Find multiple by primary keys
     */
    static async findMany(ids: (number | string)[]): Promise<ModelInstance<T>[]> {
      const db = getDatabase()
      const pk = definition.primaryKey || 'id'
      const placeholders = ids.map(() => '?').join(', ')
      const rows = db.query(`SELECT * FROM ${definition.table} WHERE ${pk} IN (${placeholders})`).all(...ids)
      return rows.map(row => new ModelInstance<T>(definition, row as T))
    }

    /**
     * Get all records
     */
    static async all(): Promise<ModelInstance<T>[]> {
      return new ModelQueryBuilder<T>(definition).get()
    }

    /**
     * Get the first record
     */
    static async first(): Promise<ModelInstance<T> | undefined> {
      return new ModelQueryBuilder<T>(definition).first()
    }

    /**
     * Get the first record or throw
     */
    static async firstOrFail(): Promise<ModelInstance<T>> {
      return new ModelQueryBuilder<T>(definition).firstOrFail()
    }

    /**
     * Get the last record
     */
    static async last(): Promise<ModelInstance<T> | undefined> {
      return new ModelQueryBuilder<T>(definition).last()
    }

    /**
     * Count all records
     */
    static async count(): Promise<number> {
      return new ModelQueryBuilder<T>(definition).count()
    }

    /**
     * Check if any records exist
     */
    static async exists(): Promise<boolean> {
      return new ModelQueryBuilder<T>(definition).exists()
    }

    /**
     * Paginate results
     */
    static async paginate(page?: number, perPage?: number) {
      return new ModelQueryBuilder<T>(definition).paginate(page, perPage)
    }

    /**
     * Create a new record
     */
    static async create(data: Partial<T>): Promise<ModelInstance<T>> {
      const instance = new ModelInstance<T>(definition, data)
      await instance.save()
      return instance
    }

    /**
     * Create multiple records
     */
    static async createMany(items: Partial<T>[]): Promise<ModelInstance<T>[]> {
      return Promise.all(items.map(data => this.create(data)))
    }

    /**
     * Update or create a record
     */
    static async updateOrCreate(
      search: Partial<T>,
      data: Partial<T>
    ): Promise<ModelInstance<T>> {
      let query = new ModelQueryBuilder<T>(definition)
      for (const [key, value] of Object.entries(search)) {
        query = query.where(key, value)
      }

      const existing = await query.first()
      if (existing) {
        await existing.update(data)
        return existing
      }

      return this.create({ ...search, ...data })
    }

    /**
     * Find first or create a record
     */
    static async firstOrCreate(
      search: Partial<T>,
      data: Partial<T>
    ): Promise<ModelInstance<T>> {
      let query = new ModelQueryBuilder<T>(definition)
      for (const [key, value] of Object.entries(search)) {
        query = query.where(key, value)
      }

      const existing = await query.first()
      if (existing) {
        return existing
      }

      return this.create({ ...search, ...data })
    }

    /**
     * Delete a record by ID
     */
    static async destroy(id: number | string): Promise<boolean> {
      const db = getDatabase()
      const pk = definition.primaryKey || 'id'
      const result = db.run(`DELETE FROM ${definition.table} WHERE ${pk} = ?`, [id])
      return result.changes > 0
    }

    /**
     * Alias for destroy
     */
    static async remove(id: number | string): Promise<boolean> {
      return this.destroy(id)
    }

    /**
     * Truncate the table
     */
    static async truncate(): Promise<void> {
      const db = getDatabase()
      db.run(`DELETE FROM ${definition.table}`)
    }

    /**
     * Get the model definition
     */
    static getDefinition(): ModelDefinition {
      return definition
    }

    /**
     * Get the table name
     */
    static getTable(): string {
      return definition.table
    }

    /**
     * Create a new model instance (not saved to DB)
     */
    static make(data: Partial<T> = {}): ModelInstance<T> {
      return new ModelInstance<T>(definition, data)
    }

    /**
     * Latest records
     */
    static latest(column: string = 'created_at'): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).orderByDesc(column)
    }

    /**
     * Oldest records
     */
    static oldest(column: string = 'created_at'): ModelQueryBuilder<T> {
      return new ModelQueryBuilder<T>(definition).orderBy(column, 'asc')
    }

    /**
     * Max aggregation
     */
    static async max(column: string): Promise<number> {
      return new ModelQueryBuilder<T>(definition).max(column)
    }

    /**
     * Min aggregation
     */
    static async min(column: string): Promise<number> {
      return new ModelQueryBuilder<T>(definition).min(column)
    }

    /**
     * Avg aggregation
     */
    static async avg(column: string): Promise<number> {
      return new ModelQueryBuilder<T>(definition).avg(column)
    }

    /**
     * Sum aggregation
     */
    static async sum(column: string): Promise<number> {
      return new ModelQueryBuilder<T>(definition).sum(column)
    }

    /**
     * Pluck column values
     */
    static async pluck<K extends keyof T>(column: K): Promise<T[K][]> {
      return new ModelQueryBuilder<T>(definition).pluck(column)
    }
  }

  // Add dynamic where methods for each column (whereEmail, whereName, etc.)
  for (const [column] of Object.entries(definition.attributes)) {
    const methodName = `where${column.charAt(0).toUpperCase()}${column.slice(1)}`
    ;(ModelClass as any)[methodName] = function(value: any) {
      return new ModelQueryBuilder<T>(definition).where(column, value)
    }
  }

  return ModelClass
}

/**
 * Create table from model definition
 */
export function createTableFromModel(definition: ModelDefinition): void {
  const db = getDatabase()
  const pk = definition.primaryKey || 'id'

  const columns: string[] = []

  // Add primary key
  if (definition.autoIncrement !== false) {
    columns.push(`${pk} INTEGER PRIMARY KEY AUTOINCREMENT`)
  } else {
    columns.push(`${pk} INTEGER PRIMARY KEY`)
  }

  // Add UUID if enabled
  if (definition.traits?.useUuid) {
    columns.push('uuid TEXT UNIQUE')
  }

  // Add attribute columns
  for (const [name, attr] of Object.entries(definition.attributes)) {
    let colDef = name

    // Determine column type from validation or default to TEXT
    if (attr.validation?.rule) {
      const rule = attr.validation.rule
      if (typeof rule?.isNumber === 'function' || String(rule).includes('number')) {
        colDef += ' REAL'
      } else if (typeof rule?.isBoolean === 'function' || String(rule).includes('boolean')) {
        colDef += ' INTEGER'
      } else {
        colDef += ' TEXT'
      }
    } else {
      colDef += ' TEXT'
    }

    if (attr.unique) {
      colDef += ' UNIQUE'
    }

    columns.push(colDef)
  }

  // Add timestamps if enabled
  if (definition.traits?.useTimestamps) {
    columns.push('created_at TEXT')
    columns.push('updated_at TEXT')
  }

  // Add soft deletes if enabled
  if (definition.traits?.useSoftDeletes) {
    columns.push('deleted_at TEXT')
  }

  const sql = `CREATE TABLE IF NOT EXISTS ${definition.table} (${columns.join(', ')})`
  db.run(sql)
}

/**
 * Create a @faker-js/faker compatible wrapper around ts-mocker
 * Maps: location -> address, adds datatype module
 */
function createFakerCompatLayer(tsMocker: any): any {
  return new Proxy(tsMocker, {
    get(target, prop) {
      // Map @faker-js/faker's 'location' to ts-mocker's 'address'
      if (prop === 'location') {
        return target.address
      }
      // Add datatype module compatibility
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

/**
 * Seed a model with fake data using ts-mocker
 */
export async function seedModel(
  definition: ModelDefinition,
  count?: number,
  faker?: any
): Promise<void> {
  const db = getDatabase()
  const seedCount = count ?? definition.traits?.useSeeder?.count ?? 10

  // Try to import ts-mocker if not provided
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
    const data: Record<string, any> = {}

    // Generate data using factories
    for (const [name, attr] of Object.entries(definition.attributes)) {
      if (attr.factory) {
        data[name] = attr.factory(faker)
      }
    }

    // Add timestamps
    if (definition.traits?.useTimestamps) {
      const now = new Date().toISOString()
      data.created_at = now
      data.updated_at = now
    }

    // Add UUID
    if (definition.traits?.useUuid) {
      data.uuid = crypto.randomUUID()
    }

    const columns = Object.keys(data)
    const placeholders = columns.map(() => '?').join(', ')
    const values = Object.values(data)

    db.run(
      `INSERT INTO ${definition.table} (${columns.join(', ')}) VALUES (${placeholders})`,
      values
    )
  }
}

// Export types
export type { ModelInstance, ModelQueryBuilder }
