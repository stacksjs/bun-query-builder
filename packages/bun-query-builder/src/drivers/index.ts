import type { SupportedDialect } from '../types'
import type { DialectDriver } from './postgres'
import { MySQLDriver } from './mysql'
import { PostgresDriver } from './postgres'
import { SingleStoreDriver } from './singlestore'
import { SQLiteDriver } from './sqlite'

export function getDialectDriver(dialect: SupportedDialect): DialectDriver {
  switch (dialect) {
    case 'postgres':
      return new PostgresDriver()
    case 'mysql':
      return new MySQLDriver()
    case 'singlestore':
      return new SingleStoreDriver()
    case 'sqlite':
      return new SQLiteDriver()
    default:
      throw new Error(`Unsupported dialect: ${dialect}`)
  }
}

export { MySQLDriver } from './mysql'
export type { DialectDriver } from './postgres'
export { PostgresDriver } from './postgres'
export { SingleStoreDriver } from './singlestore'
export { SQLiteDriver } from './sqlite'

// DynamoDB driver (NoSQL)
export {
  createDynamoDBDriver,
  DynamoDBDriverImpl,
} from './dynamodb'
export type {
  DynamoDBAttributeDefinition,
  DynamoDBAttributeType,
  DynamoDBBatchGetItemParams,
  DynamoDBBatchWriteItemParams,
  DynamoDBComparisonOperator,
  DynamoDBCondition,
  DynamoDBConfig,
  DynamoDBDeleteItemParams,
  DynamoDBDriver,
  DynamoDBGetItemParams,
  DynamoDBGlobalSecondaryIndex,
  DynamoDBKeySchema,
  DynamoDBLocalSecondaryIndex,
  DynamoDBPutItemParams,
  DynamoDBQueryParams,
  DynamoDBScanParams,
  DynamoDBTableDefinition,
  DynamoDBTransactWriteParams,
  DynamoDBUpdateItemParams,
  SingleTableEntityMapping,
} from './dynamodb'
