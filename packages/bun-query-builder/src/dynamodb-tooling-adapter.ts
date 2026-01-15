/**
 * DynamoDB Tooling Adapter
 *
 * This module provides integration between bun-query-builder's DynamoDB driver
 * and the dynamodb-tooling ORM. It bridges the gap between:
 *
 * 1. Stacks model definitions (from dynamodb-tooling)
 * 2. Single table design patterns (from dynamodb-tooling)
 * 3. bun-query-builder's DynamoDB query builder
 *
 * This allows users to:
 * - Define models using Stacks conventions
 * - Have them automatically transformed to DynamoDB single-table design
 * - Use bun-query-builder's fluent API for queries
 */

import type { DynamoDBConfig, DynamoDBDriver, SingleTableEntityMapping } from './drivers/dynamodb'
import type { DynamoDBQueryBuilderOptions } from './dynamodb-client'
import type { SingleTableConfig, SingleTableEntity } from './dynamodb-single-table'
import { createDynamoDBDriver } from './drivers/dynamodb'
import { DynamoDBItemBuilder, DynamoDBQueryBuilder } from './dynamodb-client'
import { createRepository, createSingleTableManager, SingleTableManager, SingleTableRepository } from './dynamodb-single-table'

/**
 * Configuration for dynamodb-tooling integration
 */
export interface DynamoDBToolingConfig {
  /** AWS region */
  region: string
  /** DynamoDB endpoint (for local development) */
  endpoint?: string
  /** AWS credentials */
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** Table name for single table design */
  tableName: string
  /** Partition key attribute name (default: 'pk') */
  pkAttribute?: string
  /** Sort key attribute name (default: 'sk') */
  skAttribute?: string
  /** Entity type attribute name (default: '_et') */
  entityTypeAttribute?: string
  /** Key delimiter (default: '#') */
  keyDelimiter?: string
  /** GSI configurations */
  gsiConfig?: {
    gsi1pk?: string
    gsi1sk?: string
    gsi2pk?: string
    gsi2sk?: string
    gsi3pk?: string
    gsi3sk?: string
  }
}

/**
 * Parsed model definition from dynamodb-tooling
 * This interface is compatible with dynamodb-tooling's ParsedModel
 */
export interface ParsedModelDefinition {
  name: string
  entityType: string
  primaryKey: string
  attributes: {
    name: string
    fillable: boolean
    required: boolean
    nullable: boolean
    unique: boolean
    hidden: boolean
    cast?: string
    defaultValue?: unknown
    dynamoDbType?: 'S' | 'N' | 'B' | 'BOOL' | 'NULL' | 'M' | 'L' | 'SS' | 'NS' | 'BS'
  }[]
  relationships: {
    type: 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany'
    relatedModel: string
    foreignKey: string
    localKey: string
    pivotEntity?: string
    requiresGsi?: boolean
    gsiIndex?: number
  }[]
  keyPatterns: {
    pk: string
    sk: string
    gsi1pk?: string
    gsi1sk?: string
    gsi2pk?: string
    gsi2sk?: string
  }
  hasTimestamps: boolean
  hasSoftDeletes: boolean
  hasVersioning: boolean
}

/**
 * Stacks model definition format
 * Compatible with bun-query-builder's schema.ts ModelOptions
 */
export interface StacksModelInput {
  name: string
  table?: string
  primaryKey?: string
  attributes?: Record<string, {
    default?: unknown
    unique?: boolean
    hidden?: boolean
    fillable?: boolean
    validation?: {
      rule: unknown
      message?: Record<string, string>
    }
  }>
  hasOne?: string[]
  hasMany?: string[]
  belongsTo?: string[]
  belongsToMany?: string[]
  traits?: {
    useTimestamps?: boolean
    useSoftDeletes?: boolean
    useUuid?: boolean
    useVersioning?: boolean
  }
}

/**
 * DynamoDB Tooling Adapter
 *
 * Bridges dynamodb-tooling with bun-query-builder
 */
export class DynamoDBToolingAdapter {
  private config: DynamoDBToolingConfig
  private driver: DynamoDBDriver
  private singleTableManager: SingleTableManager
  private models: Map<string, ParsedModelDefinition> = new Map()
  private queryBuilderOptions: DynamoDBQueryBuilderOptions

