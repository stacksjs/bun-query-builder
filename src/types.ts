export type SupportedDialect = 'postgres' | 'mysql' | 'sqlite'

export interface TransactionBackoffConfig {
  baseMs: number
  factor: number
  maxMs: number
  jitter: boolean
}

export interface TransactionDefaultsConfig {
  retries: number
  isolation?: 'read committed' | 'repeatable read' | 'serializable'
  sqlStates: string[]
  backoff: TransactionBackoffConfig
}

export interface TimestampConfig {
  createdAt: string
  updatedAt: string
  defaultOrderColumn: string
}

export interface PaginationConfig {
  defaultPerPage: number
  cursorColumn: string
}

export interface AliasingConfig {
  relationColumnAliasFormat: 'table_column' | 'table.dot.column' | 'camelCase'
}

export interface RelationsConfig {
  foreignKeyFormat: 'singularParent_id' | 'parentId'
  singularizeStrategy?: 'stripTrailingS' | 'none'
}

export interface SqlConfig {
  randomFunction?: 'RANDOM()' | 'RAND()'
  sharedLockSyntax?: 'FOR SHARE' | 'LOCK IN SHARE MODE'
  jsonContainsMode?: 'operator' | 'function'
}

export interface FeatureToggles {
  distinctOn: boolean
}

export interface QueryBuilderConfig {
  verbose: boolean
  dialect: SupportedDialect
  timestamps: TimestampConfig
  pagination: PaginationConfig
  aliasing: AliasingConfig
  relations: RelationsConfig
  transactionDefaults: TransactionDefaultsConfig
  sql: SqlConfig
  features: FeatureToggles
  debug?: {
    captureText: boolean
  }
}
