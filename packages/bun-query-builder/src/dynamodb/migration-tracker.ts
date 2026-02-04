/**
 * DynamoDB Migration Tracker
 *
 * Tracks applied migrations in a DynamoDB table to enable
 * incremental schema updates and rollback capabilities.
 *
 * Migration state is stored in a `_qb_migrations` table with:
 * - pk: MIGRATION#{tableName}
 * - sk: VERSION#{version}
 */

import type { DynamoDBTableDefinition } from '../drivers/dynamodb'
import type { DynamoDBMigrationState } from './migrations'
import { DynamoDBClient } from './client'
import { hashTableDefinition } from './migrations'

// ============================================================================
// Constants
// ============================================================================

const MIGRATIONS_TABLE = '_qb_migrations'
const PK_PREFIX = 'MIGRATION'
const SK_PREFIX = 'VERSION'

// ============================================================================
// Migration Tracker
// ============================================================================

/**
 * Tracks and manages DynamoDB migration state
 */
export class DynamoDBMigrationTracker {
  private client: DynamoDBClient
  private initialized: boolean = false

  constructor(client: DynamoDBClient) {
    this.client = client
  }

  /**
   * Ensure the migrations table exists
   */
  async ensureMigrationsTable(): Promise<void> {
    if (this.initialized) return

    try {
      // Check if table exists
      await this.client.describeTable(MIGRATIONS_TABLE)
      this.initialized = true
    } catch (error: any) {
      if (error.message?.includes('ResourceNotFoundException') || error.message?.includes('not found')) {
        // Create the migrations table
        console.log(`[Migration] Creating migrations table: ${MIGRATIONS_TABLE}`)
        await this.client.createTable({
          TableName: MIGRATIONS_TABLE,
          KeySchema: [
            { AttributeName: 'pk', KeyType: 'HASH' },
            { AttributeName: 'sk', KeyType: 'RANGE' },
          ],
          AttributeDefinitions: [
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'sk', AttributeType: 'S' },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        })

        // Wait for table to be active
        await this.waitForTableActive(MIGRATIONS_TABLE)
        this.initialized = true
      } else {
        throw error
      }
    }
  }

  /**
   * Wait for a table to become active
   */
  private async waitForTableActive(tableName: string, maxAttempts: number = 30): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.client.describeTable(tableName)
        if (result.Table?.TableStatus === 'ACTIVE') {
          return
        }
      } catch {
        // Table might not exist yet, continue waiting
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error(`Table ${tableName} did not become active within ${maxAttempts} seconds`)
  }

  /**
   * Get the latest migration state for a table
   */
  async getLatestState(tableName: string): Promise<DynamoDBMigrationState | null> {
    await this.ensureMigrationsTable()

    const pk = `${PK_PREFIX}#${tableName}`

    // Query for all versions, sorted descending
    const result = await this.client.query({
      TableName: MIGRATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': { S: pk },
      },
      ScanIndexForward: false, // Descending
      Limit: 1,
    })

    if (!result.Items || result.Items.length === 0) {
      return null
    }

    return this.unmarshallState(result.Items[0])
  }

  /**
   * Get all migration states for a table
   */
  async getHistory(tableName: string): Promise<DynamoDBMigrationState[]> {
    await this.ensureMigrationsTable()

    const pk = `${PK_PREFIX}#${tableName}`

    const result = await this.client.query({
      TableName: MIGRATIONS_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': { S: pk },
      },
      ScanIndexForward: false, // Descending (newest first)
    })

    if (!result.Items) {
      return []
    }

    return result.Items.map((item: any) => this.unmarshallState(item))
  }

  /**
   * Record a new migration state
   */
  async recordMigration(
    tableName: string,
    definition: DynamoDBTableDefinition,
    version?: number,
  ): Promise<DynamoDBMigrationState> {
    await this.ensureMigrationsTable()

    // Get current version
    const latest = await this.getLatestState(tableName)
    const newVersion = version ?? (latest ? latest.version + 1 : 1)

    const pk = `${PK_PREFIX}#${tableName}`
    const sk = `${SK_PREFIX}#${String(newVersion).padStart(6, '0')}`

    const state: DynamoDBMigrationState = {
      tableName,
      hash: hashTableDefinition(definition),
      definition,
      appliedAt: new Date().toISOString(),
      version: newVersion,
    }

    await this.client.putItem({
      TableName: MIGRATIONS_TABLE,
      Item: this.marshallState(state, pk, sk),
    })

    console.log(`[Migration] Recorded migration for ${tableName} (version ${newVersion})`)

    return state
  }

  /**
   * List all tracked tables
   */
  async listTrackedTables(): Promise<string[]> {
    await this.ensureMigrationsTable()

    const result = await this.client.scan({
      TableName: MIGRATIONS_TABLE,
      ProjectionExpression: 'pk',
    })

    if (!result.Items) {
      return []
    }

    // Extract unique table names from pk
    const tableNames = new Set<string>()
    for (const item of result.Items) {
      const pk = item.pk?.S || ''
      const tableName = pk.replace(`${PK_PREFIX}#`, '')
      if (tableName) {
        tableNames.add(tableName)
      }
    }

    return Array.from(tableNames)
  }

  /**
   * Check if a table has any migrations recorded
   */
  async hasMigrations(tableName: string): Promise<boolean> {
    const state = await this.getLatestState(tableName)
    return state !== null
  }

  /**
   * Delete all migration records for a table
   */
  async deleteMigrationHistory(tableName: string): Promise<void> {
    await this.ensureMigrationsTable()

    const history = await this.getHistory(tableName)
    const pk = `${PK_PREFIX}#${tableName}`

    for (const state of history) {
      const sk = `${SK_PREFIX}#${String(state.version).padStart(6, '0')}`
      await this.client.deleteItem({
        TableName: MIGRATIONS_TABLE,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
      })
    }

    console.log(`[Migration] Deleted migration history for ${tableName}`)
  }

  /**
   * Marshall a migration state to DynamoDB format
   */
  private marshallState(
    state: DynamoDBMigrationState,
    pk: string,
    sk: string,
  ): Record<string, any> {
    return {
      pk: { S: pk },
      sk: { S: sk },
      tableName: { S: state.tableName },
      hash: { S: state.hash },
      definition: { S: JSON.stringify(state.definition) },
      appliedAt: { S: state.appliedAt },
      version: { N: String(state.version) },
    }
  }

  /**
   * Unmarshall a DynamoDB item to migration state
   */
  private unmarshallState(item: Record<string, any>): DynamoDBMigrationState {
    return {
      tableName: item.tableName?.S || '',
      hash: item.hash?.S || '',
      definition: JSON.parse(item.definition?.S || '{}'),
      appliedAt: item.appliedAt?.S || '',
      version: Number(item.version?.N || 0),
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

export { MIGRATIONS_TABLE }