  constructor(config: DynamoDBToolingConfig) {
    this.config = {
      pkAttribute: 'pk',
      skAttribute: 'sk',
      entityTypeAttribute: '_et',
      keyDelimiter: '#',
      ...config,
    }

    // Create DynamoDB driver
    const driverConfig: DynamoDBConfig = {
      region: config.region,
      endpoint: config.endpoint,
      credentials: config.credentials,
      tableName: config.tableName,
    }
    this.driver = createDynamoDBDriver(driverConfig)

    // Initialize single table manager with empty config (models will be registered)
    const singleTableConfig: SingleTableConfig = {
      tableName: config.tableName,
      pkAttribute: this.config.pkAttribute,
      skAttribute: this.config.skAttribute,
      typeAttribute: this.config.entityTypeAttribute,
      indexes: this.buildGSIConfig(),
      entities: [],
    }
    this.singleTableManager = createSingleTableManager(singleTableConfig)

    // Create query builder options
    this.queryBuilderOptions = {
      config: driverConfig,
    }
  }

  /**
   * Set the DynamoDB client instance
   */
  setClient(client: any): this {
    this.queryBuilderOptions.client = client
    return this
  }

  /**
   * Register a Stacks model for use with DynamoDB
   */
  registerModel(model: StacksModelInput): ParsedModelDefinition {
    const parsed = this.parseStacksModel(model)
    this.models.set(parsed.name, parsed)

    // Register with single table manager
    const entity = this.toSingleTableEntity(parsed)
    this.singleTableManager.registerEntity(entity)

    // Register with driver
    const mapping = this.toEntityMapping(parsed)
    this.driver.registerEntity(mapping)

    return parsed
  }

  /**
   * Register multiple Stacks models
   */
  registerModels(models: StacksModelInput[]): ParsedModelDefinition[] {
    return models.map(m => this.registerModel(m))
  }

  /**
   * Get a registered model by name
   */
  getModel(name: string): ParsedModelDefinition | undefined {
    return this.models.get(name)
  }

  /**
   * Get all registered models
   */
  getAllModels(): ParsedModelDefinition[] {
    return Array.from(this.models.values())
  }

  /**
   * Create a repository for a model
   */
  repository<T extends Record<string, any>>(modelName: string): SingleTableRepository<T> {
    const model = this.models.get(modelName)
    if (!model) {
      throw new Error(`Model not found: ${modelName}`)
    }
    return createRepository<T>(this.singleTableManager, modelName, this.queryBuilderOptions)
  }

  /**
   * Create a query builder for a model
   */
  query<T = any>(modelName: string): DynamoDBQueryBuilder<T> {
    const model = this.models.get(modelName)
    if (!model) {
      throw new Error(`Model not found: ${modelName}`)
    }

    return new DynamoDBQueryBuilder<T>(this.queryBuilderOptions)
      .table(this.config.tableName)
      .entity(modelName)
  }

  /**
   * Create an item builder for a model
   */
  item<T = any>(modelName: string): DynamoDBItemBuilder<T> {
    const model = this.models.get(modelName)
    if (!model) {
      throw new Error(`Model not found: ${modelName}`)
    }

    return new DynamoDBItemBuilder<T>(this.queryBuilderOptions)
      .table(this.config.tableName)
  }

  /**
   * Build primary key for an entity
   */
  buildKey(modelName: string, data: Record<string, any>): { pk: string, sk: string } {
    return this.singleTableManager.buildKey(modelName, data)
  }

  /**
   * Create a full DynamoDB item with pk, sk, entity type
   */
  createItem(modelName: string, data: Record<string, any>): Record<string, any> {
    const model = this.models.get(modelName)
    if (!model) {
      throw new Error(`Model not found: ${modelName}`)
    }

    const item = this.singleTableManager.createItem(modelName, data)

    // Add timestamps if model has them
    if (model.hasTimestamps) {
      const now = new Date().toISOString()
      if (!item.createdAt) {
        item.createdAt = now
      }
      item.updatedAt = now
    }

    // Add version if model uses versioning
    if (model.hasVersioning) {
      if (!item._v) {
        item._v = 1
      }
    }

    return item
  }

  /**
   * Parse entity type from a DynamoDB item
   */
  parseItem<T = any>(item: Record<string, any>): { type: string, data: T } | undefined {
    return this.singleTableManager.parseItem<T>(item)
  }

