/**
 * DynamoDB Query Builder Client
 *
 * Provides a fluent API for building DynamoDB queries, similar to the SQL query builder
 * but adapted for DynamoDB's key-value/document model.
 */

import type {
  DynamoDBBatchGetItemParams,
  DynamoDBBatchWriteItemParams,
  DynamoDBComparisonOperator,
  DynamoDBCondition,
  DynamoDBConfig,
  DynamoDBDeleteItemParams,
  DynamoDBDriver,
  DynamoDBGetItemParams,
  DynamoDBPutItemParams,
  DynamoDBQueryParams,
  DynamoDBScanParams,
  DynamoDBTransactWriteParams,
  DynamoDBUpdateItemParams,
  SingleTableEntityMapping,
} from './drivers/dynamodb'
import { createDynamoDBDriver } from './drivers/dynamodb'

/**
 * DynamoDB Query Builder Options
 */
export interface DynamoDBQueryBuilderOptions {
  config: DynamoDBConfig
  /** Optional DynamoDB client instance (e.g., from @aws-sdk/client-dynamodb) */
  client?: any
}

/**
 * Result type for DynamoDB operations
 */
export interface DynamoDBResult<T = any> {
  items?: T[]
  item?: T
  count?: number
  scannedCount?: number
  lastEvaluatedKey?: Record<string, any>
  consumedCapacity?: any
}

/**
 * DynamoDB Query Builder
 *
 * Fluent interface for building DynamoDB queries
 */
export class DynamoDBQueryBuilder<T = any> {
  private driver: DynamoDBDriver
  private client: any
  private tableName: string
  private indexName?: string
  private entityType?: string
  private keyConditions: DynamoDBCondition[] = []
  private filterConditions: DynamoDBCondition[] = []
  private projectionAttrs: string[] = []
  private limitValue?: number
  private scanForward: boolean = true
  private consistentReadValue: boolean = false
  private startKey?: Record<string, any>

  constructor(options: DynamoDBQueryBuilderOptions) {
    this.driver = createDynamoDBDriver(options.config)
    this.client = options.client
    this.tableName = options.config.tableName ?? ''
  }

  /**
   * Set the table to query
   */
  table(tableName: string): this {
    this.tableName = tableName
    return this
  }

  /**
   * Use a specific index (GSI or LSI)
   */
  index(indexName: string): this {
    this.indexName = indexName
    return this
  }

  /**
   * Set the entity type for single table design queries
   */
  entity(entityType: string): this {
    this.entityType = entityType
    return this
  }

  /**
   * Add a key condition (for Query operations)
   * Key conditions can only be applied to partition key and sort key
   */
  whereKey(attribute: string, operator: DynamoDBComparisonOperator, value: any): this {
    this.keyConditions.push({ attribute, operator, value })
    return this
  }

  /**
   * Shorthand for partition key equals
   */
  wherePartitionKey(attribute: string, value: any): this {
    return this.whereKey(attribute, '=', value)
  }

  /**
   * Shorthand for sort key equals
   */
  whereSortKey(attribute: string, value: any): this {
    return this.whereKey(attribute, '=', value)
  }

  /**
   * Sort key begins with (for hierarchical data)
   */
  whereSortKeyBeginsWith(attribute: string, prefix: string): this {
    this.keyConditions.push({ attribute, operator: 'begins_with', value: prefix })
    return this
  }

  /**
   * Sort key between two values
   */
  whereSortKeyBetween(attribute: string, start: any, end: any): this {
    this.keyConditions.push({ attribute, operator: 'BETWEEN', values: [start, end] })
    return this
  }

  /**
   * Add a filter condition (applied after Query/Scan)
   */
  where(attribute: string, operator: DynamoDBComparisonOperator | 'contains' | 'attribute_exists' | 'attribute_not_exists' | 'IN', value?: any): this {
    this.filterConditions.push({ attribute, operator, value })
    return this
  }

  /**
   * Filter where attribute equals value
   */
  whereEquals(attribute: string, value: any): this {
    return this.where(attribute, '=', value)
  }

  /**
   * Filter where attribute is less than value
   */
  whereLessThan(attribute: string, value: any): this {
    return this.where(attribute, '<', value)
  }

