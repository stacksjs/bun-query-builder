/**
 * Native DynamoDB HTTP Client
 *
 * Zero-dependency DynamoDB client using native fetch and AWS Signature V4.
 * Implements all core DynamoDB operations without requiring @aws-sdk.
 *
 * @example
 * ```typescript
 * const client = new DynamoDBClient({
 *   region: 'us-east-1',
 *   credentials: {
 *     accessKeyId: 'AKIA...',
 *     secretAccessKey: '...',
 *   },
 * })
 *
 * const result = await client.query({
 *   TableName: 'MyTable',
 *   KeyConditionExpression: 'pk = :pk',
 *   ExpressionAttributeValues: { ':pk': { S: 'USER#123' } },
 * })
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export interface DynamoDBCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface DynamoDBClientConfig {
  region: string
  endpoint?: string
  credentials?: DynamoDBCredentials
}

export interface DynamoDBQueryInput {
  TableName: string
  IndexName?: string
  KeyConditionExpression?: string
  FilterExpression?: string
  ProjectionExpression?: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, any>
  Limit?: number
  ScanIndexForward?: boolean
  ConsistentRead?: boolean
  ExclusiveStartKey?: Record<string, any>
  Select?: 'ALL_ATTRIBUTES' | 'ALL_PROJECTED_ATTRIBUTES' | 'SPECIFIC_ATTRIBUTES' | 'COUNT'
}

export interface DynamoDBScanInput {
  TableName: string
  IndexName?: string
  FilterExpression?: string
  ProjectionExpression?: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, any>
  Limit?: number
  ConsistentRead?: boolean
  ExclusiveStartKey?: Record<string, any>
  Segment?: number
  TotalSegments?: number
  Select?: 'ALL_ATTRIBUTES' | 'ALL_PROJECTED_ATTRIBUTES' | 'SPECIFIC_ATTRIBUTES' | 'COUNT'
}

export interface DynamoDBGetItemInput {
  TableName: string
  Key: Record<string, any>
  ProjectionExpression?: string
  ExpressionAttributeNames?: Record<string, string>
  ConsistentRead?: boolean
}

export interface DynamoDBPutItemInput {
  TableName: string
  Item: Record<string, any>
  ConditionExpression?: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, any>
  ReturnValues?: 'NONE' | 'ALL_OLD'
}

export interface DynamoDBUpdateItemInput {
  TableName: string
  Key: Record<string, any>
  UpdateExpression?: string
  ConditionExpression?: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, any>
  ReturnValues?: 'NONE' | 'ALL_OLD' | 'UPDATED_OLD' | 'ALL_NEW' | 'UPDATED_NEW'
}

export interface DynamoDBDeleteItemInput {
  TableName: string
  Key: Record<string, any>
  ConditionExpression?: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, any>
  ReturnValues?: 'NONE' | 'ALL_OLD'
}

export interface DynamoDBBatchGetItemInput {
  RequestItems: {
    [tableName: string]: {
      Keys: Record<string, any>[]
      ProjectionExpression?: string
      ExpressionAttributeNames?: Record<string, string>
      ConsistentRead?: boolean
    }
  }
}

export interface DynamoDBBatchWriteItemInput {
  RequestItems: {
    [tableName: string]: (
      | { PutRequest: { Item: Record<string, any> } }
      | { DeleteRequest: { Key: Record<string, any> } }
    )[]
  }
}

export interface DynamoDBTransactWriteItemsInput {
  TransactItems: (
    | { Put: { TableName: string, Item: Record<string, any>, ConditionExpression?: string, ExpressionAttributeNames?: Record<string, string>, ExpressionAttributeValues?: Record<string, any> } }
    | { Update: { TableName: string, Key: Record<string, any>, UpdateExpression: string, ConditionExpression?: string, ExpressionAttributeNames?: Record<string, string>, ExpressionAttributeValues?: Record<string, any> } }
    | { Delete: { TableName: string, Key: Record<string, any>, ConditionExpression?: string, ExpressionAttributeNames?: Record<string, string>, ExpressionAttributeValues?: Record<string, any> } }
    | { ConditionCheck: { TableName: string, Key: Record<string, any>, ConditionExpression: string, ExpressionAttributeNames?: Record<string, string>, ExpressionAttributeValues?: Record<string, any> } }
  )[]
  ClientRequestToken?: string
}

export interface DynamoDBQueryOutput {
  Items?: Record<string, any>[]
  Count?: number
  ScannedCount?: number
  LastEvaluatedKey?: Record<string, any>
  ConsumedCapacity?: any
}

export interface DynamoDBGetItemOutput {
  Item?: Record<string, any>
  ConsumedCapacity?: any
}

export interface DynamoDBPutItemOutput {
  Attributes?: Record<string, any>
  ConsumedCapacity?: any
}

export interface DynamoDBUpdateItemOutput {
  Attributes?: Record<string, any>
  ConsumedCapacity?: any
}

export interface DynamoDBDeleteItemOutput {
  Attributes?: Record<string, any>
  ConsumedCapacity?: any
}

// ============================================================================
// AWS Signature V4 Implementation
// ============================================================================

/**
 * Compute HMAC-SHA256
 */