  /**
   * Get the underlying DynamoDB driver
   */
  getDriver(): DynamoDBDriver {
    return this.driver
  }

  /**
   * Get the single table manager
   */
  getSingleTableManager(): SingleTableManager {
    return this.singleTableManager
  }

  /**
   * Generate table definition for all registered models
   */
  generateTableDefinition(): any {
    return this.singleTableManager.generateTableDefinition()
  }

  // Private helper methods

  private parseStacksModel(model: StacksModelInput): ParsedModelDefinition {
    const entityType = model.name.toUpperCase()
    const primaryKey = model.primaryKey ?? 'id'
    const delimiter = this.config.keyDelimiter!

    // Parse attributes
    const attributes = this.parseAttributes(model)

    // Parse relationships
    const relationships = this.parseRelationships(model, primaryKey)

    // Generate key patterns
    const keyPatterns = this.generateKeyPatterns(entityType, primaryKey, delimiter, relationships)

    return {
      name: model.name,
      entityType,
      primaryKey,
      attributes,
      relationships,
      keyPatterns,
      hasTimestamps: model.traits?.useTimestamps ?? false,
      hasSoftDeletes: model.traits?.useSoftDeletes ?? false,
      hasVersioning: model.traits?.useVersioning ?? false,
    }
  }

  private parseAttributes(model: StacksModelInput): ParsedModelDefinition['attributes'] {
    const attributes: ParsedModelDefinition['attributes'] = []

    // Add ID attribute
    attributes.push({
      name: model.primaryKey ?? 'id',
      fillable: false,
      required: true,
      nullable: false,
      unique: true,
      hidden: false,
      dynamoDbType: 'S',
    })

    // Add model attributes
    if (model.attributes) {
      for (const [name, def] of Object.entries(model.attributes)) {
        attributes.push({
          name,
          fillable: def.fillable ?? true,
          required: false,
          nullable: true,
          unique: def.unique ?? false,
          hidden: def.hidden ?? false,
          defaultValue: def.default,
          dynamoDbType: this.inferDynamoDBType(def),
        })
      }
    }

    // Add timestamp attributes
    if (model.traits?.useTimestamps) {
      attributes.push(
        { name: 'createdAt', fillable: false, required: true, nullable: false, unique: false, hidden: false, dynamoDbType: 'S' },
        { name: 'updatedAt', fillable: false, required: true, nullable: false, unique: false, hidden: false, dynamoDbType: 'S' },
      )
    }

    // Add soft delete attribute
    if (model.traits?.useSoftDeletes) {
      attributes.push({
        name: 'deletedAt',
        fillable: false,
        required: false,
        nullable: true,
        unique: false,
        hidden: false,
        dynamoDbType: 'S',
      })
    }

    return attributes
  }

  private inferDynamoDBType(def: any): 'S' | 'N' | 'B' | 'BOOL' | 'NULL' | 'M' | 'L' | 'SS' | 'NS' | 'BS' {
    // Check validation rules for type hints
    if (def.validation?.rule) {
      const rule = String(def.validation.rule)
      if (rule.includes('integer') || rule.includes('numeric') || rule.includes('number')) {
        return 'N'
      }
      if (rule.includes('boolean')) {
        return 'BOOL'
      }
      if (rule.includes('array')) {
        return 'L'
      }
      if (rule.includes('object')) {
        return 'M'
      }
    }

    // Default to string
    return 'S'
  }

  private parseRelationships(model: StacksModelInput, primaryKey: string): ParsedModelDefinition['relationships'] {
    const relationships: ParsedModelDefinition['relationships'] = []

    if (model.hasOne) {
      for (const related of model.hasOne) {
        relationships.push({
          type: 'hasOne',
          relatedModel: related,
          foreignKey: `${model.name.toLowerCase()}Id`,
          localKey: primaryKey,
          requiresGsi: true,
        })
      }
    }

    if (model.hasMany) {
      for (const related of model.hasMany) {
        relationships.push({
          type: 'hasMany',
          relatedModel: related,
          foreignKey: `${model.name.toLowerCase()}Id`,
          localKey: primaryKey,
          requiresGsi: false,
        })
      }
    }

    if (model.belongsTo) {
      for (const related of model.belongsTo) {
        relationships.push({
          type: 'belongsTo',
          relatedModel: related,
          foreignKey: `${related.toLowerCase()}Id`,
          localKey: primaryKey,
          requiresGsi: true,
        })
      }
    }

    if (model.belongsToMany) {
      for (const related of model.belongsToMany) {
        const pivotName = [model.name, related].sort().join('')
        relationships.push({
          type: 'belongsToMany',
          relatedModel: related,
          foreignKey: `${related.toLowerCase()}Id`,
          localKey: primaryKey,
          pivotEntity: pivotName,
          requiresGsi: true,
        })
      }
    }

    return relationships
  }