  /**
   * Filter where attribute is less than or equal to value
   */
  whereLessThanOrEqual(attribute: string, value: any): this {
    return this.where(attribute, '<=', value)
  }

  /**
   * Filter where attribute is greater than value
   */
  whereGreaterThan(attribute: string, value: any): this {
    return this.where(attribute, '>', value)
  }

  /**
   * Filter where attribute is greater than or equal to value
   */
  whereGreaterThanOrEqual(attribute: string, value: any): this {
    return this.where(attribute, '>=', value)
  }

  /**
   * Filter where attribute is between two values
   */
  whereBetween(attribute: string, start: any, end: any): this {
    this.filterConditions.push({ attribute, operator: 'BETWEEN', values: [start, end] })
    return this
  }

  /**
   * Filter where attribute begins with prefix
   */
  whereBeginsWith(attribute: string, prefix: string): this {
    this.filterConditions.push({ attribute, operator: 'begins_with', value: prefix })
    return this
  }

  /**
   * Filter where attribute contains value (for strings and sets)
   */
  whereContains(attribute: string, value: any): this {
    return this.where(attribute, 'contains', value)
  }

  /**
   * Filter where attribute exists
   */
  whereExists(attribute: string): this {
    return this.where(attribute, 'attribute_exists')
  }

  /**
   * Filter where attribute does not exist
   */
  whereNotExists(attribute: string): this {
    return this.where(attribute, 'attribute_not_exists')
  }

  /**
   * Filter where attribute is in a list of values
   */
  whereIn(attribute: string, values: any[]): this {
    this.filterConditions.push({ attribute, operator: 'IN', values })
    return this
  }

  /**
   * Select specific attributes to return
   */
  select(...attributes: string[]): this {
    this.projectionAttrs.push(...attributes)
    return this
  }

  /**
   * Limit the number of items returned
   */
  limit(count: number): this {
    this.limitValue = count
    return this
  }

  /**
   * Sort in ascending order (default)
   */
  ascending(): this {
    this.scanForward = true
    return this
  }

  /**
   * Sort in descending order
   */
  descending(): this {
    this.scanForward = false
    return this
  }

  /**
   * Use consistent read
   */
  consistentRead(value: boolean = true): this {
    this.consistentReadValue = value
    return this
  }

  /**
   * Set the exclusive start key for pagination
   */
  startFrom(key: Record<string, any>): this {
    this.startKey = key
    return this
  }

  /**
   * Build Query parameters
   */
  buildQueryParams(): DynamoDBQueryParams {
    const params = this.driver.buildQueryParams({
      tableName: this.tableName,
      indexName: this.indexName,
      keyConditions: this.keyConditions,
      filterConditions: this.filterConditions.length > 0 ? this.filterConditions : undefined,
      projectionAttributes: this.projectionAttrs.length > 0 ? this.projectionAttrs : undefined,
      limit: this.limitValue,
      scanIndexForward: this.scanForward,
      exclusiveStartKey: this.startKey,
      consistentRead: this.consistentReadValue,
    })

    return params
  }

  /**
   * Build Scan parameters
   */
  buildScanParams(): DynamoDBScanParams {
    return this.driver.buildScanParams({
      tableName: this.tableName,
      indexName: this.indexName,
      filterConditions: this.filterConditions.length > 0 ? this.filterConditions : undefined,
      projectionAttributes: this.projectionAttrs.length > 0 ? this.projectionAttrs : undefined,
      limit: this.limitValue,
      exclusiveStartKey: this.startKey,
      consistentRead: this.consistentReadValue,
    })
  }

