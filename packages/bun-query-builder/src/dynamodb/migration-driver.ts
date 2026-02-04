/**
 * DynamoDB Migration Driver
 *
 * Executes migration operations against DynamoDB tables using
 * the native DynamoDB client.
 *
 * @example
 * ```typescript
 * import { DynamoDBMigrationDriver } from 'bun-query-builder/dynamodb'
 *
 * const driver = new DynamoDBMigrationDriver({ region: 'us-east-1' })
 *
 * // Execute a migration plan
 * await driver.execute(migrationPlan)
 *
 * // Or migrate directly from models
 * await driver.migrateModels([PageView, Session])
 * ```
 */

import type { DynamoDBTableDefinition, DynamoDBGlobalSecondaryIndex } from '../drivers/dynamodb'
import type { DynamoDBMigrationPlan, DynamoDBMigrationOperation, DynamoDBMigrationState } from './migrations'
import { DynamoDBClient, createClient } from './client'
import type { DynamoDBClientConfig } from './client'
import { DynamoDBMigrationTracker } from './migration-tracker'
import { buildMigrationPlan, extractTableDefinition, hashTableDefinition } from './migrations'

// ============================================================================
// Types
// ============================================================================

export interface MigrationDriverConfig extends DynamoDBClientConfig {
  /** Dry run mode - log operations without executing */
  dryRun?: boolean
  /** Verbose logging */
  verbose?: boolean
}

export interface MigrationResult {
  tableName: string
  success: boolean
  operations: string[]
  error?: string
  state?: DynamoDBMigrationState
}

// ============================================================================
// Migration Driver
// ============================================================================

/**
 * Executes DynamoDB schema migrations
 */
export class DynamoDBMigrationDriver {
  private client: DynamoDBClient
  private tracker: DynamoDBMigrationTracker
  private config: MigrationDriverConfig

  constructor(config: MigrationDriverConfig) {
    this.config = config
    this.client = createClient({
      region: config.region,
      endpoint: config.endpoint,
      credentials: config.credentials,
    })
    this.tracker = new DynamoDBMigrationTracker(this.client)
  }

  /**
   * Execute a migration plan
   */
  async execute(plan: DynamoDBMigrationPlan): Promise<MigrationResult> {
    const result: MigrationResult = {
      tableName: plan.tableName,
      success: true,
      operations: [],
    }

    if (plan.operations.length === 0) {
      this.log(`[Migration] No changes needed for ${plan.tableName}`)
      return result
    }

    this.log(`[Migration] Executing ${plan.operations.length} operations for ${plan.tableName}`)

    try {
      for (const op of plan.operations) {
        await this.executeOperation(op)
        result.operations.push(op.type)
      }

      this.log(`[Migration] Successfully applied ${result.operations.length} operations to ${plan.tableName}`)
    } catch (error: any) {
      result.success = false
      result.error = error.message
      console.error(`[Migration] Failed to execute migration for ${plan.tableName}:`, error)
    }

    return result
  }

  /**
   * Execute a single migration operation
   */
  private async executeOperation(op: DynamoDBMigrationOperation): Promise<void> {
    this.log(`[Migration] Executing ${op.type} on ${op.tableName}`)

    if (this.config.dryRun) {
      this.log(`[Migration] DRY RUN: Would execute ${op.type}`, op.details)
      return
    }

    switch (op.type) {
      case 'CREATE_TABLE':
        await this.createTable(op.details.definition)
        break

      case 'DELETE_TABLE':
        await this.deleteTable(op.tableName)
        break

      case 'ADD_GSI':
        await this.addGSI(op.tableName, op.details.gsi)
        break

      case 'DELETE_GSI':
        await this.deleteGSI(op.tableName, op.details.indexName)
        break

      case 'UPDATE_TTL':
        await this.updateTTL(op.tableName, op.details.ttlAttribute, op.details.enabled)
        break

      case 'UPDATE_BILLING_MODE':
        await this.updateBillingMode(op.tableName, op.details.billingMode, op.details.provisionedThroughput)
        break

      case 'ENABLE_STREAM':
        await this.enableStream(op.tableName, op.details.viewType)
        break

      case 'DISABLE_STREAM':
        await this.disableStream(op.tableName)
        break

      default:
        throw new Error(`Unknown migration operation type: ${op.type}`)
    }
  }

