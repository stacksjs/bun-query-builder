/**
 * DynamoDB Model - ORM for DynamoDB
 *
 * Provides a fluent, ActiveRecord-style API for working with DynamoDB entities
 * using single-table design patterns.
 *
 * @example
 * ```typescript
 * import { Model } from 'bun-query-builder/dynamodb'
 *
 * class User extends Model {
 *   static tableName = 'my-app'
 *   static pkPrefix = 'USER'
 *   static skPrefix = 'PROFILE'
 *
 *   id!: string
 *   name!: string
 *   email!: string
 *   createdAt!: string
 * }
 *
 * // Create
 * const user = await User.create({ id: '123', name: 'John', email: 'john@example.com' })
 *
 * // Find by ID
 * const found = await User.find('123')
 *
 * // Query with conditions
 * const users = await User.where('status', 'active').limit(10).get()
 *
 * // Update
 * await user.update({ name: 'Jane' })
 *
 * // Delete
 * await user.delete()
 * ```
 */

import { createDynamoDBDriver } from '../drivers/dynamodb'
import type { DynamoDBDriver } from '../drivers/dynamodb'
import { DynamoDBClient, createClient } from './client'

// ============================================================================
// Types
// ============================================================================

export interface ModelConfig {
  region?: string
  endpoint?: string
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
}

export interface ModelQueryBuilder<T extends Model> {
  where(attribute: string, value: any): ModelQueryBuilder<T>
  where(attribute: string, operator: string, value: any): ModelQueryBuilder<T>
  whereIn(attribute: string, values: any[]): ModelQueryBuilder<T>
  whereBetween(attribute: string, start: any, end: any): ModelQueryBuilder<T>
  whereBeginsWith(attribute: string, prefix: string): ModelQueryBuilder<T>
  whereExists(attribute: string): ModelQueryBuilder<T>
  whereNotExists(attribute: string): ModelQueryBuilder<T>
  orderBy(direction: 'asc' | 'desc'): ModelQueryBuilder<T>
  limit(count: number): ModelQueryBuilder<T>
  select(...attributes: string[]): ModelQueryBuilder<T>
  index(indexName: string): ModelQueryBuilder<T>
  consistentRead(): ModelQueryBuilder<T>
  startFrom(key: Record<string, any>): ModelQueryBuilder<T>
  get(): Promise<T[]>
  first(): Promise<T | null>
  count(): Promise<number>
  paginate(pageSize: number, lastKey?: Record<string, any>): Promise<{ items: T[], lastKey?: Record<string, any> }>
}

// ============================================================================
// Global Configuration
// ============================================================================

let globalConfig: ModelConfig = {
  region: process.env.AWS_REGION ?? 'us-east-1',
}

let globalClient: DynamoDBClient | null = null
let globalDriver: DynamoDBDriver | null = null

/**
 * Configure the global DynamoDB connection for all models
 */
export function configureModels(config: ModelConfig): void {
  globalConfig = { ...globalConfig, ...config }
  globalClient = null
  globalDriver = null
}

/**
 * Get the global DynamoDB client
 */
function getClient(): DynamoDBClient {
  if (!globalClient) {
    globalClient = createClient({
      region: globalConfig.region ?? 'us-east-1',
      endpoint: globalConfig.endpoint,
      credentials: globalConfig.credentials,
    })
  }
  return globalClient
}

/**
 * Get the global DynamoDB driver
 */
function getDriver(): DynamoDBDriver {
  if (!globalDriver) {
    globalDriver = createDynamoDBDriver({
      region: globalConfig.region ?? 'us-east-1',
      endpoint: globalConfig.endpoint,
      credentials: globalConfig.credentials,
    })
  }
  return globalDriver
}

// ============================================================================
// Model Base Class
// ============================================================================

/**
 * Abstract base class for DynamoDB models
 *
 * Extend this class to create type-safe DynamoDB entities with
 * Laravel Eloquent-like CRUD operations.
 */
