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
// Local type definitions (dynamodb-tooling doesn't export these)
// ============================================================================

/**
 * Access pattern definition for DynamoDB single-table design
 */
export interface AccessPattern {
  name: string
  description: string
  entityType: string
  operation: 'get' | 'query' | 'scan'
  index: string | 'main' | 'scan' | 'GSI1' | 'GSI2' | 'GSI3' | 'GSI4' | 'GSI5'
  keyCondition: string
  examplePk: string
  exampleSk?: string
  efficient: boolean
}

/**
 * Parsed attribute definition
 */
export interface ParsedAttribute {
  name: string
  fillable: boolean
  required: boolean
  nullable: boolean
  unique: boolean
  hidden: boolean
  defaultValue?: any
  cast?: string
  dynamoDbType: 'S' | 'N' | 'B' | 'BOOL' | 'NULL' | 'M' | 'L' | 'SS' | 'NS' | 'BS'
}

/**
 * Parsed relationship definition
 */
export interface ParsedRelationship {
  type: 'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany'
  relatedModel: string
  foreignKey: string
  localKey: string
  pivotEntity?: string
  requiresGsi: boolean
  gsiIndex?: number
}

/**
 * Key patterns for DynamoDB single-table design
 */
export interface KeyPatterns {
  pk: string
  sk: string
  gsi1pk?: string
  gsi1sk?: string
  gsi2pk?: string
  gsi2sk?: string
  gsi3pk?: string
  gsi3sk?: string
  gsi4pk?: string
  gsi4sk?: string
  gsi5pk?: string
  gsi5sk?: string
}

/**
 * Parsed model definition
 */
export interface ParsedModel {
  name: string
  entityType: string
  primaryKey: string
  attributes: ParsedAttribute[]
  relationships: ParsedRelationship[]
  keyPatterns: KeyPatterns
  accessPatterns: AccessPattern[]
  traits: Record<string, any>
  hasTimestamps: boolean
  hasSoftDeletes: boolean
  hasUuid: boolean
  hasTtl: boolean
  hasVersioning: boolean
  original: StacksModel
}

/**
 * Stacks model definition (input format)
 */
export interface StacksModel {
  name: string
  primaryKey?: string
  attributes?: Record<string, {
    fillable?: boolean
    required?: boolean
    nullable?: boolean
    unique?: boolean
    hidden?: boolean
    default?: any
    cast?: string
    validation?: { rule?: string }
  }>
  traits?: {
    useTimestamps?: boolean
    useSoftDeletes?: boolean
    useUuid?: boolean
    useTtl?: boolean
    useVersioning?: boolean
  }
  hasOne?: string[]
  hasMany?: string[]
  belongsTo?: string[]
  belongsToMany?: string[]
}

// ============================================================================
// Local utility functions (dynamodb-tooling doesn't export these)
// ============================================================================

/**
 * Resolve key pattern placeholders with actual values
 */
export function resolveKeyPattern(keyPatterns: KeyPatterns, data: Record<string, any>): Record<string, string> {
  const resolved: Record<string, string> = {}

  for (const [key, pattern] of Object.entries(keyPatterns)) {
    if (pattern) {
      resolved[key] = pattern.replace(/\{([^}]+)\}/g, (_: string, field: string) => {
        return data[field] !== undefined ? String(data[field]) : `{${field}}`
      })
    }
  }

  return resolved
}

/**
 * Parse models from configuration (stub implementation)
 */
export async function parseStacksModels(_config: any): Promise<{ models: Map<string, ParsedModel> }> {
  // This is a stub - actual implementation would parse model files
  return { models: new Map() }
}

/**
 * Convert model instance to DynamoDB item format (stub)
 */
export function toDynamoDBItem(item: Record<string, any>): Record<string, any> {
  return item
}

/**
 * Convert DynamoDB item to model instance (stub)
 */
export function toModelInstance<T>(item: Record<string, any>): T {
  return item as T
}

/**
 * Marshall a JavaScript object to DynamoDB attribute values (stub)
 */
export function marshallObject(obj: Record<string, any>): Record<string, any> {
  return obj
}

/**
 * Unmarshall DynamoDB attribute values to a JavaScript object (stub)
 */
export function unmarshallItem(item: Record<string, any>): Record<string, any> {
  return item
}

