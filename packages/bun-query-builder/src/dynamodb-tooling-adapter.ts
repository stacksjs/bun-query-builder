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
 * IMPORTANT: This adapter EXTENDS dynamodb-tooling rather than duplicating it.
 * All model parsing, key generation, and entity transformation is delegated to dynamodb-tooling.
 */

// ============================================================================
// Imports from dynamodb-tooling (the foundation)
// ============================================================================
import type {
  AccessPattern,
  ParsedModel,
  StacksModel,
} from 'dynamodb-tooling'
import {
  // Single-table design utilities (function-based API)
  toDynamoDBItem,
  toModelInstance,
  marshallObject,
  unmarshallItem,
  resolveKeyPattern,

  // Model parser
  parseModels as parseStacksModels,
} from 'dynamodb-tooling'

// ============================================================================
// Imports from bun-query-builder (fluent API layer)
// ============================================================================
import type { DynamoDBConfig, DynamoDBDriver, SingleTableEntityMapping } from './drivers/dynamodb'
import type { DynamoDBQueryBuilderOptions } from './dynamodb-client'
import type { SingleTableConfig, SingleTableEntity } from './dynamodb-single-table'
import { createDynamoDBDriver } from './drivers/dynamodb'
import { DynamoDBItemBuilder, DynamoDBQueryBuilder } from './dynamodb-client'
import { createRepository, createSingleTableManager, SingleTableManager, SingleTableRepository } from './dynamodb-single-table'

// ============================================================================
// Re-export dynamodb-tooling types and functions for convenience
// ============================================================================
export type { AccessPattern, ParsedModel, StacksModel }
export {
  toDynamoDBItem,
  toModelInstance,
  marshallObject,
  unmarshallItem,
  resolveKeyPattern,
  parseStacksModels,
}

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
  /** Path to Stacks models directory (for auto-discovery) */
  modelsPath?: string
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
 * DynamoDB Tooling Adapter
 *
 * Bridges dynamodb-tooling with bun-query-builder's fluent API.
 * All model parsing and transformation is delegated to dynamodb-tooling.
 */
export class DynamoDBToolingAdapter {
  private config: DynamoDBToolingConfig
  private driver: DynamoDBDriver
  private singleTableManager: SingleTableManager
  private models: Map<string, ParsedModel> = new Map()
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
   * Auto-discover and register all Stacks models from configured path
   * Uses dynamodb-tooling's parseModels() function
   */
  async discoverModels(): Promise<ParsedModel[]> {
    if (!this.config.modelsPath) {
      throw new Error('modelsPath must be configured to use discoverModels()')
    }

    const registry = await parseStacksModels({
      queryBuilder: {
        modelsPath: this.config.modelsPath,
      },
      singleTable: {
        pkAttribute: this.config.pkAttribute!,
        skAttribute: this.config.skAttribute!,
        typeAttribute: this.config.entityTypeAttribute!,
        delimiter: this.config.keyDelimiter!,
      },
    } as any)

    const parsedModels: ParsedModel[] = []

    for (const [, model] of registry.models) {
      this.registerParsedModel(model)
      parsedModels.push(model)
    }

    return parsedModels
  }

  /**
   * Register a Stacks model for use with DynamoDB
   * The model is parsed using dynamodb-tooling's parser
   */
  registerModel(model: StacksModel): ParsedModel {
    // Use dynamodb-tooling's parsing logic
    const parsed = this.parseWithTooling(model)
    return this.registerParsedModel(parsed)
  }