export abstract class Model {
  // ========================================================================
  // Static Configuration (override in subclass)
  // ========================================================================

  /** DynamoDB table name */
  static tableName: string = ''

  /** Partition key attribute name */
  static pkAttribute: string = 'pk'

  /** Sort key attribute name */
  static skAttribute: string = 'sk'

  /** Partition key prefix (e.g., 'USER' for 'USER#123') */
  static pkPrefix: string = ''

  /** Sort key prefix (e.g., 'PROFILE' for 'PROFILE#123') */
  static skPrefix: string = 'METADATA'

  /** Entity type attribute name */
  static entityTypeAttribute: string = '_et'

  /** Key delimiter */
  static keyDelimiter: string = '#'

  /** Primary key field name in the model */
  static primaryKey: string = 'id'

  /** Timestamps fields */
  static timestamps: boolean = true
  static createdAtField: string = 'createdAt'
  static updatedAtField: string = 'updatedAt'

  // ========================================================================
  // Instance Properties
  // ========================================================================

  /** Raw DynamoDB item data */
  protected _attributes: Record<string, any> = {}

  /** Original data (for dirty checking) */
  protected _original: Record<string, any> = {}

  /** Whether this is a new (unsaved) record */
  protected _exists: boolean = false

  // ========================================================================
  // Constructor
  // ========================================================================

  constructor(attributes: Record<string, any> = {}) {
    this._attributes = { ...attributes }
    this._original = { ...attributes }

    // Copy attributes to instance properties
    for (const [key, value] of Object.entries(attributes)) {
      (this as any)[key] = value
    }
  }

  // ========================================================================
  // Static Methods - Query Builders
  // ========================================================================

  /**
   * Start a query builder for this model
   */
  static query<T extends Model>(this: new (...args: any[]) => T): ModelQueryBuilderImpl<T> {
    return new ModelQueryBuilderImpl<T>(this as any)
  }

  /**
   * Find a record by primary key
   */
  static async find<T extends Model>(this: new (...args: any[]) => T, id: string): Promise<T | null> {
    const ModelClass = this as any
    const client = getClient()
    const driver = getDriver()

    const pk = `${ModelClass.pkPrefix}${ModelClass.keyDelimiter}${id}`
    const sk = ModelClass.skPrefix

    try {
      const result = await client.getItem({
        TableName: ModelClass.tableName,
        Key: driver.marshall({
          [ModelClass.pkAttribute]: pk,
          [ModelClass.skAttribute]: sk,
        }),
      })

      if (!result.Item) {
        return null
      }

      const data = driver.unmarshall(result.Item)
      const instance = new ModelClass(data) as T
      ;(instance as any)._exists = true
      return instance
    }
    catch (error) {
      console.error('Find error:', error)
      return null
    }
  }

  /**
   * Find a record or throw an error
   */
  static async findOrFail<T extends Model>(this: new (...args: any[]) => T, id: string): Promise<T> {
    const result = await (this as any).find(id)
    if (!result) {
      throw new Error(`${(this as any).name} not found with id: ${id}`)
    }
    return result
  }

  /**
   * Get all records (use with caution on large tables)
   */
  static async all<T extends Model>(this: new (...args: any[]) => T): Promise<T[]> {
    return (this as any).query().get()
  }

  /**
   * Create a new record
   */
  static async create<T extends Model>(this: new (...args: any[]) => T, attributes: Record<string, any>): Promise<T> {
    const ModelClass = this as any
    const client = getClient()
    const driver = getDriver()

    const id = attributes[ModelClass.primaryKey]
    if (!id) {
      throw new Error(`${ModelClass.primaryKey} is required`)
    }

    const pk = `${ModelClass.pkPrefix}${ModelClass.keyDelimiter}${id}`
    const sk = ModelClass.skPrefix

    const now = new Date().toISOString()
    const item: Record<string, any> = {
      ...attributes,
      [ModelClass.pkAttribute]: pk,
      [ModelClass.skAttribute]: sk,
      [ModelClass.entityTypeAttribute]: ModelClass.name,
    }

    if (ModelClass.timestamps) {
      item[ModelClass.createdAtField] = now
      item[ModelClass.updatedAtField] = now
    }

    await client.putItem({
      TableName: ModelClass.tableName,
      Item: driver.marshall(item),
      ConditionExpression: `attribute_not_exists(${ModelClass.pkAttribute})`,
    })

    const instance = new ModelClass(item) as T
    ;(instance as any)._exists = true
    return instance
  }