  /**
   * Build the DynamoDB API request with expressions
   */
  toQueryRequest(): Record<string, any> {
    const params = this.buildQueryParams()
    const request: Record<string, any> = {
      TableName: params.tableName,
      ExpressionAttributeNames: {},
      ExpressionAttributeValues: {},
    }

    if (params.indexName) {
      request.IndexName = params.indexName
    }

    let attrIndex = 0

    // Build key condition expression with unique prefixes
    if (params.keyConditions.length > 0) {
      const keyParts: string[] = []
      for (const condition of params.keyConditions) {
        const nameKey = `#key${attrIndex}`
        request.ExpressionAttributeNames[nameKey] = condition.attribute

        if (condition.operator === 'begins_with') {
          const valueKey = `:keyval${attrIndex}`
          request.ExpressionAttributeValues[valueKey] = this.driver.marshall({ v: condition.value }).v
          keyParts.push(`begins_with(${nameKey}, ${valueKey})`)
        }
        else if (condition.operator === 'BETWEEN') {
          const valueKey1 = `:keyval${attrIndex}a`
          const valueKey2 = `:keyval${attrIndex}b`
          request.ExpressionAttributeValues[valueKey1] = this.driver.marshall({ v: condition.values?.[0] }).v
          request.ExpressionAttributeValues[valueKey2] = this.driver.marshall({ v: condition.values?.[1] }).v
          keyParts.push(`${nameKey} BETWEEN ${valueKey1} AND ${valueKey2}`)
        }
        else {
          const valueKey = `:keyval${attrIndex}`
          request.ExpressionAttributeValues[valueKey] = this.driver.marshall({ v: condition.value }).v
          keyParts.push(`${nameKey} ${condition.operator} ${valueKey}`)
        }
        attrIndex++
      }
      request.KeyConditionExpression = keyParts.join(' AND ')
    }

    // Build filter expression with unique prefixes
    if (params.filterConditions && params.filterConditions.length > 0) {
      const filterParts: string[] = []
      for (const condition of params.filterConditions) {
        const nameKey = `#flt${attrIndex}`
        request.ExpressionAttributeNames[nameKey] = condition.attribute

        if (condition.operator === 'attribute_exists') {
          filterParts.push(`attribute_exists(${nameKey})`)
        }
        else if (condition.operator === 'attribute_not_exists') {
          filterParts.push(`attribute_not_exists(${nameKey})`)
        }
        else if (condition.operator === 'begins_with' || condition.operator === 'contains') {
          const valueKey = `:fltval${attrIndex}`
          request.ExpressionAttributeValues[valueKey] = this.driver.marshall({ v: condition.value }).v
          filterParts.push(`${condition.operator}(${nameKey}, ${valueKey})`)
        }
        else if (condition.operator === 'BETWEEN') {
          const valueKey1 = `:fltval${attrIndex}a`
          const valueKey2 = `:fltval${attrIndex}b`
          request.ExpressionAttributeValues[valueKey1] = this.driver.marshall({ v: condition.values?.[0] }).v
          request.ExpressionAttributeValues[valueKey2] = this.driver.marshall({ v: condition.values?.[1] }).v
          filterParts.push(`${nameKey} BETWEEN ${valueKey1} AND ${valueKey2}`)
        }
        else if (condition.operator === 'IN') {
          const valueKeys = (condition.values ?? []).map((_, i) => `:fltval${attrIndex}_${i}`)
          condition.values?.forEach((val, i) => {
            request.ExpressionAttributeValues[`:fltval${attrIndex}_${i}`] = this.driver.marshall({ v: val }).v
          })
          filterParts.push(`${nameKey} IN (${valueKeys.join(', ')})`)
        }
        else {
          const valueKey = `:fltval${attrIndex}`
          request.ExpressionAttributeValues[valueKey] = this.driver.marshall({ v: condition.value }).v
          filterParts.push(`${nameKey} ${condition.operator} ${valueKey}`)
        }
        attrIndex++
      }
      request.FilterExpression = filterParts.join(' AND ')
    }

    // Build projection expression
    if (params.projectionAttributes && params.projectionAttributes.length > 0) {
      const projParts: string[] = []
      for (const attr of params.projectionAttributes) {
        const nameKey = `#proj${attrIndex}`
        request.ExpressionAttributeNames[nameKey] = attr
        projParts.push(nameKey)
        attrIndex++
      }
      request.ProjectionExpression = projParts.join(', ')
    }

    if (params.limit !== undefined) {
      request.Limit = params.limit
    }

    if (params.scanIndexForward !== undefined) {
      request.ScanIndexForward = params.scanIndexForward
    }

    if (params.exclusiveStartKey) {
      request.ExclusiveStartKey = this.driver.marshall(params.exclusiveStartKey)
    }

    if (params.consistentRead) {
      request.ConsistentRead = params.consistentRead
    }

    // Clean up empty objects
    if (Object.keys(request.ExpressionAttributeNames).length === 0) {
      delete request.ExpressionAttributeNames
    }
    if (Object.keys(request.ExpressionAttributeValues).length === 0) {
      delete request.ExpressionAttributeValues
    }

    return request
  }

