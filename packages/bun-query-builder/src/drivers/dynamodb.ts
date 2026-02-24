/**
 * DynamoDB Driver for bun-query-builder
 *
 * This driver supports DynamoDB's unique data model including:
 * - Single table design patterns
 * - Partition key (PK) and sort key (SK) based access
 * - Global Secondary Indexes (GSI) and Local Secondary Indexes (LSI)
 * - DynamoDB-specific operations (Query, Scan, GetItem, PutItem, etc.)
 */

/**
 * DynamoDB key schema definition
 */
export interface DynamoDBKeySchema {
  /** Partition key attribute name */
  partitionKey: string
  /** Sort key attribute name (optional for tables with only partition key) */
  sortKey?: string
}

/**
 * DynamoDB attribute type mapping
 */
export type DynamoDBAttributeType = 'S' | 'N' | 'B' | 'SS' | 'NS' | 'BS' | 'M' | 'L' | 'BOOL' | 'NULL'

/**
 * DynamoDB attribute definition for table/index creation
 */
export interface DynamoDBAttributeDefinition {
  name: string
  type: 'S' | 'N' | 'B' // Only S, N, B are allowed for key attributes
}

/**
 * Global Secondary Index definition
 */
export interface DynamoDBGlobalSecondaryIndex {
  indexName: string
  keySchema: DynamoDBKeySchema
  projection: {
    type: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'
    nonKeyAttributes?: string[]
  }
  provisionedThroughput?: {
    readCapacityUnits: number
    writeCapacityUnits: number
  }
}

/**
 * Local Secondary Index definition
 */
export interface DynamoDBLocalSecondaryIndex {
  indexName: string
  sortKey: string
  projection: {
    type: 'ALL' | 'KEYS_ONLY' | 'INCLUDE'
    nonKeyAttributes?: string[]
  }
}

/**
 * DynamoDB table definition for single table design
 */
export interface DynamoDBTableDefinition {
  tableName: string
  keySchema: DynamoDBKeySchema
  attributeDefinitions: DynamoDBAttributeDefinition[]
  globalSecondaryIndexes?: DynamoDBGlobalSecondaryIndex[]
  localSecondaryIndexes?: DynamoDBLocalSecondaryIndex[]
  billingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST'
  provisionedThroughput?: {
    readCapacityUnits: number
    writeCapacityUnits: number
  }
  /** Time to live specification */
  ttlAttribute?: string
  /** Stream specification for DynamoDB Streams */
  streamSpecification?: {
    enabled: boolean
    viewType?: 'KEYS_ONLY' | 'NEW_IMAGE' | 'OLD_IMAGE' | 'NEW_AND_OLD_IMAGES'
  }
}

/**
 * Single table design entity mapping
 * Maps model entities to PK/SK patterns
 */
export interface SingleTableEntityMapping {
  /** Entity type name (e.g., 'User', 'Post', 'Comment') */
  entityType: string
  /** Pattern for partition key (e.g., 'USER#${id}', 'POST#${postId}') */
  pkPattern: string
  /** Pattern for sort key (e.g., 'METADATA', 'COMMENT#${commentId}') */
  skPattern: string
  /** GSI mappings for this entity */
  gsiMappings?: {
    indexName: string
    pkPattern: string
    skPattern?: string
  }[]
  /** Attributes specific to this entity type */
  attributes?: Record<string, DynamoDBAttributeType>
}

/**
 * DynamoDB query condition operators
 */
export type DynamoDBComparisonOperator =
  | '='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'BETWEEN'
  | 'begins_with'

/**
 * DynamoDB filter condition for Query/Scan operations
 */
export interface DynamoDBCondition {
  attribute: string
  operator: DynamoDBComparisonOperator | 'contains' | 'attribute_exists' | 'attribute_not_exists' | 'attribute_type' | 'IN'
  value?: any
  values?: any[] // For BETWEEN and IN operators
}

/**
 * DynamoDB Query parameters
 */