  /**
   * Update or create a record
   */
  static async updateOrCreate<T extends Model>(
    this: new (...args: any[]) => T,
    attributes: Record<string, any>,
    values: Record<string, any>,
  ): Promise<T> {
    const ModelClass = this as any
    const id = attributes[ModelClass.primaryKey]

    const existing = await ModelClass.find(id)
    if (existing) {
      await existing.update(values)
      return existing
    }

    return ModelClass.create({ ...attributes, ...values })
  }

  /**
   * Start a where query
   */
  static where<T extends Model>(
    this: new (...args: any[]) => T,
    attribute: string,
    operatorOrValue: any,
    value?: any,
  ): ModelQueryBuilderImpl<T> {
    const builder = (this as any).query()
    return builder.where(attribute, operatorOrValue, value)
  }

  /**
   * Query by partition key
   */
  static wherePk<T extends Model>(this: new (...args: any[]) => T, value: string): ModelQueryBuilderImpl<T> {
    const builder = (this as any).query()
    return builder.wherePk(value)
  }

  // ========================================================================
  // Instance Methods
  // ========================================================================

  /**
   * Get the primary key value
   */
  getKey(): string {
    const ModelClass = this.constructor as typeof Model
    return (this as any)[ModelClass.primaryKey]
  }

  /**
   * Get an attribute value
   */
  getAttribute(key: string): any {
    return this._attributes[key]
  }

  /**
   * Set an attribute value
   */
  setAttribute(key: string, value: any): this {
    this._attributes[key] = value
    ;(this as any)[key] = value
    return this
  }

  /**
   * Get all attributes
   */
  getAttributes(): Record<string, any> {
    return { ...this._attributes }
  }

  /**
   * Check if the model has been modified
   */
  isDirty(attribute?: string): boolean {
    if (attribute) {
      return this._attributes[attribute] !== this._original[attribute]
    }
    return JSON.stringify(this._attributes) !== JSON.stringify(this._original)
  }

  /**
   * Get the dirty (modified) attributes
   */
  getDirty(): Record<string, any> {
    const dirty: Record<string, any> = {}
    for (const [key, value] of Object.entries(this._attributes)) {
      if (value !== this._original[key]) {
        dirty[key] = value
      }
    }
    return dirty
  }

  /**
   * Save the model (create or update)
   */
  async save(): Promise<this> {
    if (this._exists) {
      const dirty = this.getDirty()
      if (Object.keys(dirty).length > 0) {
        await this.update(dirty)
      }
    }
    else {
      const ModelClass = this.constructor as typeof Model
      const created = await (ModelClass as any).create(this._attributes)
      this._attributes = created._attributes
      this._original = { ...this._attributes }
      this._exists = true
    }
    return this
  }