  /**
   * Create a new DynamoDB table
   */
  private async createTable(definition: DynamoDBTableDefinition): Promise<void> {
    const input: any = {
      TableName: definition.tableName,
      KeySchema: [
        { AttributeName: definition.keySchema.partitionKey, KeyType: 'HASH' },
      ],
      AttributeDefinitions: definition.attributeDefinitions.map(a => ({
        AttributeName: a.name,
        AttributeType: a.type,
      })),
      BillingMode: definition.billingMode || 'PAY_PER_REQUEST',
    }

    // Add sort key if defined
    if (definition.keySchema.sortKey) {
      input.KeySchema.push({
        AttributeName: definition.keySchema.sortKey,
        KeyType: 'RANGE',
      })
    }

    // Add provisioned throughput if using provisioned mode
    if (definition.billingMode === 'PROVISIONED' && definition.provisionedThroughput) {
      input.ProvisionedThroughput = {
        ReadCapacityUnits: definition.provisionedThroughput.readCapacityUnits,
        WriteCapacityUnits: definition.provisionedThroughput.writeCapacityUnits,
      }
    }

    // Add GSIs
    if (definition.globalSecondaryIndexes && definition.globalSecondaryIndexes.length > 0) {
      input.GlobalSecondaryIndexes = definition.globalSecondaryIndexes.map(gsi => ({
        IndexName: gsi.indexName,
        KeySchema: [
          { AttributeName: gsi.keySchema.partitionKey, KeyType: 'HASH' },
          ...(gsi.keySchema.sortKey ? [{ AttributeName: gsi.keySchema.sortKey, KeyType: 'RANGE' }] : []),
        ],
        Projection: {
          ProjectionType: gsi.projection.type,
          ...(gsi.projection.nonKeyAttributes ? { NonKeyAttributes: gsi.projection.nonKeyAttributes } : {}),
        },
        ...(gsi.provisionedThroughput ? {
          ProvisionedThroughput: {
            ReadCapacityUnits: gsi.provisionedThroughput.readCapacityUnits,
            WriteCapacityUnits: gsi.provisionedThroughput.writeCapacityUnits,
          },
        } : {}),
      }))
    }

    // Add LSIs
    if (definition.localSecondaryIndexes && definition.localSecondaryIndexes.length > 0) {
      input.LocalSecondaryIndexes = definition.localSecondaryIndexes.map(lsi => ({
        IndexName: lsi.indexName,
        KeySchema: [
          { AttributeName: definition.keySchema.partitionKey, KeyType: 'HASH' },
          { AttributeName: lsi.sortKey, KeyType: 'RANGE' },
        ],
        Projection: {
          ProjectionType: lsi.projection.type,
          ...(lsi.projection.nonKeyAttributes ? { NonKeyAttributes: lsi.projection.nonKeyAttributes } : {}),
        },
      }))
    }

    // Add stream specification
    if (definition.streamSpecification?.enabled) {
      input.StreamSpecification = {
        StreamEnabled: true,
        StreamViewType: definition.streamSpecification.viewType || 'NEW_AND_OLD_IMAGES',
      }
    }

    this.log(`[Migration] Creating table: ${definition.tableName}`)
    await this.client.createTable(input)
    await this.waitForTableActive(definition.tableName)

    // Configure TTL if specified
    if (definition.ttlAttribute) {
      await this.updateTTL(definition.tableName, definition.ttlAttribute, true)
    }

    this.log(`[Migration] Table created: ${definition.tableName}`)
  }

  /**
   * Delete a DynamoDB table
   */
  private async deleteTable(tableName: string): Promise<void> {
    this.log(`[Migration] Deleting table: ${tableName}`)
    await this.client.deleteTable(tableName)
    this.log(`[Migration] Table deleted: ${tableName}`)
  }

