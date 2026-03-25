export * from './actions'
export * from './browser'
export * from './client'
export * from './model'
export * from './config'
export * from './drivers'
export * from './dynamodb-client'
export * from './dynamodb-single-table'
export * from './dynamodb-tooling-adapter'
export * from './dynamodb'
export * from './factory'
export * from './loader'
export * from './meta'
export * from './migrations'
export * from './orm'
export * from './schema'
export * from './seeder'
export * from './type-inference'
export * from './types'

// Resolve ambiguous re-exports by explicitly choosing which module's version to use
export type { WhereOperator } from './browser'
export type { ModelQueryBuilder } from './dynamodb'
export type { ColumnName } from './client'
export { type ModelDefinition, defineModel } from './model'

// Explicit re-exports for model registry functions
export { getModel, getAllModels, getModelRegistry, hasModel, clearModelRegistry } from './model'

// Re-export the type-inference version of InferRelationNames (supports wrapped models)
// to resolve the ambiguity with orm.ts's InferRelationNames (which takes raw definitions)
export type { InferRelationNames } from './type-inference'

// Explicit re-exports for type inference utilities
export type {
  InferAttributes,
  InferFillableAttributes,
  InferPrimaryKey,
  InferTableName,
  InferNumericColumns,
  InferColumnNames,
  InferHiddenKeys,
  InferGuardedKeys,
  ModelRow,
  ModelRowLoose,
  ModelCreateData,
  ModelCreateDataLoose,
} from './type-inference'