  /**
   * Update the model with new values
   */
  async update(values: Record<string, any>): Promise<this> {
    const ModelClass = this.constructor as typeof Model
    const client = getClient()
    const driver = getDriver()

    const id = this.getKey()
    const pk = `${ModelClass.pkPrefix}${ModelClass.keyDelimiter}${id}`
    const sk = ModelClass.skPrefix

    const now = new Date().toISOString()
    const updateValues = { ...values }

    if (ModelClass.timestamps) {
      updateValues[ModelClass.updatedAtField] = now
    }

    // Build update expression
    const setParts: string[] = []
    const exprNames: Record<string, string> = {}
    const exprValues: Record<string, any> = {}
    let idx = 0

    for (const [attr, value] of Object.entries(updateValues)) {
      const nameKey = `#attr${idx}`
      const valueKey = `:val${idx}`
      exprNames[nameKey] = attr
      exprValues[valueKey] = driver.marshall({ v: value }).v
      setParts.push(`${nameKey} = ${valueKey}`)
      idx++
    }

    await client.updateItem({
      TableName: ModelClass.tableName,
      Key: driver.marshall({
        [ModelClass.pkAttribute]: pk,
        [ModelClass.skAttribute]: sk,
      }),
      UpdateExpression: `SET ${setParts.join(', ')}`,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    })

    // Update local state
    for (const [key, value] of Object.entries(updateValues)) {
      this._attributes[key] = value
      ;(this as any)[key] = value
    }
    this._original = { ...this._attributes }

    return this
  }

  /**
   * Delete the model
   */
  async delete(): Promise<boolean> {
    const ModelClass = this.constructor as typeof Model
    const client = getClient()
    const driver = getDriver()

    const id = this.getKey()
    const pk = `${ModelClass.pkPrefix}${ModelClass.keyDelimiter}${id}`
    const sk = ModelClass.skPrefix

    await client.deleteItem({
      TableName: ModelClass.tableName,
      Key: driver.marshall({
        [ModelClass.pkAttribute]: pk,
        [ModelClass.skAttribute]: sk,
      }),
    })

    this._exists = false
    return true
  }

  /**
   * Refresh the model from the database
   */
  async refresh(): Promise<this> {
    const ModelClass = this.constructor as typeof Model
    const fresh = await (ModelClass as any).find(this.getKey())

    if (fresh) {
      this._attributes = fresh._attributes
      this._original = { ...this._attributes }
      for (const [key, value] of Object.entries(this._attributes)) {
        (this as any)[key] = value
      }
    }

    return this
  }

  /**
   * Convert the model to a plain object
   */
  toObject(): Record<string, any> {
    const ModelClass = this.constructor as typeof Model
    const obj = { ...this._attributes }

    // Remove DynamoDB internal fields
    delete obj[ModelClass.pkAttribute]
    delete obj[ModelClass.skAttribute]
    delete obj[ModelClass.entityTypeAttribute]

    return obj
  }

  /**
   * Convert the model to JSON
   */
  toJSON(): Record<string, any> {
    return this.toObject()
  }
}

// ============================================================================
// Query Builder Implementation
// ============================================================================

class ModelQueryBuilderImpl<T extends Model> implements ModelQueryBuilder<T> {
  private ModelClass: typeof Model
  private _pkValue?: string
  private _skCondition?: { type: string, value: any, value2?: any }
  private _indexName?: string
  private _filterConditions: Array<{ attribute: string, operator: string, value?: any, values?: any[] }> = []
  private _projectionAttrs: string[] = []
  private _limitValue?: number
  private _scanForward: boolean = true
  private _consistentReadValue: boolean = false
  private _startKey?: Record<string, any>

  constructor(ModelClass: typeof Model) {
    this.ModelClass = ModelClass
  }

  /**
   * Filter by partition key
   */
  wherePk(value: string): this {
    this._pkValue = `${this.ModelClass.pkPrefix}${this.ModelClass.keyDelimiter}${value}`
    return this
  }

  /**
   * Add a where condition
   */
  where(attribute: string, operatorOrValue: any, value?: any): this {
    if (value === undefined) {
      this._filterConditions.push({ attribute, operator: '=', value: operatorOrValue })
    }
    else {
      this._filterConditions.push({ attribute, operator: operatorOrValue, value })
    }
    return this
  }

  /**
   * Filter where attribute is in a list
   */
  whereIn(attribute: string, values: any[]): this {
    this._filterConditions.push({ attribute, operator: 'IN', values })
    return this
  }