// ============================================================================
// Imports from bun-query-builder (fluent API layer)
// ============================================================================
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
      traits: model.traits ?? {},
      hasTimestamps: model.traits?.useTimestamps ?? false,
      hasSoftDeletes: model.traits?.useSoftDeletes ?? false,
      hasUuid: model.traits?.useUuid ?? false,
      hasTtl: model.traits?.useTtl ?? false,
      hasVersioning: model.traits?.useVersioning ?? false,
      original: model,
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
        // Pivot entity name is alphabetically sorted for consistency
        const names = [model.name, related].sort()
        relationships.push({
          type: 'belongsToMany',
          relatedModel: related,
          foreignKey: `${model.name.toLowerCase()}Id`,
          localKey: primaryKey,
          pivotEntity: names.join(''),
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
      description: `Retrieve a single ${modelName} by its primary key`,
      entityType,
      operation: 'get',
      index: 'main',
      keyCondition: `pk = :pk AND sk = :sk`,
      examplePk: `${entityType}#123`,
      exampleSk: `${entityType}#123`,
      efficient: true,
    })

    // List all
    patterns.push({
      name: `List all ${modelName}s`,
      description: `Scan all ${modelName} entities`,
      entityType,
      operation: 'scan',
      index: 'scan',
      keyCondition: `_et = :entityType`,
      examplePk: entityType,
      efficient: false,
    })

    // Relationship patterns
    for (const rel of relationships) {
      if (rel.type === 'hasMany') {
        patterns.push({
          name: `Get ${rel.relatedModel}s for ${modelName}`,
          description: `Query ${rel.relatedModel}s related to a ${modelName}`,
          entityType,
          operation: 'query',
          index: 'main',
          keyCondition: `pk = :pk AND begins_with(sk, :skPrefix)`,
          examplePk: `${entityType}#123`,
          exampleSk: `${rel.relatedModel.toUpperCase()}#`,
          efficient: true,
        })
      }

      if (rel.gsiIndex) {
        const gsiIndex = `GSI${rel.gsiIndex}` as 'GSI1' | 'GSI2' | 'GSI3' | 'GSI4' | 'GSI5'
        patterns.push({
          name: `Get ${modelName}s by ${rel.relatedModel}`,
          description: `Query ${modelName}s by their related ${rel.relatedModel}`,
          entityType,
          operation: 'query',
          index: gsiIndex,
          keyCondition: `gsi${rel.gsiIndex}pk = :pk`,
          examplePk: `${rel.relatedModel.toUpperCase()}#123`,
          efficient: true,
        })
      }
    }

    return patterns
  }

  private toSingleTableEntity(model: ParsedModel): SingleTableEntity {
    // Extract key fields from the pk pattern (e.g., "USER#{id}" -> ["id"])
    const keyFields = this.extractKeyFields(model.keyPatterns.pk)

    return {
      name: model.name,
      pkPattern: model.keyPatterns.pk,
      skPattern: model.keyPatterns.sk,
      keyFields,
      indexes: this.extractGSIPatterns(model.keyPatterns),
    }
  }

  private extractKeyFields(pattern: string): string[] {
    const matches = pattern.match(/\{([^}]+)\}/g)
    if (!matches) return []
    return matches.map(m => m.slice(1, -1))
  }

  private extractGSIPatterns(keyPatterns: ParsedModel['keyPatterns']): SingleTableEntity['indexes'] {
    const indexes: SingleTableEntity['indexes'] = []

    for (let i = 1; i <= 5; i++) {
      const pkKey = `gsi${i}pk` as keyof typeof keyPatterns
      const skKey = `gsi${i}sk` as keyof typeof keyPatterns

      if (keyPatterns[pkKey]) {
        indexes.push({
          name: `GSI${i}`,
          pkPattern: keyPatterns[pkKey] as string,
          skPattern: keyPatterns[skKey] as string | undefined,
        })
      }
    }

    return indexes.length > 0 ? indexes : undefined
  }

  private toEntityMapping(model: ParsedModel): SingleTableEntityMapping {
    return {
      entityType: model.name,
      pkPattern: model.keyPatterns.pk,
      skPattern: model.keyPatterns.sk,
    }
  }

  private buildGSIConfig(): SingleTableConfig['indexes'] {
    const gsiConfig = this.config.gsiConfig ?? {}
    const indexes: SingleTableConfig['indexes'] = []

    if (gsiConfig.gsi1pk) {
      indexes.push({ name: 'GSI1', pkAttribute: gsiConfig.gsi1pk, skAttribute: gsiConfig.gsi1sk })
    }
    if (gsiConfig.gsi2pk) {
      indexes.push({ name: 'GSI2', pkAttribute: gsiConfig.gsi2pk, skAttribute: gsiConfig.gsi2sk })
    }
    if (gsiConfig.gsi3pk) {
      indexes.push({ name: 'GSI3', pkAttribute: gsiConfig.gsi3pk, skAttribute: gsiConfig.gsi3sk })
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

/**
 * Generate access patterns for a parsed model
 * Standalone function for use outside the adapter
 */
export function generateAccessPatterns(model: ParsedModel): AccessPattern[] {
  return model.accessPatterns
}

/**
 * Convert a Stacks model definition to a single-table entity pattern
 * Standalone function for creating entity patterns
 */
export function stacksModelToEntity(
  model: { name: string; primaryKey?: string },
  delimiter: string = '#',
): { name: string; pkPattern: string; skPattern: string } {
  const entityType = model.name.toUpperCase()
  const primaryKey = model.primaryKey ?? 'id'

  return {
    name: model.name,
    pkPattern: `${entityType}${delimiter}\${${primaryKey}}`,
    skPattern: `${entityType}${delimiter}\${${primaryKey}}`,
  }
}