export interface DynamoDBQueryParams {
  tableName: string
  indexName?: string
  keyConditions: DynamoDBCondition[]
  filterConditions?: DynamoDBCondition[]
  projectionAttributes?: string[]
  limit?: number
  scanIndexForward?: boolean // true = ascending, false = descending
  exclusiveStartKey?: Record<string, any>
  consistentRead?: boolean
}

/**
 * DynamoDB Scan parameters
 */
export interface DynamoDBScanParams {
  tableName: string
  indexName?: string
  filterConditions?: DynamoDBCondition[]
  projectionAttributes?: string[]
  limit?: number
  exclusiveStartKey?: Record<string, any>
  segment?: number
  totalSegments?: number
  consistentRead?: boolean
}

/**
 * DynamoDB GetItem parameters
 */
export interface DynamoDBGetItemParams {
  tableName: string
  key: Record<string, any>
  projectionAttributes?: string[]
  consistentRead?: boolean
}

/**
 * DynamoDB PutItem parameters
 */
export interface DynamoDBPutItemParams {
  tableName: string
  item: Record<string, any>
  conditionExpression?: string
  returnValues?: 'NONE' | 'ALL_OLD'
}

/**
 * DynamoDB UpdateItem parameters
 */
export interface DynamoDBUpdateItemParams {
  tableName: string
  key: Record<string, any>
  updateExpressions: {
    set?: Record<string, any>
    remove?: string[]
    add?: Record<string, any>
    delete?: Record<string, any>
  }
  conditionExpression?: string
  returnValues?: 'NONE' | 'ALL_OLD' | 'UPDATED_OLD' | 'ALL_NEW' | 'UPDATED_NEW'
}

/**
 * DynamoDB DeleteItem parameters
 */
export interface DynamoDBDeleteItemParams {
  tableName: string
  key: Record<string, any>
  conditionExpression?: string
  returnValues?: 'NONE' | 'ALL_OLD'
}

/**
 * DynamoDB BatchGetItem parameters
 */
export interface DynamoDBBatchGetItemParams {
  requestItems: {
    [tableName: string]: {
      keys: Record<string, any>[]
      projectionAttributes?: string[]
      consistentRead?: boolean
    }
  }
}

/**
 * DynamoDB BatchWriteItem parameters
 */
export interface DynamoDBBatchWriteItemParams {
  requestItems: {
    [tableName: string]: (
      | { putRequest: { item: Record<string, any> } }
      | { deleteRequest: { key: Record<string, any> } }
    )[]
  }
}

/**
 * DynamoDB TransactWriteItems parameters
 */
export interface DynamoDBTransactWriteParams {
  transactItems: (
    | { put: DynamoDBPutItemParams }
    | { update: DynamoDBUpdateItemParams }
    | { delete: DynamoDBDeleteItemParams }
    | { conditionCheck: { tableName: string, key: Record<string, any>, conditionExpression: string } }
  )[]
  clientRequestToken?: string
}

/**
 * DynamoDB Driver Interface
 *
 * Unlike SQL drivers, DynamoDB operations are API-based rather than SQL-based.
 * This interface provides methods to build DynamoDB API request parameters.
 */
export interface DynamoDBDriver {
  // Table operations
  createTable: (definition: DynamoDBTableDefinition) => DynamoDBTableDefinition
  deleteTable: (tableName: string) => { tableName: string }

  // Single table design helpers
  registerEntity: (mapping: SingleTableEntityMapping) => void
  getEntityMapping: (entityType: string) => SingleTableEntityMapping | undefined
  buildPrimaryKey: (entityType: string, values: Record<string, any>) => { pk: string, sk: string }
  parseEntityFromItem: (item: Record<string, any>) => { entityType: string, data: Record<string, any> } | null