  /**
   * Build the DynamoDB Scan API request
   */
  toScanRequest(): Record<string, any> {
    const params = this.buildScanParams()
    const request: Record<string, any> = {
      TableName: params.tableName,
    }

    if (params.indexName) {
      request.IndexName = params.indexName
    }

    if (params.filterConditions && params.filterConditions.length > 0) {
      const { expression, expressionAttributeNames, expressionAttributeValues } =
        this.driver.buildFilterExpression(params.filterConditions)
      request.FilterExpression = expression
      request.ExpressionAttributeNames = expressionAttributeNames
      request.ExpressionAttributeValues = expressionAttributeValues
    }

    if (params.projectionAttributes && params.projectionAttributes.length > 0) {
      const { expression, expressionAttributeNames } =
        this.driver.buildProjectionExpression(params.projectionAttributes)
      request.ProjectionExpression = expression
      request.ExpressionAttributeNames = { ...request.ExpressionAttributeNames, ...expressionAttributeNames }
    }

    if (params.limit !== undefined) {
      request.Limit = params.limit
    }

    if (params.exclusiveStartKey) {
      request.ExclusiveStartKey = this.driver.marshall(params.exclusiveStartKey)
    }

    if (params.consistentRead) {
      request.ConsistentRead = params.consistentRead
    }

    return request
  }

  /**
   * Execute the query (requires DynamoDB client)
   */
  async query(): Promise<DynamoDBResult<T>> {
    if (!this.client) {
      throw new Error('DynamoDB client not provided. Pass a client in options or use toQueryRequest() to get the request params.')
    }

    const request = this.toQueryRequest()
    const response = await this.client.query(request)

    return {
      items: response.Items?.map((item: any) => this.driver.unmarshall(item)) as T[],
      count: response.Count,
      scannedCount: response.ScannedCount,
      lastEvaluatedKey: response.LastEvaluatedKey ? this.driver.unmarshall(response.LastEvaluatedKey) : undefined,
      consumedCapacity: response.ConsumedCapacity,
    }
  }

  /**
   * Execute a scan (requires DynamoDB client)
   */
  async scan(): Promise<DynamoDBResult<T>> {
    if (!this.client) {
      throw new Error('DynamoDB client not provided. Pass a client in options or use toScanRequest() to get the request params.')
    }

    const request = this.toScanRequest()
    const response = await this.client.scan(request)

    return {
      items: response.Items?.map((item: any) => this.driver.unmarshall(item)) as T[],
      count: response.Count,
      scannedCount: response.ScannedCount,
      lastEvaluatedKey: response.LastEvaluatedKey ? this.driver.unmarshall(response.LastEvaluatedKey) : undefined,
      consumedCapacity: response.ConsumedCapacity,
    }
  }

  /**
   * Get all items (auto-paginate through all results)
   */
  async getAll(): Promise<T[]> {
    const allItems: T[] = []
    let lastKey: Record<string, any> | undefined

    do {
      if (lastKey) {
        this.startFrom(lastKey)
      }

      const result = this.keyConditions.length > 0
        ? await this.query()
        : await this.scan()

      if (result.items) {
        allItems.push(...result.items)
      }

      lastKey = result.lastEvaluatedKey
    } while (lastKey)

    return allItems
  }

  /**
   * Get the first item
   */
  async first(): Promise<T | undefined> {
    this.limit(1)
    const result = this.keyConditions.length > 0
      ? await this.query()
      : await this.scan()
    return result.items?.[0]
  }

  /**
   * Count items matching the query
   */
  async count(): Promise<number> {
    if (!this.client) {
      throw new Error('DynamoDB client not provided')
    }

    const request = this.keyConditions.length > 0
      ? this.toQueryRequest()
      : this.toScanRequest()

    request.Select = 'COUNT'

    const response = this.keyConditions.length > 0
      ? await this.client.query(request)
      : await this.client.scan(request)

    return response.Count ?? 0
  }