  /**
   * Filter where attribute is between two values
   */
  whereBetween(attribute: string, start: any, end: any): this {
    this._filterConditions.push({ attribute, operator: 'BETWEEN', value: start, values: [start, end] })
    return this
  }

  /**
   * Filter where attribute begins with prefix
   */
  whereBeginsWith(attribute: string, prefix: string): this {
    this._filterConditions.push({ attribute, operator: 'begins_with', value: prefix })
    return this
  }

  /**
   * Filter where attribute exists
   */
  whereExists(attribute: string): this {
    this._filterConditions.push({ attribute, operator: 'attribute_exists' })
    return this
  }

  /**
   * Filter where attribute does not exist
   */
  whereNotExists(attribute: string): this {
    this._filterConditions.push({ attribute, operator: 'attribute_not_exists' })
    return this
  }

  /**
   * Set sort order
   */
  orderBy(direction: 'asc' | 'desc'): this {
    this._scanForward = direction === 'asc'
    return this
  }

  /**
   * Limit results
   */
  limit(count: number): this {
    this._limitValue = count
    return this
  }

  /**
   * Select specific attributes
   */
  select(...attributes: string[]): this {
    this._projectionAttrs.push(...attributes)
    return this
  }

  /**
   * Use a specific index
   */
  index(indexName: string): this {
    this._indexName = indexName
    return this
  }

  /**
   * Use consistent read
   */
  consistentRead(): this {
    this._consistentReadValue = true
    return this
  }

  /**
   * Start from a specific key (for pagination)
   */
  startFrom(key: Record<string, any>): this {
    this._startKey = key
    return this
  }

  /**
   * Build the DynamoDB request
   */
  private buildRequest(): Record<string, any> {
    const driver = getDriver()
    const request: Record<string, any> = {
      TableName: this.ModelClass.tableName,
    }

    if (this._indexName) {
      request.IndexName = this._indexName
    }

    const exprNames: Record<string, string> = {}
    const exprValues: Record<string, any> = {}
    let idx = 0

    // Build key condition expression
    const keyConditions: string[] = []

    if (this._pkValue) {
      const nameKey = `#pk${idx}`
      const valueKey = `:pk${idx}`
      exprNames[nameKey] = this.ModelClass.pkAttribute
      exprValues[valueKey] = { S: this._pkValue }
      keyConditions.push(`${nameKey} = ${valueKey}`)
      idx++
    }

    if (this._skCondition) {
      const nameKey = `#sk${idx}`
      exprNames[nameKey] = this.ModelClass.skAttribute

      switch (this._skCondition.type) {
        case 'eq': {
          const valueKey = `:sk${idx}`
          exprValues[valueKey] = { S: this._skCondition.value }
          keyConditions.push(`${nameKey} = ${valueKey}`)
          break
        }
        case 'begins_with': {
          const valueKey = `:sk${idx}`
          exprValues[valueKey] = { S: this._skCondition.value }
          keyConditions.push(`begins_with(${nameKey}, ${valueKey})`)
          break
        }
      }
      idx++
    }

    if (keyConditions.length > 0) {
      request.KeyConditionExpression = keyConditions.join(' AND ')
    }

    // Build filter expression
    if (this._filterConditions.length > 0) {
      const filterParts: string[] = []

      for (const cond of this._filterConditions) {
        const nameKey = `#flt${idx}`
        exprNames[nameKey] = cond.attribute

        if (cond.operator === 'attribute_exists') {
          filterParts.push(`attribute_exists(${nameKey})`)
        }
        else if (cond.operator === 'attribute_not_exists') {
          filterParts.push(`attribute_not_exists(${nameKey})`)
        }
        else if (cond.operator === 'IN' && cond.values) {
          const valueKeys = cond.values.map((_, i) => `:flt${idx}_${i}`)
          cond.values.forEach((val, i) => {
            exprValues[`:flt${idx}_${i}`] = driver.marshall({ v: val }).v
          })
          filterParts.push(`${nameKey} IN (${valueKeys.join(', ')})`)
        }
        else if (cond.operator === 'BETWEEN' && cond.values) {
          const valueKey1 = `:flt${idx}a`
          const valueKey2 = `:flt${idx}b`
          exprValues[valueKey1] = driver.marshall({ v: cond.values[0] }).v
          exprValues[valueKey2] = driver.marshall({ v: cond.values[1] }).v
          filterParts.push(`${nameKey} BETWEEN ${valueKey1} AND ${valueKey2}`)
        }
        else if (cond.operator === 'begins_with') {
          const valueKey = `:flt${idx}`
          exprValues[valueKey] = driver.marshall({ v: cond.value }).v
          filterParts.push(`begins_with(${nameKey}, ${valueKey})`)
        }
        else {
          const valueKey = `:flt${idx}`
          exprValues[valueKey] = driver.marshall({ v: cond.value }).v
          filterParts.push(`${nameKey} ${cond.operator} ${valueKey}`)
        }
        idx++
      }

      request.FilterExpression = filterParts.join(' AND ')
    }

    // Build projection expression
    if (this._projectionAttrs.length > 0) {
      const projParts: string[] = []
      for (const attr of this._projectionAttrs) {
        const nameKey = `#proj${idx}`
        exprNames[nameKey] = attr
        projParts.push(nameKey)
        idx++
      }
      request.ProjectionExpression = projParts.join(', ')
    }

    if (Object.keys(exprNames).length > 0) {
      request.ExpressionAttributeNames = exprNames
    }
    if (Object.keys(exprValues).length > 0) {
      request.ExpressionAttributeValues = exprValues
    }

    if (this._limitValue !== undefined) {
      request.Limit = this._limitValue
    }

    request.ScanIndexForward = this._scanForward

    if (this._consistentReadValue) {
      request.ConsistentRead = true
    }

    if (this._startKey) {
      request.ExclusiveStartKey = driver.marshall(this._startKey)
    }

    return request
  }