  // Query building
  buildQueryParams: (params: Partial<DynamoDBQueryParams>) => DynamoDBQueryParams
  buildScanParams: (params: Partial<DynamoDBScanParams>) => DynamoDBScanParams
  buildGetItemParams: (params: Partial<DynamoDBGetItemParams>) => DynamoDBGetItemParams
  buildPutItemParams: (params: Partial<DynamoDBPutItemParams>) => DynamoDBPutItemParams
  buildUpdateItemParams: (params: Partial<DynamoDBUpdateItemParams>) => DynamoDBUpdateItemParams
  buildDeleteItemParams: (params: Partial<DynamoDBDeleteItemParams>) => DynamoDBDeleteItemParams

  // Batch operations
  buildBatchGetItemParams: (params: Partial<DynamoDBBatchGetItemParams>) => DynamoDBBatchGetItemParams
  buildBatchWriteItemParams: (params: Partial<DynamoDBBatchWriteItemParams>) => DynamoDBBatchWriteItemParams

  // Transaction operations
  buildTransactWriteParams: (params: Partial<DynamoDBTransactWriteParams>) => DynamoDBTransactWriteParams

  // Expression builders (for building DynamoDB expressions)
  buildKeyConditionExpression: (conditions: DynamoDBCondition[]) => {
    expression: string
    expressionAttributeNames: Record<string, string>
    expressionAttributeValues: Record<string, any>
  }
  buildFilterExpression: (conditions: DynamoDBCondition[]) => {
    expression: string
    expressionAttributeNames: Record<string, string>
    expressionAttributeValues: Record<string, any>
  }
  buildUpdateExpression: (updates: DynamoDBUpdateItemParams['updateExpressions']) => {
    expression: string
    expressionAttributeNames: Record<string, string>
    expressionAttributeValues: Record<string, any>
  }
  buildProjectionExpression: (attributes: string[]) => {
    expression: string
    expressionAttributeNames: Record<string, string>
  }

  // Value marshalling (convert JS values to DynamoDB format)
  marshall: (item: Record<string, any>) => Record<string, any>
  unmarshall: (item: Record<string, any>) => Record<string, any>
}

/**
 * Single table design configuration
 */
export interface SingleTableConfig {
  /** Enable single table design mode */
  enabled: boolean
  /** Partition key attribute name (default: 'pk') */
  pkAttribute?: string
  /** Sort key attribute name (default: 'sk') */
  skAttribute?: string
  /** Entity type attribute name (default: '_et') */
  entityTypeAttribute?: string
  /** Key delimiter (default: '#') */
  keyDelimiter?: string
}

/**
 * DynamoDB configuration options
 */
export interface DynamoDBConfig {
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
  /** Default table name for single table design */
  tableName?: string
  /** Entity mappings for single table design */
  entityMappings?: SingleTableEntityMapping[]
  /** Default billing mode for new tables */
  defaultBillingMode?: 'PROVISIONED' | 'PAY_PER_REQUEST'
  /** Single table design configuration */
  singleTable?: SingleTableConfig
}

/**
 * DynamoDB Driver Implementation
 */
export class DynamoDBDriverImpl implements DynamoDBDriver {
  private config: DynamoDBConfig
  private entityMappings: Map<string, SingleTableEntityMapping> = new Map()

  constructor(config: DynamoDBConfig) {
    this.config = config

    // Register initial entity mappings
    if (config.entityMappings) {
      for (const mapping of config.entityMappings) {
        this.registerEntity(mapping)
      }
    }
  }

  createTable(definition: DynamoDBTableDefinition): DynamoDBTableDefinition {
    // Apply defaults
    return {
      ...definition,
      billingMode: definition.billingMode ?? this.config.defaultBillingMode ?? 'PAY_PER_REQUEST',
    }
  }

  deleteTable(tableName: string): { tableName: string } {
    return { tableName }
  }

  registerEntity(mapping: SingleTableEntityMapping): void {
    this.entityMappings.set(mapping.entityType, mapping)
  }

  getEntityMapping(entityType: string): SingleTableEntityMapping | undefined {
    return this.entityMappings.get(entityType)
  }