  /**
   * Reset the builder for a new query
   */
  reset(): this {
    this.indexName = undefined
    this.entityType = undefined
    this.keyConditions = []
    this.filterConditions = []
    this.projectionAttrs = []
    this.limitValue = undefined
    this.scanForward = true
    this.consistentReadValue = false
    this.startKey = undefined
    return this
  }
}

/**
 * DynamoDB Item Builder for Put/Update operations
 */
export class DynamoDBItemBuilder<T = any> {
  private driver: DynamoDBDriver
  private client: any
  private tableName: string
  private itemData: Record<string, any> = {}
  private keyData: Record<string, any> = {}
  private updateExpressions: DynamoDBUpdateItemParams['updateExpressions'] = {}
  private conditionExpr?: string
  private returnValuesOption: DynamoDBPutItemParams['returnValues'] = 'NONE'

  constructor(options: DynamoDBQueryBuilderOptions) {
    this.driver = createDynamoDBDriver(options.config)
    this.client = options.client
    this.tableName = options.config.tableName ?? ''
  }

  /**
   * Set the table
   */
  table(tableName: string): this {
    this.tableName = tableName
    return this
  }

  /**
   * Set the item key
   */
  key(key: Record<string, any>): this {
    this.keyData = key
    return this
  }

  /**
   * Set item data for Put operation
   */
  item(data: Record<string, any>): this {
    this.itemData = data
    return this
  }

  /**
   * Set attribute value (for Update)
   */
  set(attribute: string, value: any): this {
    if (!this.updateExpressions.set) {
      this.updateExpressions.set = {}
    }
    this.updateExpressions.set[attribute] = value
    return this
  }

  /**
   * Set multiple attribute values (for Update)
   */
  setMany(values: Record<string, any>): this {
    if (!this.updateExpressions.set) {
      this.updateExpressions.set = {}
    }
    Object.assign(this.updateExpressions.set, values)
    return this
  }

  /**
   * Remove an attribute (for Update)
   */
  remove(attribute: string): this {
    if (!this.updateExpressions.remove) {
      this.updateExpressions.remove = []
    }
    this.updateExpressions.remove.push(attribute)
    return this
  }

  /**
   * Add to a number or set (for Update)
   */
  add(attribute: string, value: any): this {
    if (!this.updateExpressions.add) {
      this.updateExpressions.add = {}
    }
    this.updateExpressions.add[attribute] = value
    return this
  }

  /**
   * Delete from a set (for Update)
   */
  deleteFromSet(attribute: string, values: any): this {
    if (!this.updateExpressions.delete) {
      this.updateExpressions.delete = {}
    }
    this.updateExpressions.delete[attribute] = values
    return this
  }

  /**
   * Add a condition expression
   */
  condition(expression: string): this {
    this.conditionExpr = expression
    return this
  }

  /**
   * Condition: attribute must not exist (for insert-only semantics)
   */
  ifNotExists(attribute: string = 'pk'): this {
    this.conditionExpr = `attribute_not_exists(${attribute})`
    return this
  }

  /**
   * Condition: attribute must exist (for update-only semantics)
   */
  ifExists(attribute: string = 'pk'): this {
    this.conditionExpr = `attribute_exists(${attribute})`
    return this
  }

  /**
   * Return old values after operation
   */
  returnOld(): this {
    this.returnValuesOption = 'ALL_OLD'
    return this
  }

  /**
   * Return new values after update
   */
  returnNew(): this {
    this.returnValuesOption = 'ALL_NEW' as any
    return this
  }

  /**
   * Build PutItem request
   */
  toPutRequest(): Record<string, any> {
    const request: Record<string, any> = {
      TableName: this.tableName,
      Item: this.driver.marshall(this.itemData),
    }

    if (this.conditionExpr) {
      request.ConditionExpression = this.conditionExpr
    }

    if (this.returnValuesOption !== 'NONE') {
      request.ReturnValues = this.returnValuesOption
    }

    return request
  }

  /**
   * Build UpdateItem request
   */
  toUpdateRequest(): Record<string, any> {
    const request: Record<string, any> = {
      TableName: this.tableName,
      Key: this.driver.marshall(this.keyData),
    }

    const { expression, expressionAttributeNames, expressionAttributeValues } =
      this.driver.buildUpdateExpression(this.updateExpressions)

    if (expression) {
      request.UpdateExpression = expression
      request.ExpressionAttributeNames = expressionAttributeNames
      request.ExpressionAttributeValues = expressionAttributeValues
    }

    if (this.conditionExpr) {
      request.ConditionExpression = this.conditionExpr
    }

    if (this.returnValuesOption !== 'NONE') {
      request.ReturnValues = this.returnValuesOption
    }

    return request
  }

