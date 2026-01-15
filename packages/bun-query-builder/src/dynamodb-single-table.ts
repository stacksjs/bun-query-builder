/**
 * DynamoDB Single Table Design Support
 *
 * This module provides utilities for implementing single table design patterns
 * in DynamoDB, where multiple entity types are stored in a single table with
 * different PK/SK patterns.
 *
 * Key concepts:
 * - Entity Type: A model type (e.g., User, Post, Comment)
 * - PK Pattern: Pattern for partition key (e.g., 'USER#${id}')
 * - SK Pattern: Pattern for sort key (e.g., 'METADATA' or 'POST#${postId}')
 * - GSI Overloading: Using GSIs to enable different access patterns
 */

import type {
  DynamoDBConfig,
  DynamoDBDriver,
  DynamoDBGlobalSecondaryIndex,
  DynamoDBTableDefinition,
  SingleTableEntityMapping,
} from './drivers/dynamodb'
import { createDynamoDBDriver } from './drivers/dynamodb'
import type { DynamoDBQueryBuilderOptions } from './dynamodb-client'
import { DynamoDBItemBuilder, DynamoDBQueryBuilder } from './dynamodb-client'

/**
 * Entity definition for single table design
 */
export interface SingleTableEntity {
  /** Entity type name */
  name: string
  /** Pattern for partition key with ${field} placeholders */
  pkPattern: string
  /** Pattern for sort key with ${field} placeholders */
  skPattern: string
  /** Fields that make up the primary key */
  keyFields: string[]
  /** GSI mappings for this entity */
  indexes?: {
    /** GSI name */
    name: string
    /** Pattern for GSI partition key */
    pkPattern: string
    /** Pattern for GSI sort key */
    skPattern?: string
  }[]
  /** Schema for entity attributes */
  schema?: Record<string, {
    type: 'string' | 'number' | 'boolean' | 'list' | 'map' | 'set'
    required?: boolean
  }>
}

/**
 * Single table design configuration
 */
export interface SingleTableConfig {
  /** Table name */
  tableName: string
  /** Partition key attribute name (default: 'pk') */
  pkAttribute?: string
  /** Sort key attribute name (default: 'sk') */
  skAttribute?: string
  /** Entity type attribute name (default: '_type') */
  typeAttribute?: string
  /** GSI definitions */
  indexes?: {
    name: string
    pkAttribute: string
    skAttribute?: string
  }[]
  /** Entity definitions */
  entities: SingleTableEntity[]
}

/**
 * Single Table Design Manager
 *
 * Manages entity mappings and provides utilities for working with
 * single table design patterns.
 */
export class SingleTableManager {
  private config: SingleTableConfig
  private entities: Map<string, SingleTableEntity> = new Map()
  private pkAttribute: string
  private skAttribute: string
  private typeAttribute: string

  constructor(config: SingleTableConfig) {
    this.config = config
    this.pkAttribute = config.pkAttribute ?? 'pk'
    this.skAttribute = config.skAttribute ?? 'sk'
    this.typeAttribute = config.typeAttribute ?? '_type'

    // Register all entities
    for (const entity of config.entities) {
      this.entities.set(entity.name, entity)
    }
  }

  /**
   * Get entity definition by name
   */
  getEntity(name: string): SingleTableEntity | undefined {
    return this.entities.get(name)
  }

  /**
   * Register a new entity
   */
  registerEntity(entity: SingleTableEntity): void {
    this.entities.set(entity.name, entity)
  }

  /**
   * Build primary key for an entity
   */
  buildKey(entityName: string, data: Record<string, any>): { pk: string, sk: string } {
    const entity = this.entities.get(entityName)
    if (!entity) {
      throw new Error(`Entity not found: ${entityName}`)
    }

    const pk = this.interpolatePattern(entity.pkPattern, data)
    const sk = this.interpolatePattern(entity.skPattern, data)

    return { pk, sk }
  }

  /**
   * Build GSI key for an entity
   */
  buildGSIKey(entityName: string, indexName: string, data: Record<string, any>): { pk: string, sk?: string } {
    const entity = this.entities.get(entityName)
    if (!entity) {
      throw new Error(`Entity not found: ${entityName}`)
    }

    const gsi = entity.indexes?.find(i => i.name === indexName)
    if (!gsi) {
      throw new Error(`GSI not found: ${indexName} for entity ${entityName}`)
    }

    const pk = this.interpolatePattern(gsi.pkPattern, data)
    const sk = gsi.skPattern ? this.interpolatePattern(gsi.skPattern, data) : undefined

    return { pk, sk }
  }