  buildPrimaryKey(entityType: string, values: Record<string, any>): { pk: string, sk: string } {
    const mapping = this.entityMappings.get(entityType)
    if (!mapping) {
      throw new Error(`No entity mapping found for type: ${entityType}`)
    }

    const pk = this.interpolatePattern(mapping.pkPattern, values)
    const sk = this.interpolatePattern(mapping.skPattern, values)

    return { pk, sk }
  }

  parseEntityFromItem(item: Record<string, any>): { entityType: string, data: Record<string, any> } | null {
    // Try to determine entity type from PK pattern
    const pk = item.pk || item.PK
    if (!pk) return null

    for (const [entityType, mapping] of this.entityMappings) {
      const prefix = mapping.pkPattern.split('${')[0]
      if (pk.startsWith(prefix)) {
        return {
          entityType,
          data: this.unmarshall(item),
        }
      }
    }

    return null
  }

  buildQueryParams(params: Partial<DynamoDBQueryParams>): DynamoDBQueryParams {
    return {
      tableName: params.tableName ?? this.config.tableName ?? '',
      keyConditions: params.keyConditions ?? [],
      ...params,
    }
  }

  buildScanParams(params: Partial<DynamoDBScanParams>): DynamoDBScanParams {
    return {
      tableName: params.tableName ?? this.config.tableName ?? '',
      ...params,
    }
  }

  buildGetItemParams(params: Partial<DynamoDBGetItemParams>): DynamoDBGetItemParams {
    return {
      tableName: params.tableName ?? this.config.tableName ?? '',
      key: params.key ?? {},
      ...params,
    }
  }

  buildPutItemParams(params: Partial<DynamoDBPutItemParams>): DynamoDBPutItemParams {
    return {
      tableName: params.tableName ?? this.config.tableName ?? '',
      item: params.item ?? {},
      ...params,
    }
  }

  buildUpdateItemParams(params: Partial<DynamoDBUpdateItemParams>): DynamoDBUpdateItemParams {
    return {
      tableName: params.tableName ?? this.config.tableName ?? '',
      key: params.key ?? {},
      updateExpressions: params.updateExpressions ?? {},
      ...params,
    }
  }

  buildDeleteItemParams(params: Partial<DynamoDBDeleteItemParams>): DynamoDBDeleteItemParams {
    return {
      tableName: params.tableName ?? this.config.tableName ?? '',
      key: params.key ?? {},
      ...params,
    }
  }

  buildBatchGetItemParams(params: Partial<DynamoDBBatchGetItemParams>): DynamoDBBatchGetItemParams {
    return {
      requestItems: params.requestItems ?? {},
    }
  }

  buildBatchWriteItemParams(params: Partial<DynamoDBBatchWriteItemParams>): DynamoDBBatchWriteItemParams {
    return {
      requestItems: params.requestItems ?? {},
    }
  }

  buildTransactWriteParams(params: Partial<DynamoDBTransactWriteParams>): DynamoDBTransactWriteParams {
    return {
      transactItems: params.transactItems ?? [],
      ...params,
    }
  }

  buildKeyConditionExpression(conditions: DynamoDBCondition[]): {
    expression: string
    expressionAttributeNames: Record<string, string>
    expressionAttributeValues: Record<string, any>
  } {
    return this.buildExpression(conditions, 'AND')
  }

  buildFilterExpression(conditions: DynamoDBCondition[]): {
    expression: string
    expressionAttributeNames: Record<string, string>
    expressionAttributeValues: Record<string, any>
  } {
    return this.buildExpression(conditions, 'AND')
  }

