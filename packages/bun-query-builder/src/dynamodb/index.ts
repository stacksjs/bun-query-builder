/**
 * DynamoDB Module for bun-query-builder
 *
 * Entity-centric API for DynamoDB single-table design.
 * This module extends dynamodb-tooling patterns.
 *
 * @example
 * ```typescript
 * import { dynamo } from 'bun-query-builder/dynamodb'
 *
 * // Configure connection
 * dynamo.connection({
 *   region: 'us-east-1',
 *   table: 'MyApp',
 * })
 *
 * // Entity-centric queries
 * const users = await dynamo.entity('User')
 *   .pk('USER#123')
 *   .sk.beginsWith('PROFILE#')
 *   .index('GSI1')
 *   .project('name', 'email')
 *   .get()
 * ```
 */

import type {
  DynamoDBConfig,
  DynamoDBDriver,
  SingleTableEntityMapping,
} from '../drivers/dynamodb'
import { createDynamoDBDriver } from '../drivers/dynamodb'

// ============================================================================
// Types
// ============================================================================

/**
 * DynamoDB connection configuration
 */
export interface DynamoConnectionConfig {
  /** AWS region */
  region: string
  /** Table name (single table design) */
  table: string
  /** DynamoDB endpoint (for local development) */
  endpoint?: string
  /** AWS credentials */
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** Partition key attribute name (default: 'pk') */
  pkAttribute?: string
  /** Sort key attribute name (default: 'sk') */
  skAttribute?: string
  /** Entity type attribute name (default: '_et') */
  entityTypeAttribute?: string
  /** Key delimiter (default: '#') */
  keyDelimiter?: string
}

/**
 * Sort key builder for fluent API
 */
export interface SortKeyBuilder {
  /** Sort key equals value */
  equals(value: string): EntityQueryBuilder
  /** Sort key begins with prefix */
  beginsWith(prefix: string): EntityQueryBuilder
  /** Sort key between two values */
  between(start: string, end: string): EntityQueryBuilder
  /** Sort key less than value */
  lt(value: string): EntityQueryBuilder
  /** Sort key less than or equal to value */
  lte(value: string): EntityQueryBuilder
  /** Sort key greater than value */
  gt(value: string): EntityQueryBuilder
  /** Sort key greater than or equal to value */
  gte(value: string): EntityQueryBuilder
}

/**
 * Batch write operation
 */
export interface BatchWriteOperation {
  put?: { entity: string, item: Record<string, any> }
  delete?: { entity: string, pk: string, sk: string }
}

/**
 * Transact write operation
 */
export interface TransactWriteOperation {
  put?: { entity: string, item: Record<string, any>, condition?: string }
  update?: { entity: string, pk: string, sk?: string, set?: Record<string, any>, add?: Record<string, number>, remove?: string[] }
  delete?: { entity: string, pk: string, sk: string, condition?: string }
  conditionCheck?: { entity: string, pk: string, sk: string, condition: string }
}

/**
 * DynamoDB query result
 */
export interface DynamoDBQueryResult<T = any> {
  items: T[]
  count: number
  scannedCount?: number
  lastKey?: Record<string, any>
}

// ============================================================================
// Entity Query Builder
// ============================================================================

/**
 * Entity-centric query builder for DynamoDB
 */
export class EntityQueryBuilder<T = any> {
  private driver: DynamoDBDriver
  private client: any
  private tableName: string
  private pkAttribute: string
  private skAttribute: string
  private entityTypeAttr: string
  private delimiter: string

  private _entityType?: string
  private _pkValue?: string
  private _skCondition?: { type: 'eq' | 'begins_with' | 'between' | 'lt' | 'lte' | 'gt' | 'gte', value: string, value2?: string }
  private _indexName?: string
  private _projectionAttrs: string[] = []
  private _filterConditions: Array<{ attribute: string, operator: string, value?: any, values?: any[] }> = []
  private _limitValue?: number
  private _scanForward: boolean = true
  private _consistentRead: boolean = false
  private _startKey?: Record<string, any>