async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  // Convert to ArrayBuffer for Web Crypto API compatibility
  const keyBuffer: ArrayBuffer = key instanceof ArrayBuffer
    ? key
    : key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message))
}

/**
 * Compute SHA-256 hash
 */
async function sha256(message: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Get signing key for AWS Signature V4
 */
async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode(`AWS4${secretKey}`), dateStamp)
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

/**
 * Create AWS Signature V4 authorization header
 */
async function signRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  body: string,
  credentials: DynamoDBCredentials,
  region: string,
  service: string,
): Promise<Record<string, string>> {
  const now = new Date()
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)

  // Canonical request components
  const canonicalUri = url.pathname
  const canonicalQuerystring = url.search.slice(1)

  // Add required headers
  const signedHeaders: Record<string, string> = {
    ...headers,
    host: url.host,
    'x-amz-date': amzDate,
  }

  if (credentials.sessionToken) {
    signedHeaders['x-amz-security-token'] = credentials.sessionToken
  }

  // Create canonical headers
  const sortedHeaderKeys = Object.keys(signedHeaders).sort()
  const canonicalHeaders = sortedHeaderKeys.map(key => `${key.toLowerCase()}:${signedHeaders[key].trim()}`).join('\n') + '\n'
  const signedHeadersStr = sortedHeaderKeys.map(k => k.toLowerCase()).join(';')

  // Hash payload
  const payloadHash = await sha256(body)

  // Create canonical request
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join('\n')

  const canonicalRequestHash = await sha256(canonicalRequest)

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256'
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n')

  // Calculate signature
  const signingKey = await getSigningKey(credentials.secretAccessKey, dateStamp, region, service)
  const signatureBuffer = await hmacSha256(signingKey, stringToSign)
  const signature = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

  // Create authorization header
  const authorization = `${algorithm} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`

  return {
    ...signedHeaders,
    authorization,
  }
}

// ============================================================================
// Native DynamoDB Client
// ============================================================================

/**
 * Native DynamoDB HTTP Client
 *
 * Uses AWS Signature V4 and native fetch for zero-dependency DynamoDB access.
 */
export class DynamoDBClient {
  private config: DynamoDBClientConfig
  private endpoint: string
  private credentials: DynamoDBCredentials

  constructor(config: DynamoDBClientConfig) {
    this.config = config
    this.endpoint = config.endpoint ?? `https://dynamodb.${config.region}.amazonaws.com`

    // Get credentials from config or environment
    this.credentials = config.credentials ?? {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
      sessionToken: process.env.AWS_SESSION_TOKEN,
    }

    if (!this.credentials.accessKeyId || !this.credentials.secretAccessKey) {
      throw new Error('AWS credentials not provided. Set credentials in config or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY environment variables.')
    }
  }