  buildUpdateExpression(updates: DynamoDBUpdateItemParams['updateExpressions']): {
    expression: string
    expressionAttributeNames: Record<string, string>
    expressionAttributeValues: Record<string, any>
  } {
    const expressionAttributeNames: Record<string, string> = {}
    const expressionAttributeValues: Record<string, any> = {}
    const parts: string[] = []

    let valueIndex = 0

    // SET clause
    if (updates.set && Object.keys(updates.set).length > 0) {
      const setParts: string[] = []
      for (const [key, value] of Object.entries(updates.set)) {
        const nameKey = `#attr${valueIndex}`
        const valueKey = `:val${valueIndex}`
        expressionAttributeNames[nameKey] = key
        expressionAttributeValues[valueKey] = this.marshallValue(value)
        setParts.push(`${nameKey} = ${valueKey}`)
        valueIndex++
      }
      parts.push(`SET ${setParts.join(', ')}`)
    }

    // REMOVE clause
    if (updates.remove && updates.remove.length > 0) {
      const removeParts: string[] = []
      for (const attr of updates.remove) {
        const nameKey = `#attr${valueIndex}`
        expressionAttributeNames[nameKey] = attr
        removeParts.push(nameKey)
        valueIndex++
      }
      parts.push(`REMOVE ${removeParts.join(', ')}`)
    }

    // ADD clause (for numbers and sets)
    if (updates.add && Object.keys(updates.add).length > 0) {
      const addParts: string[] = []
      for (const [key, value] of Object.entries(updates.add)) {
        const nameKey = `#attr${valueIndex}`
        const valueKey = `:val${valueIndex}`
        expressionAttributeNames[nameKey] = key
        expressionAttributeValues[valueKey] = this.marshallValue(value)
        addParts.push(`${nameKey} ${valueKey}`)
        valueIndex++
      }
      parts.push(`ADD ${addParts.join(', ')}`)
    }

    // DELETE clause (for sets)
    if (updates.delete && Object.keys(updates.delete).length > 0) {
      const deleteParts: string[] = []
      for (const [key, value] of Object.entries(updates.delete)) {
        const nameKey = `#attr${valueIndex}`
        const valueKey = `:val${valueIndex}`
        expressionAttributeNames[nameKey] = key
        expressionAttributeValues[valueKey] = this.marshallValue(value)
        deleteParts.push(`${nameKey} ${valueKey}`)
        valueIndex++
      }
      parts.push(`DELETE ${deleteParts.join(', ')}`)
    }

    return {
      expression: parts.join(' '),
      expressionAttributeNames,
      expressionAttributeValues,
    }
  }

  buildProjectionExpression(attributes: string[]): {
    expression: string
    expressionAttributeNames: Record<string, string>
  } {
    const expressionAttributeNames: Record<string, string> = {}
    const projectionParts: string[] = []

    attributes.forEach((attr, index) => {
      const nameKey = `#proj${index}`
      expressionAttributeNames[nameKey] = attr
      projectionParts.push(nameKey)
    })

    return {
      expression: projectionParts.join(', '),
      expressionAttributeNames,
    }
  }