  /**
   * Execute the query and return results
   */
  async get(): Promise<T[]> {
    const client = getClient()
    const driver = getDriver()
    const request = this.buildRequest()

    const isQuery = this._pkValue !== undefined
    const response = isQuery
      ? await client.query(request as any)
      : await client.scan(request as any)

    const items = (response.Items ?? []).map((item: any) => {
      const data = driver.unmarshall(item)
      const instance = new (this.ModelClass as any)(data) as T
      ;(instance as any)._exists = true
      return instance
    })

    return items
  }

  /**
   * Get the first result
   */
  async first(): Promise<T | null> {
    this._limitValue = 1
    const results = await this.get()
    return results[0] ?? null
  }

  /**
   * Count matching items
   */
  async count(): Promise<number> {
    const client = getClient()
    const request = this.buildRequest()
    request.Select = 'COUNT'

    const isQuery = this._pkValue !== undefined
    const response = isQuery
      ? await client.query(request as any)
      : await client.scan(request as any)

    return response.Count ?? 0
  }

  /**
   * Paginate results
   */
  async paginate(pageSize: number, lastKey?: Record<string, any>): Promise<{ items: T[], lastKey?: Record<string, any> }> {
    const driver = getDriver()

    if (lastKey) {
      this._startKey = lastKey
    }
    this._limitValue = pageSize

    const client = getClient()
    const request = this.buildRequest()

    const isQuery = this._pkValue !== undefined
    const response = isQuery
      ? await client.query(request as any)
      : await client.scan(request as any)

    const items = (response.Items ?? []).map((item: any) => {
      const data = driver.unmarshall(item)
      const instance = new (this.ModelClass as any)(data) as T
      ;(instance as any)._exists = true
      return instance
    })

    return {
      items,
      lastKey: response.LastEvaluatedKey ? driver.unmarshall(response.LastEvaluatedKey) : undefined,
    }
  }
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export { DynamoDBClient, createClient } from './client'