  /**
   * Create a full item with pk, sk, and type attribute
   */
  createItem(entityName: string, data: Record<string, any>): Record<string, any> {
    const { pk, sk } = this.buildKey(entityName, data)
    const entity = this.entities.get(entityName)!

    const item: Record<string, any> = {
      [this.pkAttribute]: pk,
      [this.skAttribute]: sk,
      [this.typeAttribute]: entityName,
      ...data,
    }

    // Add GSI keys if defined
    if (entity.indexes) {
      for (const index of entity.indexes) {
        const gsiKey = this.buildGSIKey(entityName, index.name, data)
        const gsiConfig = this.config.indexes?.find(i => i.name === index.name)
        if (gsiConfig) {
          item[gsiConfig.pkAttribute] = gsiKey.pk
          if (gsiConfig.skAttribute && gsiKey.sk) {
            item[gsiConfig.skAttribute] = gsiKey.sk
          }
        }
      }
    }

    return item
  }

  /**
   * Parse entity type from an item
   */
  parseEntityType(item: Record<string, any>): string | undefined {
    // First check the type attribute
    if (item[this.typeAttribute]) {
      return item[this.typeAttribute]
    }

    // Fall back to pattern matching on PK
    const pk = item[this.pkAttribute]
    if (!pk) return undefined

    for (const [name, entity] of this.entities) {
      const prefix = entity.pkPattern.split('${')[0]
      if (pk.startsWith(prefix)) {
        return name
      }
    }

    return undefined
  }

  /**
   * Parse an item into typed data
   */
  parseItem<T = any>(item: Record<string, any>): { type: string, data: T } | undefined {
    const type = this.parseEntityType(item)
    if (!type) return undefined

    // Remove internal attributes
    const { [this.pkAttribute]: _, [this.skAttribute]: __, [this.typeAttribute]: ___, ...data } = item

    return { type, data: data as T }
  }

  /**
   * Get entity prefix for querying
   */
  getEntityPrefix(entityName: string): string {
    const entity = this.entities.get(entityName)
    if (!entity) {
      throw new Error(`Entity not found: ${entityName}`)
    }
    return entity.pkPattern.split('${')[0]
  }

  /**
   * Generate table definition with all required attributes and indexes
   */
  generateTableDefinition(): DynamoDBTableDefinition {
    const attributeDefinitions: { name: string, type: 'S' | 'N' | 'B' }[] = [
      { name: this.pkAttribute, type: 'S' },
      { name: this.skAttribute, type: 'S' },
    ]

    const globalSecondaryIndexes: DynamoDBGlobalSecondaryIndex[] = []

    // Add GSI attribute definitions and index configs
    if (this.config.indexes) {
      for (const index of this.config.indexes) {
        // Add PK attribute if not already defined
        if (!attributeDefinitions.find(a => a.name === index.pkAttribute)) {
          attributeDefinitions.push({ name: index.pkAttribute, type: 'S' })
        }
        // Add SK attribute if defined and not already present
        if (index.skAttribute && !attributeDefinitions.find(a => a.name === index.skAttribute)) {
          attributeDefinitions.push({ name: index.skAttribute, type: 'S' })
        }

        globalSecondaryIndexes.push({
          indexName: index.name,
          keySchema: {
            partitionKey: index.pkAttribute,
            sortKey: index.skAttribute,
          },
          projection: { type: 'ALL' },
        })
      }
    }

    return {
      tableName: this.config.tableName,
      keySchema: {
        partitionKey: this.pkAttribute,
        sortKey: this.skAttribute,
      },
      attributeDefinitions,
      globalSecondaryIndexes: globalSecondaryIndexes.length > 0 ? globalSecondaryIndexes : undefined,
      billingMode: 'PAY_PER_REQUEST',
    }
  }

  private interpolatePattern(pattern: string, values: Record<string, any>): string {
    return pattern.replace(/\$\{(\w+)\}/g, (_, key) => {
      if (!(key in values)) {
        throw new Error(`Missing value for pattern key: ${key}`)
      }
      return String(values[key])
    })
  }
}

/**
 * Single Table Entity Repository
 *
 * Provides CRUD operations for a specific entity type in a single table design.
 */
export class SingleTableRepository<T extends Record<string, any>> {
  private manager: SingleTableManager
  private entityName: string
  private options: DynamoDBQueryBuilderOptions

  constructor(
    manager: SingleTableManager,
    entityName: string,
    options: DynamoDBQueryBuilderOptions,
  ) {
    this.manager = manager
    this.entityName = entityName
    this.options = options
  }

  /**
   * Create a new item
   */
  async create(data: T): Promise<T> {
    const item = this.manager.createItem(this.entityName, data)
    const builder = new DynamoDBItemBuilder<T>(this.options)
      .table(this.options.config.tableName!)
      .item(item)
      .ifNotExists('pk')

    if (this.options.client) {
      await builder.put()
    }

    return data
  }

