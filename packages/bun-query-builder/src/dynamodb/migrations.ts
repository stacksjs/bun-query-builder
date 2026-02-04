/**
 * DynamoDB Schema Migrations
 *
 * Provides schema migration support for DynamoDB tables, including:
 * - Auto-create tables based on model definitions
 * - Schema comparison and diff generation
 * - GSI/LSI management
 * - TTL configuration
 *
 * @example
 * ```typescript
 * import { DynamoDBMigrator } from 'bun-query-builder/dynamodb'
 *
 * const migrator = new DynamoDBMigrator({ region: 'us-east-1' })
 *
 * // Migrate from model definitions
 * await migrator.migrateModels([PageView, Session, CustomEvent])
 *
 * // Or migrate a single table definition
 * await migrator.migrate(tableDefinition)
 * ```
 */

import type { DynamoDBTableDefinition, DynamoDBGlobalSecondaryIndex, DynamoDBAttributeDefinition } from '../drivers/dynamodb'

// ============================================================================
// Types
// ============================================================================

/**
 * Migration operation types
 */
export type DynamoDBMigrationOperationType =
  | 'CREATE_TABLE'
  | 'DELETE_TABLE'
  | 'ADD_GSI'
  | 'DELETE_GSI'
  | 'UPDATE_GSI_THROUGHPUT'
  | 'UPDATE_TTL'
  | 'UPDATE_BILLING_MODE'
  | 'UPDATE_THROUGHPUT'
  | 'ENABLE_STREAM'
  | 'DISABLE_STREAM'

/**
 * Individual migration operation
 */
export interface DynamoDBMigrationOperation {
  type: DynamoDBMigrationOperationType
  tableName: string
  details: Record<string, any>
}

/**
 * Migration plan containing all operations to execute
 */
export interface DynamoDBMigrationPlan {
  tableName: string
  operations: DynamoDBMigrationOperation[]
  timestamp: string
  hash: string
}

/**
 * State of a migrated table stored in the migrations table
 */
export interface DynamoDBMigrationState {
  tableName: string
  hash: string
  definition: DynamoDBTableDefinition
  appliedAt: string
  version: number
}

/**
 * Model definition for extracting DynamoDB schema
 */
export interface DynamoDBModelSchema {
  tableName: string
  pkAttribute: string
  skAttribute: string
  pkPrefix: string
  skPrefix: string
  entityTypeAttribute: string
  timestamps: boolean
  ttlAttribute?: string
  gsis?: DynamoDBGSIDefinition[]
  lsis?: DynamoDBLSIDefinition[]
  billingMode?: 'PAY_PER_REQUEST' | 'PROVISIONED'
  provisionedThroughput?: {
    readCapacityUnits: number
    writeCapacityUnits: number
  }
  streamEnabled?: boolean
  streamViewType?: 'KEYS_ONLY' | 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES'
}

/**
 * GSI definition for model schema
 */
export interface DynamoDBGSIDefinition {
  indexName: string
  pkAttribute: string
  skAttribute?: string
  projection?: 'ALL' | 'KEYS_ONLY' | string[]
  provisionedThroughput?: {
    readCapacityUnits: number
    writeCapacityUnits: number
  }
}

/**
 * LSI definition for model schema
 */