  /**
   * Build DeleteItem request
   */
  toDeleteRequest(): Record<string, any> {
    const request: Record<string, any> = {
      TableName: this.tableName,
      Key: this.driver.marshall(this.keyData),
    }

    if (this.conditionExpr) {
      request.ConditionExpression = this.conditionExpr
    }

    if (this.returnValuesOption !== 'NONE') {
      request.ReturnValues = this.returnValuesOption
    }

    return request
  }

  /**
   * Build GetItem request
   */
  toGetRequest(): Record<string, any> {
    return {
      TableName: this.tableName,
      Key: this.driver.marshall(this.keyData),
    }
  }

  /**
   * Execute PutItem
   */
  async put(): Promise<T | undefined> {
    if (!this.client) {
      throw new Error('DynamoDB client not provided')
    }

    const request = this.toPutRequest()
    const response = await this.client.putItem(request)

    if (response.Attributes) {
      return this.driver.unmarshall(response.Attributes) as T
    }

    return undefined
  }

  /**
   * Execute UpdateItem
   */
  async update(): Promise<T | undefined> {
    if (!this.client) {
      throw new Error('DynamoDB client not provided')
    }

    const request = this.toUpdateRequest()
    const response = await this.client.updateItem(request)

    if (response.Attributes) {
      return this.driver.unmarshall(response.Attributes) as T
    }

    return undefined
  }

  /**
   * Execute DeleteItem
   */
  async delete(): Promise<T | undefined> {
    if (!this.client) {
      throw new Error('DynamoDB client not provided')
    }

    const request = this.toDeleteRequest()
    const response = await this.client.deleteItem(request)

    if (response.Attributes) {
      return this.driver.unmarshall(response.Attributes) as T
    }

    return undefined
  }

  /**
   * Execute GetItem
   */
  async get(): Promise<T | undefined> {
    if (!this.client) {
      throw new Error('DynamoDB client not provided')
    }

    const request = this.toGetRequest()
    const response = await this.client.getItem(request)

    if (response.Item) {
      return this.driver.unmarshall(response.Item) as T
    }

    return undefined
  }
}

/**
 * Create a DynamoDB query builder
 */
export function createDynamoDBQueryBuilder<T = any>(options: DynamoDBQueryBuilderOptions): DynamoDBQueryBuilder<T> {
  return new DynamoDBQueryBuilder<T>(options)
}

/**
 * Create a DynamoDB item builder
 */
export function createDynamoDBItemBuilder<T = any>(options: DynamoDBQueryBuilderOptions): DynamoDBItemBuilder<T> {
  return new DynamoDBItemBuilder<T>(options)
}

/**
 * DynamoDB Client Factory
 *
 * Creates a complete DynamoDB client with query builder methods
 */
export interface DynamoDBClientMethods {
  /** Create a query builder */
  query: <T = any>() => DynamoDBQueryBuilder<T>
  /** Create an item builder */
  item: <T = any>() => DynamoDBItemBuilder<T>
  /** Get the underlying driver */
  driver: DynamoDBDriver
  /** Register an entity mapping for single table design */
  registerEntity: (mapping: SingleTableEntityMapping) => void
  /** Build primary key for an entity */
  buildKey: (entityType: string, values: Record<string, any>) => { pk: string, sk: string }
}

/**
 * Create a DynamoDB client with fluent query builder methods
 */
export function createDynamoDBClient(options: DynamoDBQueryBuilderOptions): DynamoDBClientMethods {
  const driver = createDynamoDBDriver(options.config)

  return {
    query: <T = any>() => new DynamoDBQueryBuilder<T>(options),
    item: <T = any>() => new DynamoDBItemBuilder<T>(options),
    driver,
    registerEntity: (mapping: SingleTableEntityMapping) => driver.registerEntity(mapping),
    buildKey: (entityType: string, values: Record<string, any>) => driver.buildPrimaryKey(entityType, values),
  }
}