  constructor(
    driver: DynamoDBDriver,
    client: any,
    tableName: string,
    config: { pkAttribute: string, skAttribute: string, entityTypeAttribute: string, keyDelimiter: string },
  ) {
    this.driver = driver
    this.client = client
    this.tableName = tableName
    this.pkAttribute = config.pkAttribute
    this.skAttribute = config.skAttribute
    this.entityTypeAttr = config.entityTypeAttribute
    this.delimiter = config.keyDelimiter
  }

  /**
   * Set entity type for the query
   */
  entity(entityType: string): this {
    this._entityType = entityType
    return this
  }

  /**
   * Set partition key value
   */
  pk(value: string): this {
    this._pkValue = value
    return this
  }

  /**
   * Sort key builder
   */
  get sk(): SortKeyBuilder {
    const self = this
    return {
      equals(value: string): EntityQueryBuilder {
        self._skCondition = { type: 'eq', value }
        return self
      },
      beginsWith(prefix: string): EntityQueryBuilder {
        self._skCondition = { type: 'begins_with', value: prefix }
        return self
      },
      between(start: string, end: string): EntityQueryBuilder {
        self._skCondition = { type: 'between', value: start, value2: end }
        return self
      },
      lt(value: string): EntityQueryBuilder {
        self._skCondition = { type: 'lt', value }
        return self
      },
      lte(value: string): EntityQueryBuilder {
        self._skCondition = { type: 'lte', value }
        return self
      },
      gt(value: string): EntityQueryBuilder {
        self._skCondition = { type: 'gt', value }
        return self
      },
      gte(value: string): EntityQueryBuilder {
        self._skCondition = { type: 'gte', value }
        return self
      },
    }
  }

  /**
   * Use a specific index (GSI or LSI)
   */
  index(indexName: string): this {
    this._indexName = indexName
    return this
  }

  /**
   * Project specific attributes
   */
  project(...attributes: string[]): this {
    this._projectionAttrs.push(...attributes)
    return this
  }

  /**
   * Add a filter condition
   */
  filter(attribute: string, operator: string, value?: any): this {
    this._filterConditions.push({ attribute, operator, value })
    return this
  }

  /**
   * Filter where attribute equals value
   */
  where(attribute: string, value: any): this {
    return this.filter(attribute, '=', value)
  }