  /**
   * Get an item by key fields
   */
  async get(keyData: Partial<T>): Promise<T | undefined> {
    const { pk, sk } = this.manager.buildKey(this.entityName, keyData as Record<string, any>)

    const builder = new DynamoDBItemBuilder<Record<string, any>>(this.options)
      .table(this.options.config.tableName!)
      .key({ pk, sk })

    if (!this.options.client) {
      throw new Error('DynamoDB client not provided')
    }

    const result = await builder.get()
    if (!result) return undefined

    const parsed = this.manager.parseItem<T>(result)
    return parsed?.data
  }

  /**
   * Update an item
   */
  async update(keyData: Partial<T>, updates: Partial<T>): Promise<T | undefined> {
    const { pk, sk } = this.manager.buildKey(this.entityName, keyData as Record<string, any>)

    const builder = new DynamoDBItemBuilder<Record<string, any>>(this.options)
      .table(this.options.config.tableName!)
      .key({ pk, sk })
      .setMany(updates as Record<string, any>)
      .ifExists('pk')
      .returnNew()

    if (!this.options.client) {
      throw new Error('DynamoDB client not provided')
    }

    const result = await builder.update()
    if (!result) return undefined

    const parsed = this.manager.parseItem<T>(result)
    return parsed?.data
  }

  /**
   * Delete an item
   */
  async delete(keyData: Partial<T>): Promise<boolean> {
    const { pk, sk } = this.manager.buildKey(this.entityName, keyData as Record<string, any>)

    const builder = new DynamoDBItemBuilder(this.options)
      .table(this.options.config.tableName!)
      .key({ pk, sk })

    if (!this.options.client) {
      throw new Error('DynamoDB client not provided')
    }

    await builder.delete()
    return true
  }

  /**
   * Query items by partition key
   */
  query(): SingleTableQueryBuilder<T> {
    return new SingleTableQueryBuilder<T>(
      this.manager,
      this.entityName,
      this.options,
    )
  }

  /**
   * Find all items of this entity type
   * Note: This performs a scan with filter, use sparingly
   */
  async findAll(): Promise<T[]> {
    const typeAttr = (this.manager as any).typeAttribute ?? '_type'

    const builder = new DynamoDBQueryBuilder(this.options)
      .table(this.options.config.tableName!)
      .whereEquals(typeAttr, this.entityName)

    if (!this.options.client) {
      throw new Error('DynamoDB client not provided')
    }

    const items = await builder.getAll()
    return items
      .map(item => this.manager.parseItem<T>(item))
      .filter((p): p is { type: string, data: T } => p !== undefined)
      .map(p => p.data)
  }
}

/**
 * Query builder for single table entity queries
 */
export class SingleTableQueryBuilder<T> {
  private manager: SingleTableManager
  private entityName: string
  private options: DynamoDBQueryBuilderOptions
  private builder: DynamoDBQueryBuilder<Record<string, any>>
  private pkValue?: string
  private skConditions: { operator: string, value: any, values?: any[] }[] = []

  constructor(
    manager: SingleTableManager,
    entityName: string,
    options: DynamoDBQueryBuilderOptions,
  ) {
    this.manager = manager
    this.entityName = entityName
    this.options = options
    this.builder = new DynamoDBQueryBuilder(options)
      .table(options.config.tableName!)
  }

  /**
   * Query by a specific partition key value
   */
  wherePartitionKey(pkData: Record<string, any>): this {
    const { pk } = this.manager.buildKey(this.entityName, pkData)
    this.pkValue = pk
    const pkAttr = (this.manager as any).pkAttribute ?? 'pk'
    this.builder.wherePartitionKey(pkAttr, pk)
    return this
  }

  /**
   * Query where sort key equals a value
   */
  whereSortKey(skData: Record<string, any>): this {
    const { sk } = this.manager.buildKey(this.entityName, skData)
    const skAttr = (this.manager as any).skAttribute ?? 'sk'
    this.builder.whereSortKey(skAttr, sk)
    return this
  }

  /**
   * Query where sort key begins with prefix
   */
  whereSortKeyBeginsWith(prefix: string): this {
    const skAttr = (this.manager as any).skAttribute ?? 'sk'
    this.builder.whereSortKeyBeginsWith(skAttr, prefix)
    return this
  }

  /**
   * Use a GSI for the query
   */
  useIndex(indexName: string, pkData: Record<string, any>): this {
    const gsiKey = this.manager.buildGSIKey(this.entityName, indexName, pkData)
    const gsiConfig = (this.manager as any).config.indexes?.find((i: any) => i.name === indexName)

    if (!gsiConfig) {
      throw new Error(`GSI configuration not found: ${indexName}`)
    }

    this.builder.index(indexName)
    this.builder.wherePartitionKey(gsiConfig.pkAttribute, gsiKey.pk)

    return this
  }