  private generateKeyPatterns(
    entityType: string,
    primaryKey: string,
    delimiter: string,
    relationships: ParsedModelDefinition['relationships'],
  ): ParsedModelDefinition['keyPatterns'] {
    const patterns: ParsedModelDefinition['keyPatterns'] = {
      pk: `${entityType}${delimiter}\${${primaryKey}}`,
      sk: `${entityType}${delimiter}\${${primaryKey}}`,
    }

    // Add GSI patterns for belongsTo relationships
    let gsiIndex = 1
    for (const rel of relationships) {
      if (rel.type === 'belongsTo' && rel.requiresGsi) {
        const relatedEntityType = rel.relatedModel.toUpperCase()
        if (gsiIndex === 1) {
          patterns.gsi1pk = `${relatedEntityType}${delimiter}\${${rel.foreignKey}}`
          patterns.gsi1sk = `${entityType}${delimiter}\${${primaryKey}}`
        }
        else if (gsiIndex === 2) {
          patterns.gsi2pk = `${relatedEntityType}${delimiter}\${${rel.foreignKey}}`
          patterns.gsi2sk = `${entityType}${delimiter}\${${primaryKey}}`
        }
        gsiIndex++
      }
    }

    return patterns
  }

  private toSingleTableEntity(model: ParsedModelDefinition): SingleTableEntity {
    const delimiter = this.config.keyDelimiter!

    return {
      name: model.name,
      pkPattern: `${model.entityType}${delimiter}\${${model.primaryKey}}`,
      skPattern: `${model.entityType}${delimiter}\${${model.primaryKey}}`,
      keyFields: [model.primaryKey],
      indexes: this.buildEntityIndexes(model),
      schema: this.buildEntitySchema(model),
    }
  }

  private buildEntityIndexes(model: ParsedModelDefinition): SingleTableEntity['indexes'] {
    const indexes: SingleTableEntity['indexes'] = []

    if (model.keyPatterns.gsi1pk) {
      indexes.push({
        name: 'GSI1',
        pkPattern: model.keyPatterns.gsi1pk,
        skPattern: model.keyPatterns.gsi1sk,
      })
    }

    if (model.keyPatterns.gsi2pk) {
      indexes.push({
        name: 'GSI2',
        pkPattern: model.keyPatterns.gsi2pk,
        skPattern: model.keyPatterns.gsi2sk,
      })
    }

    return indexes.length > 0 ? indexes : undefined
  }

  private buildEntitySchema(model: ParsedModelDefinition): SingleTableEntity['schema'] {
    const schema: NonNullable<SingleTableEntity['schema']> = {}

    for (const attr of model.attributes) {
      let type: 'string' | 'number' | 'boolean' | 'list' | 'map' | 'set' = 'string'

      switch (attr.dynamoDbType) {
        case 'N':
          type = 'number'
          break
        case 'BOOL':
          type = 'boolean'
          break
        case 'L':
          type = 'list'
          break
        case 'M':
          type = 'map'
          break
        case 'SS':
        case 'NS':
        case 'BS':
          type = 'set'
          break
        default:
          type = 'string'
      }

      schema[attr.name] = {
        type,
        required: attr.required,
      }
    }

    return schema
  }

  private toEntityMapping(model: ParsedModelDefinition): SingleTableEntityMapping {
    return {
      entityType: model.entityType,
      pkPattern: model.keyPatterns.pk,
      skPattern: model.keyPatterns.sk,
      gsiMappings: this.buildGSIMappings(model),
    }
  }