  /**
   * Add a Global Secondary Index to a table
   */
  private async addGSI(tableName: string, gsi: DynamoDBGlobalSecondaryIndex): Promise<void> {
    this.log(`[Migration] Adding GSI ${gsi.indexName} to ${tableName}`)

    // First, we need to get current attribute definitions and add any new ones
    const tableInfo = await this.client.describeTable(tableName)
    const existingAttrs = new Set(
      tableInfo.Table?.AttributeDefinitions?.map((a: any) => a.AttributeName) || []
    )

    const newAttrs: any[] = []
    if (!existingAttrs.has(gsi.keySchema.partitionKey)) {
      newAttrs.push({ AttributeName: gsi.keySchema.partitionKey, AttributeType: 'S' })
    }
    if (gsi.keySchema.sortKey && !existingAttrs.has(gsi.keySchema.sortKey)) {
      newAttrs.push({ AttributeName: gsi.keySchema.sortKey, AttributeType: 'S' })
    }

    const input: any = {
      TableName: tableName,
      AttributeDefinitions: newAttrs.length > 0 ? newAttrs : undefined,
      GlobalSecondaryIndexUpdates: [{
        Create: {
          IndexName: gsi.indexName,
          KeySchema: [
            { AttributeName: gsi.keySchema.partitionKey, KeyType: 'HASH' },
            ...(gsi.keySchema.sortKey ? [{ AttributeName: gsi.keySchema.sortKey, KeyType: 'RANGE' }] : []),
          ],
          Projection: {
            ProjectionType: gsi.projection.type,
            ...(gsi.projection.nonKeyAttributes ? { NonKeyAttributes: gsi.projection.nonKeyAttributes } : {}),
          },
          ...(gsi.provisionedThroughput ? {
            ProvisionedThroughput: {
              ReadCapacityUnits: gsi.provisionedThroughput.readCapacityUnits,
              WriteCapacityUnits: gsi.provisionedThroughput.writeCapacityUnits,
            },
          } : {}),
        },
      }],
    }

    await this.executeUpdateTable(input)
    await this.waitForGSIActive(tableName, gsi.indexName)
    this.log(`[Migration] GSI ${gsi.indexName} added to ${tableName}`)
  }

  /**
   * Delete a Global Secondary Index from a table
   */
  private async deleteGSI(tableName: string, indexName: string): Promise<void> {
    this.log(`[Migration] Deleting GSI ${indexName} from ${tableName}`)

    const input = {
      TableName: tableName,
      GlobalSecondaryIndexUpdates: [{
        Delete: {
          IndexName: indexName,
        },
      }],
    }

    await this.executeUpdateTable(input)
    this.log(`[Migration] GSI ${indexName} deleted from ${tableName}`)
  }

  /**
   * Update TTL configuration
   */
  private async updateTTL(tableName: string, ttlAttribute: string | null, enabled: boolean): Promise<void> {
    this.log(`[Migration] Updating TTL on ${tableName}: ${enabled ? ttlAttribute : 'disabled'}`)

    const input = {
      TableName: tableName,
      TimeToLiveSpecification: {
        Enabled: enabled,
        AttributeName: ttlAttribute || 'ttl',
      },
    }

    await this.executeUpdateTimeToLive(input)
    this.log(`[Migration] TTL updated on ${tableName}`)
  }

  /**
   * Update billing mode
   */
  private async updateBillingMode(
    tableName: string,
    billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED',
    provisionedThroughput?: { readCapacityUnits: number; writeCapacityUnits: number },
  ): Promise<void> {
    this.log(`[Migration] Updating billing mode on ${tableName} to ${billingMode}`)

    const input: any = {
      TableName: tableName,
      BillingMode: billingMode,
    }

    if (billingMode === 'PROVISIONED' && provisionedThroughput) {
      input.ProvisionedThroughput = {
        ReadCapacityUnits: provisionedThroughput.readCapacityUnits,
        WriteCapacityUnits: provisionedThroughput.writeCapacityUnits,
      }
    }

    await this.executeUpdateTable(input)
    await this.waitForTableActive(tableName)
    this.log(`[Migration] Billing mode updated on ${tableName}`)
  }