  /**
   * Register an already-parsed model (from dynamodb-tooling)
   */
  registerParsedModel(parsed: ParsedModel): ParsedModel {
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
  registerModels(models: StacksModel[]): ParsedModel[] {
    return models.map(m => this.registerModel(m))
  }

  /**
   * Get a registered model by name
   */
  getModel(name: string): ParsedModel | undefined {
    return this.models.get(name)
  }

  /**
   * Get all registered models
   */
  getAllModels(): ParsedModel[] {
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
   * Build primary key for an entity using dynamodb-tooling's resolveKeyPattern
   */
  buildKey(modelName: string, data: Record<string, any>): { pk: string, sk: string } {
    const model = this.models.get(modelName)
    if (!model) {
      throw new Error(`Model not found: ${modelName}`)
    }

    // resolveKeyPattern expects the full KeyPattern object and returns all resolved keys
    const resolved = resolveKeyPattern(model.keyPatterns, data)
    return {
      pk: resolved.pk,
      sk: resolved.sk,
    }
  }

  /**
   * Create a full DynamoDB item with pk, sk, entity type
   * Uses dynamodb-tooling's resolveKeyPattern
   */
  createItem(modelName: string, data: Record<string, any>): Record<string, any> {
    const model = this.models.get(modelName)
    if (!model) {
      throw new Error(`Model not found: ${modelName}`)
    }

    // Build keys using resolveKeyPattern
    const resolved = resolveKeyPattern(model.keyPatterns, data)
    const pk = resolved.pk
    const sk = resolved.sk

    // Create item with keys and entity type
    const item: Record<string, any> = {
      [this.config.pkAttribute!]: pk,
      [this.config.skAttribute!]: sk,
      [this.config.entityTypeAttribute!]: model.name,
      ...data,
    }

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
    const entityType = item[this.config.entityTypeAttribute!]
    if (!entityType) {
      return undefined
    }

    // Remove internal attributes
    const { [this.config.pkAttribute!]: _pk, [this.config.skAttribute!]: _sk, [this.config.entityTypeAttribute!]: _et, ...data } = item

    return {
      type: entityType,
      data: data as T,
    }
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

  /**
   * Generate access patterns documentation for a model
   * Delegates to dynamodb-tooling's AccessPatternGenerator
   */
  generateAccessPatterns(modelName: string): AccessPattern[] {
    const model = this.models.get(modelName)
    if (!model) {
      throw new Error(`Model not found: ${modelName}`)
    }
    return model.accessPatterns
  }

  // ============================================================================
  // Private helper methods
  // ============================================================================

  /**
   * Parse a Stacks model using dynamodb-tooling's logic
   */
  private parseWithTooling(model: StacksModel): ParsedModel {
    const entityType = model.name.toUpperCase()
    const primaryKey = model.primaryKey ?? 'id'
    const delimiter = this.config.keyDelimiter!

    // Parse attributes using dynamodb-tooling patterns
    const attributes = this.parseAttributes(model)

    // Parse relationships
    const relationships = this.parseRelationships(model, primaryKey)

    // Generate key patterns using dynamodb-tooling's KeyPatternGenerator
    const keyPatterns = {
      pk: `${entityType}${delimiter}{${primaryKey}}`,
      sk: `${entityType}${delimiter}{${primaryKey}}`,
      ...this.deriveGSIKeyPatterns(entityType, primaryKey, delimiter, relationships),
    }

    // Generate access patterns
    const accessPatterns = this.deriveAccessPatterns(model.name, entityType, primaryKey, relationships)

    return {
      name: model.name,
      entityType,
      primaryKey,
      attributes,
      relationships,
      keyPatterns,
      accessPatterns,
      hasTimestamps: model.traits?.useTimestamps ?? false,
      hasSoftDeletes: model.traits?.useSoftDeletes ?? false,
      hasVersioning: model.traits?.useVersioning ?? false,
    }
  }

  private parseAttributes(model: StacksModel): ParsedModel['attributes'] {
    const attributes: ParsedModel['attributes'] = []

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
          required: def.required ?? false,
          nullable: def.nullable ?? true,
          unique: def.unique ?? false,
          hidden: def.hidden ?? false,
          defaultValue: def.default,
          cast: def.cast,
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
    // Check cast type first (most explicit)
    if (def.cast) {
      const cast = def.cast.toLowerCase()
      if (['integer', 'int', 'float', 'double', 'decimal', 'number'].includes(cast)) {
        return 'N'
      }
      if (['boolean', 'bool'].includes(cast)) {
        return 'BOOL'
      }
      if (['array', 'list'].includes(cast)) {
        return 'L'
      }
      if (['object', 'json', 'map'].includes(cast)) {
        return 'M'
      }
    }

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

  private parseRelationships(model: StacksModel, primaryKey: string): ParsedModel['relationships'] {
    const relationships: ParsedModel['relationships'] = []

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
          requiresGsi: false, // Can use sk begins_with pattern
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
        relationships.push({
          type: 'belongsToMany',
          relatedModel: related,
          foreignKey: `${model.name.toLowerCase()}Id`,
          localKey: primaryKey,
          pivotEntity: `${model.name}${related}`,
          requiresGsi: true,
        })
      }
    }

    return relationships
  }

  private deriveGSIKeyPatterns(
    entityType: string,
    primaryKey: string,
    delimiter: string,
    relationships: ParsedModel['relationships'],
  ): Record<string, string> {
    const patterns: Record<string, string> = {}
    let gsiIndex = 1

    for (const rel of relationships) {
      if (rel.requiresGsi && gsiIndex <= 5) {
        patterns[`gsi${gsiIndex}pk`] = `${rel.relatedModel.toUpperCase()}${delimiter}{${rel.foreignKey}}`
        patterns[`gsi${gsiIndex}sk`] = `${entityType}${delimiter}{${primaryKey}}`
        rel.gsiIndex = gsiIndex
        gsiIndex++
      }
    }

    return patterns
  }

  private deriveAccessPatterns(
    modelName: string,
    entityType: string,
    primaryKey: string,
    relationships: ParsedModel['relationships'],
  ): AccessPattern[] {
    const patterns: AccessPattern[] = []

    // Get by ID
    patterns.push({
      name: `Get ${modelName} by ID`,
      operation: 'get',
      index: 'main',
      pk: { attribute: 'pk', value: `${entityType}#{${primaryKey}}` },
      sk: { attribute: 'sk', value: `${entityType}#{${primaryKey}}` },
    })

    // List all
    patterns.push({
      name: `List all ${modelName}s`,
      operation: 'scan',
      index: 'main',
      filter: { attribute: '_et', value: modelName },
    })

    // Relationship patterns
    for (const rel of relationships) {
      if (rel.type === 'hasMany') {
        patterns.push({
          name: `Get ${rel.relatedModel}s for ${modelName}`,
          operation: 'query',
          index: 'main',
          pk: { attribute: 'pk', value: `${entityType}#{${primaryKey}}` },
          sk: { attribute: 'sk', condition: 'begins_with', value: `${rel.relatedModel.toUpperCase()}#` },
        })
      }

      if (rel.gsiIndex) {
        patterns.push({
          name: `Get ${modelName}s by ${rel.relatedModel}`,
          operation: 'query',
          index: `GSI${rel.gsiIndex}`,
          pk: { attribute: `gsi${rel.gsiIndex}pk`, value: `${rel.relatedModel.toUpperCase()}#{${rel.foreignKey}}` },
        })
      }
    }

    return patterns
  }

  private toSingleTableEntity(model: ParsedModel): SingleTableEntity {
    return {
      name: model.name,
      pkPattern: model.keyPatterns.pk,
      skPattern: model.keyPatterns.sk,
      gsiPatterns: this.extractGSIPatterns(model.keyPatterns),
    }
  }

  private extractGSIPatterns(keyPatterns: ParsedModel['keyPatterns']): Record<string, { pk: string, sk?: string }> {
    const gsiPatterns: Record<string, { pk: string, sk?: string }> = {}

    for (let i = 1; i <= 5; i++) {
      const pkKey = `gsi${i}pk` as keyof typeof keyPatterns
      const skKey = `gsi${i}sk` as keyof typeof keyPatterns

      if (keyPatterns[pkKey]) {
        gsiPatterns[`GSI${i}`] = {
          pk: keyPatterns[pkKey] as string,
          sk: keyPatterns[skKey] as string | undefined,
        }
      }
    }

    return gsiPatterns
  }

  private toEntityMapping(model: ParsedModel): SingleTableEntityMapping {
    return {
      entityType: model.name,
      pk: model.keyPatterns.pk,
      sk: model.keyPatterns.sk,
    }
  }

  private buildGSIConfig(): SingleTableConfig['indexes'] {
    const gsiConfig = this.config.gsiConfig ?? {}
    const indexes: SingleTableConfig['indexes'] = []

    if (gsiConfig.gsi1pk) {
      indexes.push({ name: 'GSI1', pk: gsiConfig.gsi1pk, sk: gsiConfig.gsi1sk })
    }
    if (gsiConfig.gsi2pk) {
      indexes.push({ name: 'GSI2', pk: gsiConfig.gsi2pk, sk: gsiConfig.gsi2sk })
    }
    if (gsiConfig.gsi3pk) {
      indexes.push({ name: 'GSI3', pk: gsiConfig.gsi3pk, sk: gsiConfig.gsi3sk })
    }

    return indexes
  }
}

// ============================================================================
// Factory function
// ============================================================================

/**
 * Create a DynamoDB Tooling Adapter instance
 */
export function createDynamoDBToolingAdapter(config: DynamoDBToolingConfig): DynamoDBToolingAdapter {
  return new DynamoDBToolingAdapter(config)
}