  private buildGSIMappings(model: ParsedModelDefinition): SingleTableEntityMapping['gsiMappings'] {
    const mappings: NonNullable<SingleTableEntityMapping['gsiMappings']> = []

    if (model.keyPatterns.gsi1pk) {
      mappings.push({
        indexName: 'GSI1',
        pkPattern: model.keyPatterns.gsi1pk,
        skPattern: model.keyPatterns.gsi1sk,
      })
    }

    if (model.keyPatterns.gsi2pk) {
      mappings.push({
        indexName: 'GSI2',
        pkPattern: model.keyPatterns.gsi2pk,
        skPattern: model.keyPatterns.gsi2sk,
      })
    }

    return mappings.length > 0 ? mappings : undefined
  }

  private buildGSIConfig(): SingleTableConfig['indexes'] {
    const indexes: NonNullable<SingleTableConfig['indexes']> = []
    const gsi = this.config.gsiConfig

    if (gsi?.gsi1pk) {
      indexes.push({
        name: 'GSI1',
        pkAttribute: gsi.gsi1pk,
        skAttribute: gsi.gsi1sk,
      })
    }
    else {
      // Default GSI1
      indexes.push({
        name: 'GSI1',
        pkAttribute: 'gsi1pk',
        skAttribute: 'gsi1sk',
      })
    }

    if (gsi?.gsi2pk) {
      indexes.push({
        name: 'GSI2',
        pkAttribute: gsi.gsi2pk,
        skAttribute: gsi.gsi2sk,
      })
    }
    else {
      // Default GSI2
      indexes.push({
        name: 'GSI2',
        pkAttribute: 'gsi2pk',
        skAttribute: 'gsi2sk',
      })
    }

    if (gsi?.gsi3pk) {
      indexes.push({
        name: 'GSI3',
        pkAttribute: gsi.gsi3pk,
        skAttribute: gsi.gsi3sk,
      })
    }

    return indexes
  }
}

/**
 * Create a DynamoDB Tooling adapter
 */
export function createDynamoDBToolingAdapter(config: DynamoDBToolingConfig): DynamoDBToolingAdapter {
  return new DynamoDBToolingAdapter(config)
}

/**
 * Helper to transform Stacks model to DynamoDB single table entity
 * Can be used standalone without the full adapter
 */
export function stacksModelToEntity(
  model: StacksModelInput,
  delimiter: string = '#',
): SingleTableEntity {
  const entityType = model.name.toUpperCase()
  const primaryKey = model.primaryKey ?? 'id'

  return {
    name: model.name,
    pkPattern: `${entityType}${delimiter}\${${primaryKey}}`,
    skPattern: `${entityType}${delimiter}\${${primaryKey}}`,
    keyFields: [primaryKey],
  }
}

/**
 * Generate access patterns for a model
 * Useful for documentation and planning
 */
export function generateAccessPatterns(model: ParsedModelDefinition): {
  name: string
  description: string
  operation: 'get' | 'query' | 'scan'
  index: string
  keyCondition: string
  efficient: boolean
}[] {
  const patterns: ReturnType<typeof generateAccessPatterns> = []

  // Get by ID
  patterns.push({
    name: `Get ${model.name} by ID`,
    description: `Retrieve a single ${model.name} by its primary key`,
    operation: 'get',
    index: 'main',
    keyCondition: `pk = ${model.entityType}#\${id} AND sk = ${model.entityType}#\${id}`,
    efficient: true,
  })

  // List all (scan - inefficient)
  patterns.push({
    name: `List all ${model.name}s`,
    description: `Retrieve all ${model.name} entities (requires scan with filter)`,
    operation: 'scan',
    index: 'scan',
    keyCondition: `_et = ${model.name}`,
    efficient: false,
  })

  // Relationship patterns
  for (const rel of model.relationships) {
    if (rel.type === 'belongsTo') {
      patterns.push({
        name: `Get ${model.name}s by ${rel.relatedModel}`,
        description: `Query all ${model.name} items belonging to a ${rel.relatedModel}`,
        operation: 'query',
        index: 'GSI1',
        keyCondition: `gsi1pk = ${rel.relatedModel.toUpperCase()}#\${id}`,
        efficient: true,
      })
    }

    if (rel.type === 'hasMany') {
      patterns.push({
        name: `Get ${rel.relatedModel}s for ${model.name}`,
        description: `Query all ${rel.relatedModel} items belonging to a ${model.name}`,
        operation: 'query',
        index: 'main',
        keyCondition: `pk = ${model.entityType}#\${id} AND sk begins_with ${rel.relatedModel.toUpperCase()}#`,
        efficient: true,
      })
    }
  }

  return patterns
}