export interface DynamoDBLSIDefinition {
  indexName: string
  skAttribute: string
  projection?: 'ALL' | 'KEYS_ONLY' | string[]
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a hash of a table definition for comparison
 */
export function hashTableDefinition(definition: DynamoDBTableDefinition): string {
  const normalized = JSON.stringify({
    tableName: definition.tableName,
    keySchema: definition.keySchema,
    attributeDefinitions: [...(definition.attributeDefinitions || [])].sort((a, b) => a.name.localeCompare(b.name)),
    globalSecondaryIndexes: [...(definition.globalSecondaryIndexes || [])].sort((a, b) => a.indexName.localeCompare(b.indexName)),
    localSecondaryIndexes: [...(definition.localSecondaryIndexes || [])].sort((a, b) => a.indexName.localeCompare(b.indexName)),
    billingMode: definition.billingMode,
    ttlAttribute: definition.ttlAttribute,
    streamSpecification: definition.streamSpecification,
  })

  // Simple hash function
  let hash = 0
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

/**
 * Extract DynamoDB table definition from a Model class
 */
export function extractTableDefinition(model: any): DynamoDBTableDefinition {
  const schema = extractModelSchema(model)
  return convertSchemaToDefinition(schema)
}

/**
 * Extract model schema from a Model class
 */
export function extractModelSchema(ModelClass: any): DynamoDBModelSchema {
  return {
    tableName: ModelClass.tableName || '',
    pkAttribute: ModelClass.pkAttribute || 'pk',
    skAttribute: ModelClass.skAttribute || 'sk',
    pkPrefix: ModelClass.pkPrefix || '',
    skPrefix: ModelClass.skPrefix || 'METADATA',
    entityTypeAttribute: ModelClass.entityTypeAttribute || '_et',
    timestamps: ModelClass.timestamps !== false,
    ttlAttribute: ModelClass.ttlAttribute,
    gsis: ModelClass.gsis,
    lsis: ModelClass.lsis,
    billingMode: ModelClass.billingMode || 'PAY_PER_REQUEST',
    provisionedThroughput: ModelClass.provisionedThroughput,
    streamEnabled: ModelClass.streamEnabled,
    streamViewType: ModelClass.streamViewType,
  }
}

/**
 * Convert model schema to DynamoDB table definition
 */
export function convertSchemaToDefinition(schema: DynamoDBModelSchema): DynamoDBTableDefinition {
  const attributeDefinitions: DynamoDBAttributeDefinition[] = [
    { name: schema.pkAttribute, type: 'S' },
    { name: schema.skAttribute, type: 'S' },
  ]

  // Add GSI key attributes
  const gsis: DynamoDBGlobalSecondaryIndex[] = []
  if (schema.gsis) {
    for (const gsi of schema.gsis) {
      // Add pk attribute if not already defined
      if (!attributeDefinitions.some(a => a.name === gsi.pkAttribute)) {
        attributeDefinitions.push({ name: gsi.pkAttribute, type: 'S' })
      }
      // Add sk attribute if defined and not already defined
      if (gsi.skAttribute && !attributeDefinitions.some(a => a.name === gsi.skAttribute)) {
        attributeDefinitions.push({ name: gsi.skAttribute, type: 'S' })
      }

      gsis.push({
        indexName: gsi.indexName,
        keySchema: {
          partitionKey: gsi.pkAttribute,
          sortKey: gsi.skAttribute,
        },
        projection: {
          type: Array.isArray(gsi.projection) ? 'INCLUDE' : (gsi.projection || 'ALL'),
          nonKeyAttributes: Array.isArray(gsi.projection) ? gsi.projection : undefined,
        },
        provisionedThroughput: gsi.provisionedThroughput,
      })
    }
  }

  return {
    tableName: schema.tableName,
    keySchema: {
      partitionKey: schema.pkAttribute,
      sortKey: schema.skAttribute,
    },
    attributeDefinitions,
    globalSecondaryIndexes: gsis.length > 0 ? gsis : undefined,
    billingMode: schema.billingMode,
    provisionedThroughput: schema.provisionedThroughput,
    ttlAttribute: schema.ttlAttribute,
    streamSpecification: schema.streamEnabled
      ? { enabled: true, viewType: schema.streamViewType || 'NEW_AND_OLD_IMAGES' }
      : undefined,
  }
}

// ============================================================================
// Migration Plan Builder
// ============================================================================

/**
 * Build a migration plan by comparing current and target table definitions
 */
export function buildMigrationPlan(
  current: DynamoDBTableDefinition | null,
  target: DynamoDBTableDefinition,
): DynamoDBMigrationPlan {
  const operations: DynamoDBMigrationOperation[] = []
  const tableName = target.tableName

  if (!current) {
    // Table doesn't exist - create it
    operations.push({
      type: 'CREATE_TABLE',
      tableName,
      details: { definition: target },
    })
  } else {
    // Compare and generate diff operations

    // Check for key schema changes (requires table recreation)
    const pkChanged = current.keySchema.partitionKey !== target.keySchema.partitionKey
    const skChanged = current.keySchema.sortKey !== target.keySchema.sortKey

    if (pkChanged || skChanged) {
      console.warn(`[Migration] Table ${tableName}: Key schema changes require table recreation. ` +
        `Current: pk=${current.keySchema.partitionKey}, sk=${current.keySchema.sortKey}. ` +
        `Target: pk=${target.keySchema.partitionKey}, sk=${target.keySchema.sortKey}. ` +
        `This operation is not supported automatically.`)
    }

    // Compare GSIs
    const currentGSIs = current.globalSecondaryIndexes || []
    const targetGSIs = target.globalSecondaryIndexes || []

    const currentGSINames = new Set(currentGSIs.map(g => g.indexName))
    const targetGSINames = new Set(targetGSIs.map(g => g.indexName))

    // GSIs to add
    for (const gsi of targetGSIs) {
      if (!currentGSINames.has(gsi.indexName)) {
        operations.push({
          type: 'ADD_GSI',
          tableName,
          details: { gsi },
        })
      }
    }

    // GSIs to remove
    for (const gsi of currentGSIs) {
      if (!targetGSINames.has(gsi.indexName)) {
        operations.push({
          type: 'DELETE_GSI',
          tableName,
          details: { indexName: gsi.indexName },
        })
      }
    }

    // Check billing mode changes
    if (current.billingMode !== target.billingMode && target.billingMode) {
      operations.push({
        type: 'UPDATE_BILLING_MODE',
        tableName,
        details: {
          billingMode: target.billingMode,
          provisionedThroughput: target.provisionedThroughput,
        },
      })
    }

    // Check TTL changes
    if (current.ttlAttribute !== target.ttlAttribute) {
      operations.push({
        type: 'UPDATE_TTL',
        tableName,
        details: {
          ttlAttribute: target.ttlAttribute || null,
          enabled: !!target.ttlAttribute,
        },
      })
    }

    // Check stream changes
    const currentStreamEnabled = current.streamSpecification?.enabled
    const targetStreamEnabled = target.streamSpecification?.enabled

    if (currentStreamEnabled !== targetStreamEnabled) {
      if (targetStreamEnabled) {
        operations.push({
          type: 'ENABLE_STREAM',
          tableName,
          details: {
            viewType: target.streamSpecification?.viewType || 'NEW_AND_OLD_IMAGES',
          },
        })
      } else {
        operations.push({
          type: 'DISABLE_STREAM',
          tableName,
          details: {},
        })
      }
    }
  }

  return {
    tableName,
    operations,
    timestamp: new Date().toISOString(),
    hash: hashTableDefinition(target),
  }
}

/**
 * Check if two table definitions are equivalent
 */
export function isDefinitionEqual(a: DynamoDBTableDefinition, b: DynamoDBTableDefinition): boolean {
  return hashTableDefinition(a) === hashTableDefinition(b)
}

// ============================================================================
// Exports
// ============================================================================

export type {
  DynamoDBTableDefinition,
  DynamoDBGlobalSecondaryIndex,
  DynamoDBAttributeDefinition,
}