  marshall(item: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(item)) {
      result[key] = this.marshallValue(value)
    }
    return result
  }

  unmarshall(item: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {}
    for (const [key, value] of Object.entries(item)) {
      result[key] = this.unmarshallValue(value)
    }
    return result
  }

  // Private helper methods

  private interpolatePattern(pattern: string, values: Record<string, any>): string {
    return pattern.replace(/\$\{(\w+)\}/g, (_, key) => {
      if (!(key in values)) {
        throw new Error(`Missing value for pattern key: ${key}`)
      }
      return String(values[key])
    })
  }

  private buildExpression(conditions: DynamoDBCondition[], joiner: 'AND' | 'OR'): {
    expression: string
    expressionAttributeNames: Record<string, string>
    expressionAttributeValues: Record<string, any>
  } {
    const expressionAttributeNames: Record<string, string> = {}
    const expressionAttributeValues: Record<string, any> = {}
    const parts: string[] = []

    conditions.forEach((condition, index) => {
      const nameKey = `#attr${index}`
      expressionAttributeNames[nameKey] = condition.attribute

      let expr: string

      switch (condition.operator) {
        case '=':
        case '<':
        case '<=':
        case '>':
        case '>=': {
          const valueKey = `:val${index}`
          expressionAttributeValues[valueKey] = this.marshallValue(condition.value)
          expr = `${nameKey} ${condition.operator} ${valueKey}`
          break
        }
        case 'BETWEEN': {
          const valueKey1 = `:val${index}a`
          const valueKey2 = `:val${index}b`
          expressionAttributeValues[valueKey1] = this.marshallValue(condition.values?.[0])
          expressionAttributeValues[valueKey2] = this.marshallValue(condition.values?.[1])
          expr = `${nameKey} BETWEEN ${valueKey1} AND ${valueKey2}`
          break
        }
        case 'begins_with': {
          const valueKey = `:val${index}`
          expressionAttributeValues[valueKey] = this.marshallValue(condition.value)
          expr = `begins_with(${nameKey}, ${valueKey})`
          break
        }
        case 'contains': {
          const valueKey = `:val${index}`
          expressionAttributeValues[valueKey] = this.marshallValue(condition.value)
          expr = `contains(${nameKey}, ${valueKey})`
          break
        }
        case 'attribute_exists':
          expr = `attribute_exists(${nameKey})`
          break
        case 'attribute_not_exists':
          expr = `attribute_not_exists(${nameKey})`
          break
        case 'attribute_type': {
          const valueKey = `:val${index}`
          expressionAttributeValues[valueKey] = { S: condition.value }
          expr = `attribute_type(${nameKey}, ${valueKey})`
          break
        }
        case 'IN': {
          const valueKeys = (condition.values ?? []).map((_, i) => `:val${index}_${i}`)
          condition.values?.forEach((val, i) => {
            expressionAttributeValues[`:val${index}_${i}`] = this.marshallValue(val)
          })
          expr = `${nameKey} IN (${valueKeys.join(', ')})`
          break
        }
        default:
          throw new Error(`Unknown operator: ${condition.operator}`)
      }

      parts.push(expr)
    })

    return {
      expression: parts.join(` ${joiner} `),
      expressionAttributeNames,
      expressionAttributeValues,
    }
  }

  private marshallValue(value: any): any {
    if (value === null || value === undefined) {
      return { NULL: true }
    }
    if (typeof value === 'string') {
      return { S: value }
    }
    if (typeof value === 'number') {
      return { N: String(value) }
    }
    if (typeof value === 'boolean') {
      return { BOOL: value }
    }
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return { B: value }
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return { L: [] }
      }
      // Check if it's a set (all same type)
      const _firstType = typeof value[0]
      const isStringSet = value.every(v => typeof v === 'string')
      const isNumberSet = value.every(v => typeof v === 'number')

      if (isStringSet) {
        return { SS: value }
      }
      if (isNumberSet) {
        return { NS: value.map(String) }
      }
      // Otherwise it's a list
      return { L: value.map(v => this.marshallValue(v)) }
    }
    if (typeof value === 'object') {
      const marshalled: Record<string, any> = {}
      for (const [k, v] of Object.entries(value)) {
        marshalled[k] = this.marshallValue(v)
      }
      return { M: marshalled }
    }
    return { S: String(value) }
  }

  private unmarshallValue(value: any): any {
    if (!value || typeof value !== 'object') {
      return value
    }

    if ('S' in value) return value.S
    if ('N' in value) return Number(value.N)
    if ('BOOL' in value) return value.BOOL
    if ('NULL' in value) return null
    if ('B' in value) return value.B
    if ('SS' in value) return value.SS
    if ('NS' in value) return value.NS.map(Number)
    if ('BS' in value) return value.BS
    if ('L' in value) return value.L.map((v: any) => this.unmarshallValue(v))
    if ('M' in value) {
      const result: Record<string, any> = {}
      for (const [k, v] of Object.entries(value.M)) {
        result[k] = this.unmarshallValue(v)
      }
      return result
    }

    return value
  }
}

/**
 * Create a new DynamoDB driver instance
 */
export function createDynamoDBDriver(config: DynamoDBConfig): DynamoDBDriver {
  return new DynamoDBDriverImpl(config)
}