  /**
   * Filter where attribute is in list
   */
  whereIn(attribute: string, values: any[]): this {
    this._filterConditions.push({ attribute, operator: 'IN', values })
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
   * Sort ascending (default)
   */
  asc(): this {
    this._scanForward = true
    return this
  }

  /**
   * Sort descending
   */
  desc(): this {
    this._scanForward = false
    return this
  }

  /**
   * Use consistent read
   */
  consistent(): this {
    this._consistentRead = true
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
   * Build the DynamoDB Query request
   */
  toRequest(): Record<string, any> {
    const request: Record<string, any> = {
      TableName: this.tableName,
    }

    if (this._indexName) {
      request.IndexName = this._indexName
    }

    // Build key condition expression
    const keyConditions: string[] = []
    const exprNames: Record<string, string> = {}
    const exprValues: Record<string, any> = {}
    let idx = 0

    if (this._pkValue) {
      const nameKey = `#pk${idx}`
      const valueKey = `:pk${idx}`
      exprNames[nameKey] = this.pkAttribute
      exprValues[valueKey] = { S: this._pkValue }
      keyConditions.push(`${nameKey} = ${valueKey}`)
      idx++
    }

    if (this._skCondition) {
      const nameKey = `#sk${idx}`
      exprNames[nameKey] = this.skAttribute

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
        case 'between': {
          const valueKey1 = `:sk${idx}a`
          const valueKey2 = `:sk${idx}b`
          exprValues[valueKey1] = { S: this._skCondition.value }
          exprValues[valueKey2] = { S: this._skCondition.value2 }
          keyConditions.push(`${nameKey} BETWEEN ${valueKey1} AND ${valueKey2}`)
          break
        }
        case 'lt': {
          const valueKey = `:sk${idx}`
          exprValues[valueKey] = { S: this._skCondition.value }
          keyConditions.push(`${nameKey} < ${valueKey}`)
          break
        }
        case 'lte': {
          const valueKey = `:sk${idx}`
          exprValues[valueKey] = { S: this._skCondition.value }
          keyConditions.push(`${nameKey} <= ${valueKey}`)
          break
        }
        case 'gt': {
          const valueKey = `:sk${idx}`
          exprValues[valueKey] = { S: this._skCondition.value }
          keyConditions.push(`${nameKey} > ${valueKey}`)
          break
        }
        case 'gte': {
          const valueKey = `:sk${idx}`
          exprValues[valueKey] = { S: this._skCondition.value }
          keyConditions.push(`${nameKey} >= ${valueKey}`)
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

        if (cond.operator === 'IN' && cond.values) {
          const valueKeys = cond.values.map((_, i) => `:flt${idx}_${i}`)
          cond.values.forEach((val, i) => {
            exprValues[`:flt${idx}_${i}`] = this.driver.marshall({ v: val }).v
          })
          filterParts.push(`${nameKey} IN (${valueKeys.join(', ')})`)
        }
        else {
          const valueKey = `:flt${idx}`
          exprValues[valueKey] = this.driver.marshall({ v: cond.value }).v
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

    if (this._consistentRead) {
      request.ConsistentRead = true
    }

    if (this._startKey) {
      request.ExclusiveStartKey = this.driver.marshall(this._startKey)
    }

    return request
  }

  /**
   * Execute query and return results
   */
  async get(): Promise<T[]> {
    if (!this.client) {
      throw new Error('DynamoDB client not configured. Call dynamo.connection() first.')
    }

    const request = this.toRequest()

    // Use Query if we have key conditions, otherwise Scan
    const isQuery = this._pkValue !== undefined
    const response = isQuery
      ? await this.client.query(request)
      : await this.client.scan(request)

    return (response.Items ?? []).map((item: any) => this.driver.unmarshall(item)) as T[]
  }

  /**
   * Get first result
   */
  async first(): Promise<T | undefined> {
    this._limitValue = 1
    const results = await this.get()
    return results[0]
  }

  /**
   * Get all results (auto-paginate)
   */
  async getAll(): Promise<T[]> {
    const allItems: T[] = []
    let lastKey: Record<string, any> | undefined

    do {
      if (lastKey) {
        this._startKey = lastKey
      }

      const request = this.toRequest()
      const isQuery = this._pkValue !== undefined
      const response = isQuery
        ? await this.client.query(request)
        : await this.client.scan(request)

      const items = (response.Items ?? []).map((item: any) => this.driver.unmarshall(item)) as T[]
      allItems.push(...items)

      lastKey = response.LastEvaluatedKey
        ? this.driver.unmarshall(response.LastEvaluatedKey)
        : undefined
    } while (lastKey)

    return allItems
  }

  /**
   * Count matching items
   */
  async count(): Promise<number> {
    if (!this.client) {
      throw new Error('DynamoDB client not configured. Call dynamo.connection() first.')
    }

    const request = this.toRequest()
    request.Select = 'COUNT'

    const isQuery = this._pkValue !== undefined
    const response = isQuery
      ? await this.client.query(request)
      : await this.client.scan(request)

    return response.Count ?? 0
  }
}

// ============================================================================
// Dynamo Client
// ============================================================================

/**
 * DynamoDB client with entity-centric API
 */
class DynamoClient {
  private driver?: DynamoDBDriver
  private client?: any
  private tableName: string = ''
  private pkAttribute: string = 'pk'
  private skAttribute: string = 'sk'
  private entityTypeAttr: string = '_et'
  private delimiter: string = '#'
  private entityMappings: Map<string, SingleTableEntityMapping> = new Map()

  /**
   * Configure DynamoDB connection
   */
  connection(config: DynamoConnectionConfig): this {
    const driverConfig: DynamoDBConfig = {
      region: config.region,
      tableName: config.table,
      endpoint: config.endpoint,
      credentials: config.credentials,
    }

    this.driver = createDynamoDBDriver(driverConfig)
    this.tableName = config.table
    this.pkAttribute = config.pkAttribute ?? 'pk'
    this.skAttribute = config.skAttribute ?? 'sk'
    this.entityTypeAttr = config.entityTypeAttribute ?? '_et'
    this.delimiter = config.keyDelimiter ?? '#'

    return this
  }

  /**
   * Set the AWS SDK DynamoDB client
   */
  setClient(client: any): this {
    this.client = client
    return this
  }

  /**
   * Register an entity mapping for single table design
   */
  registerEntity(mapping: SingleTableEntityMapping): this {
    this.entityMappings.set(mapping.entityType, mapping)
    if (this.driver) {
      this.driver.registerEntity(mapping)
    }
    return this
  }

  /**
   * Start an entity-centric query
   */
  entity<T = any>(entityType: string): EntityQueryBuilder<T> {
    if (!this.driver) {
      throw new Error('DynamoDB not configured. Call dynamo.connection() first.')
    }

    const builder = new EntityQueryBuilder<T>(
      this.driver,
      this.client,
      this.tableName,
      {
        pkAttribute: this.pkAttribute,
        skAttribute: this.skAttribute,
        entityTypeAttribute: this.entityTypeAttr,
        keyDelimiter: this.delimiter,
      },
    )

    return builder.entity(entityType)
  }

  /**
   * Batch write operations
   */
  async batchWrite(operations: BatchWriteOperation[]): Promise<void> {
    if (!this.client) {
      throw new Error('DynamoDB client not configured. Call setClient() first.')
    }
    if (!this.driver) {
      throw new Error('DynamoDB not configured. Call dynamo.connection() first.')
    }

    const requestItems: any[] = []

    for (const op of operations) {
      if (op.put) {
        const item = {
          ...op.put.item,
          [this.entityTypeAttr]: op.put.entity,
        }
        requestItems.push({
          PutRequest: {
            Item: this.driver.marshall(item),
          },
        })
      }
      else if (op.delete) {
        requestItems.push({
          DeleteRequest: {
            Key: this.driver.marshall({
              [this.pkAttribute]: op.delete.pk,
              [this.skAttribute]: op.delete.sk,
            }),
          },
        })
      }
    }

    if (requestItems.length > 0) {
      await this.client.batchWriteItem({
        RequestItems: {
          [this.tableName]: requestItems,
        },
      })
    }
  }

  /**
   * Transactional write operations
   */
  async transactWrite(operations: TransactWriteOperation[]): Promise<void> {
    if (!this.client) {
      throw new Error('DynamoDB client not configured. Call setClient() first.')
    }
    if (!this.driver) {
      throw new Error('DynamoDB not configured. Call dynamo.connection() first.')
    }

    const transactItems: any[] = []

    for (const op of operations) {
      if (op.put) {
        const item = {
          ...op.put.item,
          [this.entityTypeAttr]: op.put.entity,
        }
        const transactItem: any = {
          Put: {
            TableName: this.tableName,
            Item: this.driver.marshall(item),
          },
        }
        if (op.put.condition) {
          transactItem.Put.ConditionExpression = op.put.condition
        }
        transactItems.push(transactItem)
      }
      else if (op.update) {
        const key: Record<string, any> = {
          [this.pkAttribute]: op.update.pk,
        }
        if (op.update.sk) {
          key[this.skAttribute] = op.update.sk
        }

        const updateParts: string[] = []
        const exprNames: Record<string, string> = {}
        const exprValues: Record<string, any> = {}
        let idx = 0

        if (op.update.set) {
          const setParts: string[] = []
          for (const [attr, value] of Object.entries(op.update.set)) {
            const nameKey = `#set${idx}`
            const valueKey = `:set${idx}`
            exprNames[nameKey] = attr
            exprValues[valueKey] = this.driver.marshall({ v: value }).v
            setParts.push(`${nameKey} = ${valueKey}`)
            idx++
          }
          if (setParts.length > 0) {
            updateParts.push(`SET ${setParts.join(', ')}`)
          }
        }

        if (op.update.add) {
          const addParts: string[] = []
          for (const [attr, value] of Object.entries(op.update.add)) {
            const nameKey = `#add${idx}`
            const valueKey = `:add${idx}`
            exprNames[nameKey] = attr
            exprValues[valueKey] = { N: String(value) }
            addParts.push(`${nameKey} ${valueKey}`)
            idx++
          }
          if (addParts.length > 0) {
            updateParts.push(`ADD ${addParts.join(', ')}`)
          }
        }

        if (op.update.remove && op.update.remove.length > 0) {
          const removeParts: string[] = []
          for (const attr of op.update.remove) {
            const nameKey = `#rem${idx}`
            exprNames[nameKey] = attr
            removeParts.push(nameKey)
            idx++
          }
          updateParts.push(`REMOVE ${removeParts.join(', ')}`)
        }

        transactItems.push({
          Update: {
            TableName: this.tableName,
            Key: this.driver.marshall(key),
            UpdateExpression: updateParts.join(' '),
            ExpressionAttributeNames: exprNames,
            ExpressionAttributeValues: exprValues,
          },
        })
      }
      else if (op.delete) {
        const transactItem: any = {
          Delete: {
            TableName: this.tableName,
            Key: this.driver.marshall({
              [this.pkAttribute]: op.delete.pk,
              [this.skAttribute]: op.delete.sk,
            }),
          },
        }
        if (op.delete.condition) {
          transactItem.Delete.ConditionExpression = op.delete.condition
        }
        transactItems.push(transactItem)
      }
      else if (op.conditionCheck) {
        transactItems.push({
          ConditionCheck: {
            TableName: this.tableName,
            Key: this.driver.marshall({
              [this.pkAttribute]: op.conditionCheck.pk,
              [this.skAttribute]: op.conditionCheck.sk,
            }),
            ConditionExpression: op.conditionCheck.condition,
          },
        })
      }
    }

    if (transactItems.length > 0) {
      await this.client.transactWriteItems({
        TransactItems: transactItems,
      })
    }
  }

  /**
   * Get the underlying driver
   */
  getDriver(): DynamoDBDriver | undefined {
    return this.driver
  }
}

// ============================================================================
// Exports
// ============================================================================

/**
 * DynamoDB client singleton
 */
export const dynamo = new DynamoClient()

/**
 * Create a new DynamoDB client instance
 */
export function createDynamo(): DynamoClient {
  return new DynamoClient()
}

// Re-export types from driver
export type {
  DynamoDBConfig,
  DynamoDBDriver,
  SingleTableEntityMapping,
} from '../drivers/dynamodb'

// Re-export Model and client
export { Model, configureModels } from './model'
export { DynamoDBClient, createClient } from './client'
export type { DynamoDBClientConfig, DynamoDBCredentials } from './client'
export type { ModelConfig, ModelQueryBuilder } from './model'

// Re-export migrations
export {
  DynamoDBMigrationDriver,
  createMigrationDriver,
  migrateModels,
} from './migration-driver'
export type { MigrationDriverConfig, MigrationResult } from './migration-driver'

export {
  buildMigrationPlan as buildDynamoDBMigrationPlan,
  extractTableDefinition,
  extractModelSchema,
  convertSchemaToDefinition,
  hashTableDefinition,
  isDefinitionEqual,
} from './migrations'
export type {
  DynamoDBMigrationPlan,
  DynamoDBMigrationOperation,
  DynamoDBMigrationOperationType,
  DynamoDBMigrationState,
  DynamoDBModelSchema,
  DynamoDBGSIDefinition,
  DynamoDBLSIDefinition,
} from './migrations'

export { DynamoDBMigrationTracker, MIGRATIONS_TABLE } from './migration-tracker'