  /**
   * Enable DynamoDB Streams
   */
  private async enableStream(tableName: string, viewType: string): Promise<void> {
    this.log(`[Migration] Enabling stream on ${tableName} with view type ${viewType}`)

    const input = {
      TableName: tableName,
      StreamSpecification: {
        StreamEnabled: true,
        StreamViewType: viewType,
      },
    }

    await this.executeUpdateTable(input)
    await this.waitForTableActive(tableName)
    this.log(`[Migration] Stream enabled on ${tableName}`)
  }

  /**
   * Disable DynamoDB Streams
   */
  private async disableStream(tableName: string): Promise<void> {
    this.log(`[Migration] Disabling stream on ${tableName}`)

    const input = {
      TableName: tableName,
      StreamSpecification: {
        StreamEnabled: false,
      },
    }

    await this.executeUpdateTable(input)
    await this.waitForTableActive(tableName)
    this.log(`[Migration] Stream disabled on ${tableName}`)
  }

  /**
   * Execute UpdateTable operation
   */
  private async executeUpdateTable(input: any): Promise<void> {
    await this.client.updateTable(input)
  }

  /**
   * Execute UpdateTimeToLive operation
   */
  private async executeUpdateTimeToLive(input: any): Promise<void> {
    await this.client.updateTimeToLive(input)
  }

  /**
   * Wait for table to become active
   */
  private async waitForTableActive(tableName: string, maxAttempts: number = 60): Promise<void> {
    this.log(`[Migration] Waiting for table ${tableName} to become active...`)

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.client.describeTable(tableName)
        const status = result.Table?.TableStatus

        if (status === 'ACTIVE') {
          return
        }

        this.log(`[Migration] Table status: ${status}, waiting...`)
      } catch {
        // Table might not exist yet
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    throw new Error(`Table ${tableName} did not become active within ${maxAttempts * 2} seconds`)
  }