  /**
   * Add a filter condition
   */
  where(attribute: string, operator: any, value?: any): this {
    this.builder.where(attribute, operator, value)
    return this
  }

  /**
   * Select specific attributes
   */
  select(...attributes: string[]): this {
    this.builder.select(...attributes)
    return this
  }

  /**
   * Limit results
   */
  limit(count: number): this {
    this.builder.limit(count)
    return this
  }

  /**
   * Sort descending
   */
  descending(): this {
    this.builder.descending()
    return this
  }

  /**
   * Execute the query
   */
  async execute(): Promise<T[]> {
    if (!this.options.client) {
      throw new Error('DynamoDB client not provided')
    }

    const result = await this.builder.query()
    return (result.items ?? [])
      .map(item => this.manager.parseItem<T>(item))
      .filter((p): p is { type: string, data: T } => p !== undefined)
      .map(p => p.data)
  }

  /**
   * Get the first result
   */
  async first(): Promise<T | undefined> {
    this.limit(1)
    const results = await this.execute()
    return results[0]
  }
}

/**
 * Create a single table manager
 */
export function createSingleTableManager(config: SingleTableConfig): SingleTableManager {
  return new SingleTableManager(config)
}

/**
 * Create a repository for an entity
 */
export function createRepository<T extends Record<string, any>>(
  manager: SingleTableManager,
  entityName: string,
  options: DynamoDBQueryBuilderOptions,
): SingleTableRepository<T> {
  return new SingleTableRepository<T>(manager, entityName, options)
}

/**
 * Common single table design patterns
 */
export const SingleTablePatterns = {
  /**
   * User with profile pattern
   * PK: USER#<userId>
   * SK: PROFILE for metadata, or related items like ORDER#<orderId>
   */
  simpleEntity: (entityName: string, idField: string = 'id'): SingleTableEntity => ({
    name: entityName,
    pkPattern: `${entityName.toUpperCase()}#\${${idField}}`,
    skPattern: 'METADATA',
    keyFields: [idField],
  }),

  /**
   * One-to-many relationship pattern
   * Parent: PK=PARENT#<parentId>, SK=METADATA
   * Child: PK=PARENT#<parentId>, SK=CHILD#<childId>
   */
  oneToMany: (
    parentEntity: string,
    childEntity: string,
    parentIdField: string = 'id',
    childIdField: string = 'id',
  ): { parent: SingleTableEntity, child: SingleTableEntity } => ({
    parent: {
      name: parentEntity,
      pkPattern: `${parentEntity.toUpperCase()}#\${${parentIdField}}`,
      skPattern: 'METADATA',
      keyFields: [parentIdField],
    },
    child: {
      name: childEntity,
      pkPattern: `${parentEntity.toUpperCase()}#\${${parentIdField}}`,
      skPattern: `${childEntity.toUpperCase()}#\${${childIdField}}`,
      keyFields: [parentIdField, childIdField],
    },
  }),

  /**
   * Many-to-many relationship pattern using adjacency list
   * Entity: PK=ENTITY#<entityId>, SK=METADATA
   * Relationship: PK=ENTITY#<entityId>, SK=RELATED#<relatedId>
   * Inverse: PK=ENTITY#<relatedId>, SK=RELATED#<entityId> (via GSI)
   */
  manyToMany: (
    entityName: string,
    relationName: string,
    idField: string = 'id',
    relatedIdField: string = 'relatedId',
  ): { entity: SingleTableEntity, relation: SingleTableEntity } => ({
    entity: {
      name: entityName,
      pkPattern: `${entityName.toUpperCase()}#\${${idField}}`,
      skPattern: 'METADATA',
      keyFields: [idField],
    },
    relation: {
      name: relationName,
      pkPattern: `${entityName.toUpperCase()}#\${${idField}}`,
      skPattern: `${relationName.toUpperCase()}#\${${relatedIdField}}`,
      keyFields: [idField, relatedIdField],
      indexes: [{
        name: 'GSI1',
        pkPattern: `${entityName.toUpperCase()}#\${${relatedIdField}}`,
        skPattern: `${relationName.toUpperCase()}#\${${idField}}`,
      }],
    },
  }),

  /**
   * Hierarchical data pattern (e.g., org chart, file system)
   * PK: ROOT#<rootId>
   * SK: PATH#<path> (e.g., PATH#/folder1/folder2/file)
   */
  hierarchical: (entityName: string, rootIdField: string = 'rootId', pathField: string = 'path'): SingleTableEntity => ({
    name: entityName,
    pkPattern: `ROOT#\${${rootIdField}}`,
    skPattern: `PATH#\${${pathField}}`,
    keyFields: [rootIdField, pathField],
  }),
}