  /**
   * Execute a DynamoDB API operation
   */
  private async execute(operation: string, input: any): Promise<any> {
    const url = new URL(this.endpoint)
    const body = JSON.stringify(input)

    const headers: Record<string, string> = {
      'content-type': 'application/x-amz-json-1.0',
      'x-amz-target': `DynamoDB_20120810.${operation}`,
    }

    const signedHeaders = await signRequest(
      'POST',
      url,
      headers,
      body,
      this.credentials,
      this.config.region,
      'dynamodb',
    )

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: signedHeaders,
      body,
    })

    if (!response.ok) {
      const errorBody = await response.text()
      let errorMessage: string
      try {
        const errorJson = JSON.parse(errorBody)
        errorMessage = errorJson.message ?? errorJson.Message ?? errorBody
      }
      catch {
        errorMessage = errorBody
      }
      throw new Error(`DynamoDB ${operation} failed: ${response.status} - ${errorMessage}`)
    }

    return response.json()
  }

  /**
   * Query - Retrieve items from a table or index using key conditions
   */
  async query(input: DynamoDBQueryInput): Promise<DynamoDBQueryOutput> {
    return this.execute('Query', input)
  }

  /**
   * Scan - Retrieve all items from a table or index
   */
  async scan(input: DynamoDBScanInput): Promise<DynamoDBQueryOutput> {
    return this.execute('Scan', input)
  }

  /**
   * GetItem - Retrieve a single item by primary key
   */
  async getItem(input: DynamoDBGetItemInput): Promise<DynamoDBGetItemOutput> {
    return this.execute('GetItem', input)
  }

  /**
   * PutItem - Create or replace an item
   */
  async putItem(input: DynamoDBPutItemInput): Promise<DynamoDBPutItemOutput> {
    return this.execute('PutItem', input)
  }

  /**
   * UpdateItem - Modify an existing item's attributes
   */
  async updateItem(input: DynamoDBUpdateItemInput): Promise<DynamoDBUpdateItemOutput> {
    return this.execute('UpdateItem', input)
  }

  /**
   * DeleteItem - Remove an item by primary key
   */
  async deleteItem(input: DynamoDBDeleteItemInput): Promise<DynamoDBDeleteItemOutput> {
    return this.execute('DeleteItem', input)
  }

  /**
   * BatchGetItem - Retrieve multiple items across tables
   */
  async batchGetItem(input: DynamoDBBatchGetItemInput): Promise<{ Responses?: Record<string, Record<string, any>[]>, UnprocessedKeys?: any }> {
    return this.execute('BatchGetItem', input)
  }

  /**
   * BatchWriteItem - Put or delete multiple items across tables
   */
  async batchWriteItem(input: DynamoDBBatchWriteItemInput): Promise<{ UnprocessedItems?: any }> {
    return this.execute('BatchWriteItem', input)
  }

  /**
   * TransactWriteItems - Perform transactional writes
   */
  async transactWriteItems(input: DynamoDBTransactWriteItemsInput): Promise<{}> {
    return this.execute('TransactWriteItems', input)
  }

  /**
   * DescribeTable - Get table metadata
   */
  async describeTable(tableName: string): Promise<any> {
    return this.execute('DescribeTable', { TableName: tableName })
  }

  /**
   * CreateTable - Create a new table
   */
  async createTable(input: any): Promise<any> {
    return this.execute('CreateTable', input)
  }

  /**
   * DeleteTable - Delete a table
   */
  async deleteTable(tableName: string): Promise<any> {
    return this.execute('DeleteTable', { TableName: tableName })
  }

  /**
   * ListTables - List all tables
   */
  async listTables(input?: { ExclusiveStartTableName?: string, Limit?: number }): Promise<{ TableNames: string[], LastEvaluatedTableName?: string }> {
    return this.execute('ListTables', input ?? {})
  }
}

/**
 * Create a native DynamoDB client
 */
export function createClient(config: DynamoDBClientConfig): DynamoDBClient {
  return new DynamoDBClient(config)
}