  /**
   * Wait for GSI to become active
   */
  private async waitForGSIActive(tableName: string, indexName: string, maxAttempts: number = 120): Promise<void> {
    this.log(`[Migration] Waiting for GSI ${indexName} to become active...`)

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.client.describeTable(tableName)
        const gsi = result.Table?.GlobalSecondaryIndexes?.find((g: any) => g.IndexName === indexName)

        if (gsi?.IndexStatus === 'ACTIVE') {
          return
        }

        const status = gsi?.IndexStatus || 'CREATING'
        this.log(`[Migration] GSI status: ${status}, waiting...`)
      } catch {
        // Continue waiting
      }
      await new Promise(resolve => setTimeout(resolve, 5000))
    }

    throw new Error(`GSI ${indexName} did not become active within ${maxAttempts * 5} seconds`)
  }

  /**
   * Migrate a single model to DynamoDB
   */
  async migrateModel(ModelClass: any): Promise<MigrationResult> {
    const definition = extractTableDefinition(ModelClass)

    // Get current table state
    let currentDefinition: DynamoDBTableDefinition | null = null
    try {
      const tableInfo = await this.client.describeTable(definition.tableName)
      if (tableInfo.Table) {
        currentDefinition = this.tableInfoToDefinition(tableInfo.Table)
      }
    } catch (error: any) {
      if (!error.message?.includes('ResourceNotFoundException') && !error.message?.includes('not found')) {
        throw error
      }
      // Table doesn't exist - will be created
    }

    // Build migration plan
    const plan = buildMigrationPlan(currentDefinition, definition)

    // Execute migration
    const result = await this.execute(plan)

    // Record migration state
    if (result.success && !this.config.dryRun) {
      result.state = await this.tracker.recordMigration(definition.tableName, definition)
    }

    return result
  }

  /**
   * Migrate multiple models
   */
  async migrateModels(models: any[]): Promise<MigrationResult[]> {
    const results: MigrationResult[] = []

    for (const ModelClass of models) {
      try {
        const result = await this.migrateModel(ModelClass)
        results.push(result)
      } catch (error: any) {
        results.push({
          tableName: ModelClass.tableName || 'unknown',
          success: false,
          operations: [],
          error: error.message,
        })
      }
    }

    return results
  }

  /**
   * Get migration status for all tracked tables
   */
  async getStatus(): Promise<Map<string, DynamoDBMigrationState | null>> {
    const status = new Map<string, DynamoDBMigrationState | null>()
    const tables = await this.tracker.listTrackedTables()

    for (const tableName of tables) {
      const state = await this.tracker.getLatestState(tableName)
      status.set(tableName, state)
    }

    return status
  }

  /**
   * Convert DynamoDB table info to definition
   */
  private tableInfoToDefinition(tableInfo: any): DynamoDBTableDefinition {
    const keySchema = {
      partitionKey: '',
      sortKey: undefined as string | undefined,
    }

    for (const key of tableInfo.KeySchema || []) {
      if (key.KeyType === 'HASH') {
        keySchema.partitionKey = key.AttributeName
      } else if (key.KeyType === 'RANGE') {
        keySchema.sortKey = key.AttributeName
      }
    }

    const attributeDefinitions = (tableInfo.AttributeDefinitions || []).map((a: any) => ({
      name: a.AttributeName,
      type: a.AttributeType,
    }))

    const gsis = (tableInfo.GlobalSecondaryIndexes || []).map((gsi: any) => {
      const gsiKeySchema = {
        partitionKey: '',
        sortKey: undefined as string | undefined,
      }

      for (const key of gsi.KeySchema || []) {
        if (key.KeyType === 'HASH') {
          gsiKeySchema.partitionKey = key.AttributeName
        } else if (key.KeyType === 'RANGE') {
          gsiKeySchema.sortKey = key.AttributeName
        }
      }

      return {
        indexName: gsi.IndexName,
        keySchema: gsiKeySchema,
        projection: {
          type: gsi.Projection?.ProjectionType || 'ALL',
          nonKeyAttributes: gsi.Projection?.NonKeyAttributes,
        },
        provisionedThroughput: gsi.ProvisionedThroughput ? {
          readCapacityUnits: gsi.ProvisionedThroughput.ReadCapacityUnits,
          writeCapacityUnits: gsi.ProvisionedThroughput.WriteCapacityUnits,
        } : undefined,
      }
    })

    return {
      tableName: tableInfo.TableName,
      keySchema,
      attributeDefinitions,
      globalSecondaryIndexes: gsis.length > 0 ? gsis : undefined,
      billingMode: tableInfo.BillingModeSummary?.BillingMode || 'PAY_PER_REQUEST',
      provisionedThroughput: tableInfo.ProvisionedThroughput ? {
        readCapacityUnits: tableInfo.ProvisionedThroughput.ReadCapacityUnits,
        writeCapacityUnits: tableInfo.ProvisionedThroughput.WriteCapacityUnits,
      } : undefined,
      ttlAttribute: tableInfo.TimeToLiveDescription?.AttributeName,
      streamSpecification: tableInfo.StreamSpecification ? {
        enabled: tableInfo.StreamSpecification.StreamEnabled,
        viewType: tableInfo.StreamSpecification.StreamViewType,
      } : undefined,
    }
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(...args: any[]): void {
    if (this.config.verbose || this.config.dryRun) {
      console.log(...args)
    }
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a migration driver instance
 */
export function createMigrationDriver(config: MigrationDriverConfig): DynamoDBMigrationDriver {
  return new DynamoDBMigrationDriver(config)
}

/**
 * Migrate models with default configuration
 */
export async function migrateModels(
  models: any[],
  config: MigrationDriverConfig,
): Promise<MigrationResult[]> {
  const driver = createMigrationDriver(config)
  return driver.migrateModels(models)
}
