/**
 * Browser Query Builder
 *
 * A browser-compatible query builder that mirrors the bun-query-builder API
 * but translates queries into fetch() API calls instead of direct database queries.
 *
 * This enables the same fluent API to work in both server (direct DB) and
 * browser (via REST API) environments.
 *
 * Usage:
 *   // Configure once at app startup
 *   configureBrowser({
 *     baseUrl: 'http://localhost:3000/api',
 *     getToken: () => localStorage.getItem('auth_token'),
 *   })
 *
 *   // Use the same API as server-side query builder
 *   const users = await browserQuery('users').where('active', '=', true).get()
 *   const user = await browserQuery('users').find(1)
 *   const newUser = await browserQuery('users').create({ name: 'John', email: 'john@example.com' })
 *
 * Model-based usage (with type inference):
 *   const User = createBrowserModel({
 *     name: 'User',
 *     table: 'users',
 *     attributes: {
 *       name: { fillable: true, factory: () => 'Test' },
 *       role: { fillable: true, factory: (): 'admin' | 'user' => 'user' },
 *     }
 *   } as const)
 *
 *   const user = await User.find(1)
 *   user?.role // type: 'admin' | 'user'
 */

import type { BrowserConfig } from './types'

// ============================================================================
// Type inference system (mirrors orm.ts)
// ============================================================================

// Primitive type mappings
type PrimitiveTypeMap = {
  string: string
  number: number
  boolean: boolean
  date: Date
  json: Record<string, unknown>
}

// Infer the actual TS type from attribute type definition
type InferType<T> =
  T extends keyof PrimitiveTypeMap ? PrimitiveTypeMap[T] :
  T extends readonly (infer U)[] ? U :
  T extends (infer U)[] ? U :
  unknown

// Attribute definition with explicit type
export interface BrowserTypedAttribute<T = unknown> {
  type?: T
  order?: number
  fillable?: boolean
  unique?: boolean
  hidden?: boolean
  guarded?: boolean
  nullable?: boolean
  default?: InferType<T>
  validation?: {
    rule: unknown
    message?: Record<string, string>
  }
  factory?: (faker: unknown) => InferType<T>
}

// Base model definition for browser
export interface BrowserModelDefinition {
  readonly name: string
  readonly table: string
  readonly primaryKey?: string
  readonly traits?: {
    readonly useUuid?: boolean
    readonly useTimestamps?: boolean
    readonly useSoftDeletes?: boolean
    readonly useApi?: {
      readonly uri: string
      readonly routes?: readonly string[]
    }
  }
  readonly attributes: {
    readonly [key: string]: BrowserTypedAttribute<unknown>
  }
}

// Extract attribute keys from definition
type BrowserAttributeKeys<TDef extends BrowserModelDefinition> = keyof TDef['attributes'] & string

// Infer single attribute type
type InferBrowserAttributeType<TAttr> =
  TAttr extends { type: infer T } ? InferType<T> :
  TAttr extends { factory: (faker: unknown) => infer R } ? R :
  unknown

// Build the full attributes type from definition
type InferBrowserModelAttributes<TDef extends BrowserModelDefinition> = {
  [K in BrowserAttributeKeys<TDef>]: InferBrowserAttributeType<TDef['attributes'][K]>
}

// System fields added by traits
type BrowserSystemFields<TDef extends BrowserModelDefinition> =
  { id: number } &
  (TDef['traits'] extends { useUuid: true } ? { uuid: string } : {}) &
  (TDef['traits'] extends { useTimestamps: true } ? { created_at: string; updated_at: string } : {}) &
  (TDef['traits'] extends { useSoftDeletes: true } ? { deleted_at: string | null } : {})

// Complete model type
type BrowserModelAttributes<TDef extends BrowserModelDefinition> =
  InferBrowserModelAttributes<TDef> & BrowserSystemFields<TDef>

// All valid column names
type BrowserColumnName<TDef extends BrowserModelDefinition> =
  | BrowserAttributeKeys<TDef>
  | 'id'
  | (TDef['traits'] extends { useUuid: true } ? 'uuid' : never)
  | (TDef['traits'] extends { useTimestamps: true } ? 'created_at' | 'updated_at' : never)
  | (TDef['traits'] extends { useSoftDeletes: true } ? 'deleted_at' : never)

// Hidden fields
type BrowserHiddenKeys<TDef extends BrowserModelDefinition> = {
  [K in BrowserAttributeKeys<TDef>]: TDef['attributes'][K] extends { hidden: true } ? K : never
}[BrowserAttributeKeys<TDef>]

// Fillable fields
type BrowserFillableKeys<TDef extends BrowserModelDefinition> = {
  [K in BrowserAttributeKeys<TDef>]: TDef['attributes'][K] extends { fillable: true } ? K : never
}[BrowserAttributeKeys<TDef>]

// ============================================================================
// Browser configuration
// ============================================================================

// Global browser configuration
let browserConfig: BrowserConfig = {
  baseUrl: '',
}

/**
 * Configure the browser query client
 */
export function configureBrowser(config: Partial<BrowserConfig>): void {
  browserConfig = { ...browserConfig, ...config }
}

/**
 * Get the current browser configuration
 */
export function getBrowserConfig(): BrowserConfig {
  return browserConfig
}

/**
 * Check if we're in a browser environment
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

/**
 * Get the current auth token
 */
async function getAuthToken(): Promise<string | null> {
  if (browserConfig.getToken) {
    const token = browserConfig.getToken()
    return token instanceof Promise ? token : token
  }
  // Default: get from localStorage if available
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('auth_token')
  }
  return null
}

/**
 * Build fetch headers with auth
 */
async function buildHeaders(): Promise<HeadersInit> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...browserConfig.headers,
  }

  const token = await getAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  return headers
}

/**
 * Handle API response
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    browserConfig.onUnauthorized?.()
    throw new BrowserQueryError('Unauthorized', 401)
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }))
    throw new BrowserQueryError(error.message || `HTTP ${response.status}`, response.status)
  }

  const data = await response.json()

  // Apply response transform if configured
  if (browserConfig.transformResponse) {
    return browserConfig.transformResponse(data)
  }

  return data
}

/**
 * Custom error class for browser query errors
 */
export class BrowserQueryError extends Error {
  public status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'BrowserQueryError'
    this.status = status
  }
}

// Types for query building
export type WhereOperator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like' | 'in' | 'not in' | 'is' | 'is not'

interface WhereClause {
  column: string
  operator: WhereOperator
  value: any
  boolean: 'and' | 'or'
}

interface OrderByClause {
  column: string
  direction: 'asc' | 'desc'
}

interface QueryState {
  table: string
  wheres: WhereClause[]
  orderBy: OrderByClause[]
  limitValue?: number
  offsetValue?: number
  selectColumns: string[]
  withRelations: string[]
}

/**
 * Browser Query Builder
 * Fluent API that builds queries and executes them via fetch
 */
export class BrowserQueryBuilder<T = any> {
  private state: QueryState

  constructor(table: string) {
    this.state = {
      table,
      wheres: [],
      orderBy: [],
      selectColumns: ['*'],
      withRelations: [],
    }
  }

  /**
   * Select specific columns
   */
  select(...columns: string[]): this {
    this.state.selectColumns = columns
    return this
  }

  /**
   * Add a where clause
   */
  where(column: string, operatorOrValue: WhereOperator | any, value?: any): this {
    if (value === undefined) {
      // where('column', value) shorthand for equality
      this.state.wheres.push({
        column,
        operator: '=',
        value: operatorOrValue,
        boolean: 'and',
      })
    }
    else {
      // where('column', '=', value)
      this.state.wheres.push({
        column,
        operator: operatorOrValue as WhereOperator,
        value,
        boolean: 'and',
      })
    }
    return this
  }

  /**
   * Add an OR where clause
   */
  orWhere(column: string, operatorOrValue: WhereOperator | any, value?: any): this {
    if (value === undefined) {
      this.state.wheres.push({
        column,
        operator: '=',
        value: operatorOrValue,
        boolean: 'or',
      })
    }
    else {
      this.state.wheres.push({
        column,
        operator: operatorOrValue as WhereOperator,
        value,
        boolean: 'or',
      })
    }
    return this
  }

  /**
   * Add an AND where clause (alias for where)
   */
  andWhere(column: string, operatorOrValue: WhereOperator | any, value?: any): this {
    return this.where(column, operatorOrValue, value)
  }

  /**
   * Where column is NULL
   */
  whereNull(column: string): this {
    return this.where(column, 'is', null)
  }

  /**
   * Where column is NOT NULL
   */
  whereNotNull(column: string): this {
    return this.where(column, 'is not', null)
  }

  /**
   * Where column is in array
   */
  whereIn(column: string, values: any[]): this {
    return this.where(column, 'in', values)
  }

  /**
   * Where column is not in array
   */
  whereNotIn(column: string, values: any[]): this {
    return this.where(column, 'not in', values)
  }

  /**
   * Order by a column
   */
  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.state.orderBy.push({ column, direction })
    return this
  }

  /**
   * Order by descending
   */
  orderByDesc(column: string): this {
    return this.orderBy(column, 'desc')
  }

  /**
   * Order by latest (descending by created_at)
   */
  latest(column: string = 'created_at'): this {
    return this.orderBy(column, 'desc')
  }

  /**
   * Order by oldest (ascending by created_at)
   */
  oldest(column: string = 'created_at'): this {
    return this.orderBy(column, 'asc')
  }

  /**
   * Limit results
   */
  limit(count: number): this {
    this.state.limitValue = count
    return this
  }

  /**
   * Skip/offset results
   */
  offset(count: number): this {
    this.state.offsetValue = count
    return this
  }

  /**
   * Skip results (alias for offset)
   */
  skip(count: number): this {
    return this.offset(count)
  }

  /**
   * Take results (alias for limit)
   */
  take(count: number): this {
    return this.limit(count)
  }

  /**
   * Load relations (eager loading)
   */
  with(...relations: string[]): this {
    this.state.withRelations.push(...relations)
    return this
  }

  /**
   * Build query params from state
   */
  private buildQueryParams(): URLSearchParams {
    const params = new URLSearchParams()

    // Add where clauses as query params
    for (const where of this.state.wheres) {
      if (where.operator === '=') {
        params.append(where.column, String(where.value))
      }
      else if (where.operator === 'in' && Array.isArray(where.value)) {
        params.append(`${where.column}[]`, where.value.join(','))
      }
      else if (where.operator === 'is' && where.value === null) {
        params.append(`filter[${where.column}][is]`, 'null')
      }
      else if (where.operator === 'is not' && where.value === null) {
        params.append(`filter[${where.column}][is_not]`, 'null')
      }
      else {
        // For complex operators, use filter syntax
        params.append(`filter[${where.column}][${where.operator}]`, String(where.value))
      }
    }

    // Add ordering
    if (this.state.orderBy.length > 0) {
      const orderStr = this.state.orderBy
        .map(o => `${o.direction === 'desc' ? '-' : ''}${o.column}`)
        .join(',')
      params.append('sort', orderStr)
    }

    // Add pagination
    if (this.state.limitValue !== undefined) {
      params.append('limit', String(this.state.limitValue))
    }
    if (this.state.offsetValue !== undefined) {
      params.append('offset', String(this.state.offsetValue))
    }

    // Add column selection
    if (this.state.selectColumns.length > 0 && !this.state.selectColumns.includes('*')) {
      params.append('fields', this.state.selectColumns.join(','))
    }

    // Add relations
    if (this.state.withRelations.length > 0) {
      params.append('include', this.state.withRelations.join(','))
    }

    return params
  }

  /**
   * Build the API URL
   */
  private buildUrl(path?: string | number): string {
    const base = `${browserConfig.baseUrl}/${this.state.table}`
    if (path !== undefined) {
      return `${base}/${path}`
    }
    const params = this.buildQueryParams()
    const queryString = params.toString()
    return queryString ? `${base}?${queryString}` : base
  }

  /**
   * Execute GET request and return all results
   */
  async get(): Promise<T[]> {
    const url = this.buildUrl()
    const response = await fetch(url, {
      method: 'GET',
      headers: await buildHeaders(),
    })
    const result = await handleResponse<{ data: T[] } | T[]>(response)
    return Array.isArray(result) ? result : result.data
  }

  /**
   * Execute and return first result
   */
  async first(): Promise<T | null> {
    this.limit(1)
    const results = await this.get()
    return results[0] ?? null
  }

  /**
   * Execute and return first result or throw
   */
  async firstOrFail(): Promise<T> {
    const result = await this.first()
    if (!result) {
      throw new BrowserQueryError(`No ${this.state.table} found`, 404)
    }
    return result
  }

  /**
   * Find by ID
   */
  async find(id: number | string): Promise<T | null> {
    const url = this.buildUrl(id)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: await buildHeaders(),
      })
      if (response.status === 404) {
        return null
      }
      const result = await handleResponse<{ data: T } | T>(response)
      return 'data' in result && !Array.isArray(result.data) ? result.data : result as T
    }
    catch {
      return null
    }
  }

  /**
   * Find by ID or throw
   */
  async findOrFail(id: number | string): Promise<T> {
    const result = await this.find(id)
    if (!result) {
      throw new BrowserQueryError(`${this.state.table} with id ${id} not found`, 404)
    }
    return result
  }

  /**
   * Get count
   */
  async count(): Promise<number> {
    const params = this.buildQueryParams()
    params.append('count', 'true')
    const url = `${browserConfig.baseUrl}/${this.state.table}?${params.toString()}`
    const response = await fetch(url, {
      method: 'GET',
      headers: await buildHeaders(),
    })
    const result = await handleResponse<{ count: number }>(response)
    return result.count
  }

  /**
   * Check if any records exist
   */
  async exists(): Promise<boolean> {
    const count = await this.count()
    return count > 0
  }

  /**
   * Create a new record
   */
  async create(data: Partial<T>): Promise<T> {
    const url = `${browserConfig.baseUrl}/${this.state.table}`
    const body = browserConfig.transformRequest ? browserConfig.transformRequest(data) : data
    const response = await fetch(url, {
      method: 'POST',
      headers: await buildHeaders(),
      body: JSON.stringify(body),
    })
    const result = await handleResponse<{ data: T } | T>(response)
    return 'data' in result && !Array.isArray(result.data) ? result.data : result as T
  }

  /**
   * Insert alias for create
   */
  async insert(data: Partial<T>): Promise<T> {
    return this.create(data)
  }

  /**
   * Update a record by ID
   */
  async update(id: number | string, data: Partial<T>): Promise<T> {
    const url = `${browserConfig.baseUrl}/${this.state.table}/${id}`
    const body = browserConfig.transformRequest ? browserConfig.transformRequest(data) : data
    const response = await fetch(url, {
      method: 'PATCH',
      headers: await buildHeaders(),
      body: JSON.stringify(body),
    })
    const result = await handleResponse<{ data: T } | T>(response)
    return 'data' in result && !Array.isArray(result.data) ? result.data : result as T
  }

  /**
   * Delete a record by ID
   */
  async delete(id: number | string): Promise<boolean> {
    const url = `${browserConfig.baseUrl}/${this.state.table}/${id}`
    const response = await fetch(url, {
      method: 'DELETE',
      headers: await buildHeaders(),
    })
    return response.ok
  }

  /**
   * Destroy alias for delete
   */
  async destroy(id: number | string): Promise<boolean> {
    return this.delete(id)
  }

  /**
   * Paginate results
   */
  async paginate(page: number = 1, perPage: number = 15): Promise<{
    data: T[]
    total: number
    page: number
    perPage: number
    lastPage: number
  }> {
    this.limit(perPage).offset((page - 1) * perPage)
    const params = this.buildQueryParams()
    params.append('paginate', 'true')

    const url = `${browserConfig.baseUrl}/${this.state.table}?${params.toString()}`
    const response = await fetch(url, {
      method: 'GET',
      headers: await buildHeaders(),
    })
    return handleResponse(response)
  }

  /**
   * Get the current query state (useful for debugging)
   */
  toState(): QueryState {
    return { ...this.state }
  }
}

/**
 * Create a browser query builder for a table
 */
export function browserQuery<T = any>(table: string): BrowserQueryBuilder<T> {
  return new BrowserQueryBuilder<T>(table)
}

/**
 * Shorthand for common tables - creates a factory function
 */
export function createBrowserDb<Tables extends Record<string, any>>(): {
  [K in keyof Tables]: () => BrowserQueryBuilder<Tables[K]>
} {
  return new Proxy({} as any, {
    get: (_target, prop: string) => {
      return () => browserQuery(prop)
    },
  })
}

// ============================================================================
// Typed Browser Model Query Builder (mirrors orm.ts ModelQueryBuilder)
// ============================================================================

/**
 * Browser Model Instance - represents a single record with type-safe access
 */
class BrowserModelInstance<
  TDef extends BrowserModelDefinition,
  TSelected extends BrowserColumnName<TDef> = BrowserColumnName<TDef>
> {
  private _attributes: Record<string, unknown>
  private _definition: TDef

  constructor(definition: TDef, attributes: Partial<BrowserModelAttributes<TDef>> = {}) {
    this._definition = definition
    this._attributes = { ...attributes }
  }

  get<K extends TSelected>(key: K): K extends keyof BrowserModelAttributes<TDef> ? BrowserModelAttributes<TDef>[K] : never {
    return this._attributes[key as string] as any
  }

  set<K extends BrowserAttributeKeys<TDef>>(
    key: K,
    value: BrowserModelAttributes<TDef>[K]
  ): void {
    this._attributes[key as string] = value
  }

  get attributes(): Pick<BrowserModelAttributes<TDef>, TSelected & keyof BrowserModelAttributes<TDef>> {
    return { ...this._attributes } as any
  }

  get id(): number {
    const pk = this._definition.primaryKey || 'id'
    return this._attributes[pk] as number
  }

  toJSON(): Omit<Pick<BrowserModelAttributes<TDef>, TSelected & keyof BrowserModelAttributes<TDef>>, BrowserHiddenKeys<TDef>> {
    const hidden = new Set<string>()
    for (const [key, attr] of Object.entries(this._definition.attributes)) {
      if (attr.hidden) hidden.add(key)
    }

    const json: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(this._attributes)) {
      if (!hidden.has(key)) json[key] = value
    }
    return json as any
  }
}

/**
 * Typed Browser Query Builder with precise type narrowing
 */
class BrowserModelQueryBuilder<
  TDef extends BrowserModelDefinition,
  TSelected extends BrowserColumnName<TDef> = BrowserColumnName<TDef>
> {
  private _definition: TDef
  private _wheres: { column: string; operator: WhereOperator; value: unknown; boolean: 'and' | 'or' }[] = []
  private _orderBy: { column: string; direction: 'asc' | 'desc' }[] = []
  private _limit?: number
  private _offset?: number
  private _select: string[] = ['*']
  private _withRelations: string[] = []

  constructor(definition: TDef) {
    this._definition = definition
  }

  private getTablePath(): string {
    return this._definition.traits?.useApi?.uri || this._definition.table
  }

  where<K extends BrowserColumnName<TDef>>(
    column: K,
    operatorOrValue: WhereOperator | (K extends keyof BrowserModelAttributes<TDef> ? BrowserModelAttributes<TDef>[K] : unknown),
    value?: K extends keyof BrowserModelAttributes<TDef> ? BrowserModelAttributes<TDef>[K] : unknown
  ): BrowserModelQueryBuilder<TDef, TSelected> {
    if (value === undefined) {
      this._wheres.push({ column: column as string, operator: '=', value: operatorOrValue, boolean: 'and' })
    } else {
      this._wheres.push({ column: column as string, operator: operatorOrValue as WhereOperator, value, boolean: 'and' })
    }
    return this
  }

  orWhere<K extends BrowserColumnName<TDef>>(
    column: K,
    operatorOrValue: WhereOperator | (K extends keyof BrowserModelAttributes<TDef> ? BrowserModelAttributes<TDef>[K] : unknown),
    value?: K extends keyof BrowserModelAttributes<TDef> ? BrowserModelAttributes<TDef>[K] : unknown
  ): BrowserModelQueryBuilder<TDef, TSelected> {
    if (value === undefined) {
      this._wheres.push({ column: column as string, operator: '=', value: operatorOrValue, boolean: 'or' })
    } else {
      this._wheres.push({ column: column as string, operator: operatorOrValue as WhereOperator, value, boolean: 'or' })
    }
    return this
  }

  whereIn<K extends BrowserColumnName<TDef>>(
    column: K,
    values: (K extends keyof BrowserModelAttributes<TDef> ? BrowserModelAttributes<TDef>[K] : unknown)[]
  ): BrowserModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'in', value: values, boolean: 'and' })
    return this
  }

  whereNotIn<K extends BrowserColumnName<TDef>>(
    column: K,
    values: (K extends keyof BrowserModelAttributes<TDef> ? BrowserModelAttributes<TDef>[K] : unknown)[]
  ): BrowserModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'not in', value: values, boolean: 'and' })
    return this
  }

  whereNull<K extends BrowserColumnName<TDef>>(column: K): BrowserModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'is', value: null, boolean: 'and' })
    return this
  }

  whereNotNull<K extends BrowserColumnName<TDef>>(column: K): BrowserModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'is not', value: null, boolean: 'and' })
    return this
  }

  whereLike<K extends BrowserColumnName<TDef>>(column: K, pattern: string): BrowserModelQueryBuilder<TDef, TSelected> {
    this._wheres.push({ column: column as string, operator: 'like', value: pattern, boolean: 'and' })
    return this
  }

  orderBy<K extends BrowserColumnName<TDef>>(column: K, direction: 'asc' | 'desc' = 'asc'): BrowserModelQueryBuilder<TDef, TSelected> {
    this._orderBy.push({ column: column as string, direction })
    return this
  }

  orderByDesc<K extends BrowserColumnName<TDef>>(column: K): BrowserModelQueryBuilder<TDef, TSelected> {
    return this.orderBy(column, 'desc')
  }

  orderByAsc<K extends BrowserColumnName<TDef>>(column: K): BrowserModelQueryBuilder<TDef, TSelected> {
    return this.orderBy(column, 'asc')
  }

  limit(count: number): BrowserModelQueryBuilder<TDef, TSelected> {
    this._limit = count
    return this
  }

  take(count: number): BrowserModelQueryBuilder<TDef, TSelected> {
    return this.limit(count)
  }

  offset(count: number): BrowserModelQueryBuilder<TDef, TSelected> {
    this._offset = count
    return this
  }

  skip(count: number): BrowserModelQueryBuilder<TDef, TSelected> {
    return this.offset(count)
  }

  select<K extends BrowserColumnName<TDef>>(...columns: K[]): BrowserModelQueryBuilder<TDef, K> {
    this._select = columns as string[]
    return this as unknown as BrowserModelQueryBuilder<TDef, K>
  }

  with(...relations: string[]): BrowserModelQueryBuilder<TDef, TSelected> {
    this._withRelations.push(...relations)
    return this
  }

  latest(column: BrowserColumnName<TDef> = 'created_at' as BrowserColumnName<TDef>): BrowserModelQueryBuilder<TDef, TSelected> {
    return this.orderByDesc(column)
  }

  oldest(column: BrowserColumnName<TDef> = 'created_at' as BrowserColumnName<TDef>): BrowserModelQueryBuilder<TDef, TSelected> {
    return this.orderByAsc(column)
  }

  private buildQueryParams(): URLSearchParams {
    const params = new URLSearchParams()

    for (const where of this._wheres) {
      if (where.operator === '=') {
        params.append(where.column, String(where.value))
      } else if ((where.operator === 'in' || where.operator === 'not in') && Array.isArray(where.value)) {
        params.append(`${where.column}[]`, where.value.join(','))
      } else if (where.operator === 'is' && where.value === null) {
        params.append(`filter[${where.column}][is]`, 'null')
      } else if (where.operator === 'is not' && where.value === null) {
        params.append(`filter[${where.column}][is_not]`, 'null')
      } else {
        params.append(`filter[${where.column}][${where.operator}]`, String(where.value))
      }
    }

    if (this._orderBy.length > 0) {
      const orderStr = this._orderBy
        .map(o => `${o.direction === 'desc' ? '-' : ''}${o.column}`)
        .join(',')
      params.append('sort', orderStr)
    }

    if (this._limit !== undefined) params.append('limit', String(this._limit))
    if (this._offset !== undefined) params.append('offset', String(this._offset))

    if (this._select.length > 0 && !this._select.includes('*')) {
      params.append('fields', this._select.join(','))
    }

    if (this._withRelations.length > 0) {
      params.append('include', this._withRelations.join(','))
    }

    return params
  }

  private buildUrl(path?: string | number): string {
    const base = `${browserConfig.baseUrl}/${this.getTablePath()}`
    if (path !== undefined) return `${base}/${path}`
    const params = this.buildQueryParams()
    const queryString = params.toString()
    return queryString ? `${base}?${queryString}` : base
  }

  async get(): Promise<BrowserModelInstance<TDef, TSelected>[]> {
    const url = this.buildUrl()
    const response = await fetch(url, {
      method: 'GET',
      headers: await buildHeaders(),
    })
    const result = await handleResponse<{ data: Record<string, unknown>[] } | Record<string, unknown>[]>(response)
    const rows = Array.isArray(result) ? result : result.data
    return rows.map(row => new BrowserModelInstance<TDef, TSelected>(this._definition, row as any))
  }

  async first(): Promise<BrowserModelInstance<TDef, TSelected> | null> {
    this._limit = 1
    const results = await this.get()
    return results[0] ?? null
  }

  async firstOrFail(): Promise<BrowserModelInstance<TDef, TSelected>> {
    const result = await this.first()
    if (!result) throw new BrowserQueryError(`No ${this._definition.name} found`, 404)
    return result
  }

  async find(id: number | string): Promise<BrowserModelInstance<TDef, TSelected> | null> {
    const url = this.buildUrl(id)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: await buildHeaders(),
      })
      if (response.status === 404) return null
      const result = await handleResponse<{ data: Record<string, unknown> } | Record<string, unknown>>(response)
      const row = 'data' in result && !Array.isArray(result.data) ? result.data : result as Record<string, unknown>
      return new BrowserModelInstance<TDef, TSelected>(this._definition, row as any)
    } catch {
      return null
    }
  }

  async findOrFail(id: number | string): Promise<BrowserModelInstance<TDef, TSelected>> {
    const result = await this.find(id)
    if (!result) throw new BrowserQueryError(`${this._definition.name} with id ${id} not found`, 404)
    return result
  }

  async count(): Promise<number> {
    const params = this.buildQueryParams()
    params.append('count', 'true')
    const url = `${browserConfig.baseUrl}/${this.getTablePath()}?${params.toString()}`
    const response = await fetch(url, {
      method: 'GET',
      headers: await buildHeaders(),
    })
    const result = await handleResponse<{ count: number }>(response)
    return result.count
  }

  async exists(): Promise<boolean> {
    const count = await this.count()
    return count > 0
  }

  async pluck<K extends BrowserColumnName<TDef>>(
    column: K
  ): Promise<(K extends keyof BrowserModelAttributes<TDef> ? BrowserModelAttributes<TDef>[K] : unknown)[]> {
    this._select = [column as string]
    const results = await this.get()
    return results.map(r => r.get(column as any)) as any
  }

  async paginate(page = 1, perPage = 15): Promise<{
    data: BrowserModelInstance<TDef, TSelected>[]
    total: number
    page: number
    perPage: number
    lastPage: number
  }> {
    this._limit = perPage
    this._offset = (page - 1) * perPage
    const params = this.buildQueryParams()
    params.append('paginate', 'true')

    const url = `${browserConfig.baseUrl}/${this.getTablePath()}?${params.toString()}`
    const response = await fetch(url, {
      method: 'GET',
      headers: await buildHeaders(),
    })
    const result = await handleResponse<{
      data: Record<string, unknown>[]
      total: number
      page: number
      perPage: number
      lastPage: number
    }>(response)

    return {
      ...result,
      data: result.data.map(row => new BrowserModelInstance<TDef, TSelected>(this._definition, row as any)),
    }
  }
}

/**
 * Create a browser model from a definition with full type inference
 *
 * @example
 * ```ts
 * const roles = ['admin', 'user', 'moderator'] as const
 *
 * const User = createBrowserModel({
 *   name: 'User',
 *   table: 'users',
 *   traits: {
 *     useTimestamps: true,
 *     useApi: { uri: 'users' }
 *   },
 *   attributes: {
 *     name: { fillable: true, factory: () => 'John' },
 *     email: { fillable: true, factory: () => 'john@example.com' },
 *     role: { fillable: true, factory: (): typeof roles[number] => 'user' },
 *   }
 * } as const)
 *
 * // Full type inference:
 * const user = await User.find(1)
 * user?.get('role') // type: 'admin' | 'user' | 'moderator'
 *
 * const roles = await User.pluck('role')
 * // type: ('admin' | 'user' | 'moderator')[]
 * ```
 */
export function createBrowserModel<const TDef extends BrowserModelDefinition>(definition: TDef) {
  type Attrs = BrowserModelAttributes<TDef>
  type Cols = BrowserColumnName<TDef>
  type AttrKeys = BrowserAttributeKeys<TDef>
  type Fillable = BrowserFillableKeys<TDef>

  const model = {
    query: () => new BrowserModelQueryBuilder<TDef>(definition),

    where<K extends Cols>(
      column: K,
      operatorOrValue: WhereOperator | (K extends keyof Attrs ? Attrs[K] : unknown),
      value?: K extends keyof Attrs ? Attrs[K] : unknown
    ) {
      return new BrowserModelQueryBuilder<TDef>(definition).where(column, operatorOrValue as any, value)
    },

    orWhere<K extends Cols>(
      column: K,
      operatorOrValue: WhereOperator | (K extends keyof Attrs ? Attrs[K] : unknown),
      value?: K extends keyof Attrs ? Attrs[K] : unknown
    ) {
      return new BrowserModelQueryBuilder<TDef>(definition).orWhere(column, operatorOrValue as any, value)
    },

    whereIn<K extends Cols>(column: K, values: (K extends keyof Attrs ? Attrs[K] : unknown)[]) {
      return new BrowserModelQueryBuilder<TDef>(definition).whereIn(column, values)
    },

    whereNotIn<K extends Cols>(column: K, values: (K extends keyof Attrs ? Attrs[K] : unknown)[]) {
      return new BrowserModelQueryBuilder<TDef>(definition).whereNotIn(column, values)
    },

    whereNull<K extends Cols>(column: K) {
      return new BrowserModelQueryBuilder<TDef>(definition).whereNull(column)
    },

    whereNotNull<K extends Cols>(column: K) {
      return new BrowserModelQueryBuilder<TDef>(definition).whereNotNull(column)
    },

    whereLike<K extends Cols>(column: K, pattern: string) {
      return new BrowserModelQueryBuilder<TDef>(definition).whereLike(column, pattern)
    },

    orderBy<K extends Cols>(column: K, direction: 'asc' | 'desc' = 'asc') {
      return new BrowserModelQueryBuilder<TDef>(definition).orderBy(column, direction)
    },

    orderByDesc<K extends Cols>(column: K) {
      return new BrowserModelQueryBuilder<TDef>(definition).orderByDesc(column)
    },

    select<K extends Cols>(...columns: K[]) {
      return new BrowserModelQueryBuilder<TDef>(definition).select(...columns)
    },

    limit: (count: number) => new BrowserModelQueryBuilder<TDef>(definition).limit(count),
    take: (count: number) => new BrowserModelQueryBuilder<TDef>(definition).take(count),
    skip: (count: number) => new BrowserModelQueryBuilder<TDef>(definition).skip(count),
    latest: (column: Cols = 'created_at' as Cols) => new BrowserModelQueryBuilder<TDef>(definition).latest(column),
    oldest: (column: Cols = 'created_at' as Cols) => new BrowserModelQueryBuilder<TDef>(definition).oldest(column),

    async find(id: number | string): Promise<BrowserModelInstance<TDef> | null> {
      return new BrowserModelQueryBuilder<TDef>(definition).find(id)
    },

    async findOrFail(id: number | string): Promise<BrowserModelInstance<TDef>> {
      return new BrowserModelQueryBuilder<TDef>(definition).findOrFail(id)
    },

    async all(): Promise<BrowserModelInstance<TDef>[]> {
      return new BrowserModelQueryBuilder<TDef>(definition).get()
    },

    async first(): Promise<BrowserModelInstance<TDef> | null> {
      return new BrowserModelQueryBuilder<TDef>(definition).first()
    },

    async firstOrFail(): Promise<BrowserModelInstance<TDef>> {
      return new BrowserModelQueryBuilder<TDef>(definition).firstOrFail()
    },

    async count(): Promise<number> {
      return new BrowserModelQueryBuilder<TDef>(definition).count()
    },

    async exists(): Promise<boolean> {
      return new BrowserModelQueryBuilder<TDef>(definition).exists()
    },

    async paginate(page?: number, perPage?: number) {
      return new BrowserModelQueryBuilder<TDef>(definition).paginate(page, perPage)
    },

    async pluck<K extends Cols>(column: K) {
      return new BrowserModelQueryBuilder<TDef>(definition).pluck(column)
    },

    async create(data: Partial<Pick<InferBrowserModelAttributes<TDef>, Fillable>>): Promise<BrowserModelInstance<TDef>> {
      const tablePath = definition.traits?.useApi?.uri || definition.table
      const url = `${browserConfig.baseUrl}/${tablePath}`
      const body = browserConfig.transformRequest ? browserConfig.transformRequest(data) : data
      const response = await fetch(url, {
        method: 'POST',
        headers: await buildHeaders(),
        body: JSON.stringify(body),
      })
      const result = await handleResponse<{ data: Record<string, unknown> } | Record<string, unknown>>(response)
      const row = 'data' in result && !Array.isArray(result.data) ? result.data : result as Record<string, unknown>
      return new BrowserModelInstance<TDef>(definition, row as any)
    },

    async update(id: number | string, data: Partial<Pick<InferBrowserModelAttributes<TDef>, Fillable>>): Promise<BrowserModelInstance<TDef>> {
      const tablePath = definition.traits?.useApi?.uri || definition.table
      const url = `${browserConfig.baseUrl}/${tablePath}/${id}`
      const body = browserConfig.transformRequest ? browserConfig.transformRequest(data) : data
      const response = await fetch(url, {
        method: 'PATCH',
        headers: await buildHeaders(),
        body: JSON.stringify(body),
      })
      const result = await handleResponse<{ data: Record<string, unknown> } | Record<string, unknown>>(response)
      const row = 'data' in result && !Array.isArray(result.data) ? result.data : result as Record<string, unknown>
      return new BrowserModelInstance<TDef>(definition, row as any)
    },

    async delete(id: number | string): Promise<boolean> {
      const tablePath = definition.traits?.useApi?.uri || definition.table
      const url = `${browserConfig.baseUrl}/${tablePath}/${id}`
      const response = await fetch(url, {
        method: 'DELETE',
        headers: await buildHeaders(),
      })
      return response.ok
    },

    async destroy(id: number | string): Promise<boolean> {
      return this.delete(id)
    },

    getDefinition: () => definition,
    getTable: () => definition.table,
  }

  // Wrap in Proxy to support dynamic whereColumn methods (e.g., whereEmail, whereName)
  return new Proxy(model, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('where') && prop.length > 5) {
        const columnPascal = prop.slice(5)
        const column = columnPascal.charAt(0).toLowerCase() + columnPascal.slice(1)

        if (column in definition.attributes || column === 'id' || column === definition.primaryKey) {
          return (value: unknown) => new BrowserModelQueryBuilder<TDef>(definition).where(column as Cols, value as any)
        }
      }
      return Reflect.get(target, prop)
    },
  }) as typeof model & {
    [K in AttrKeys as `where${Capitalize<K>}`]: (value: K extends keyof Attrs ? Attrs[K] : unknown) => BrowserModelQueryBuilder<TDef>
  }
}

/**
 * Auth helpers for browser
 */
export const browserAuth = {
  /**
   * Login and store token
   */
  async login(credentials: { email: string, password: string }): Promise<{ user: any, token: string }> {
    const response = await fetch(`${browserConfig.baseUrl}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...browserConfig.headers,
      },
      body: JSON.stringify(credentials),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Login failed' }))
      throw new BrowserQueryError(error.message || 'Login failed', response.status)
    }

    const rawData = await response.json()
    // Handle nested response { data: { token, user } } or flat { token, user }
    const data = rawData.data || rawData

    // Store token in localStorage by default
    if (typeof localStorage !== 'undefined' && data.token) {
      localStorage.setItem('auth_token', data.token)
    }

    return data
  },

  /**
   * Register a new user
   */
  async register(data: { name: string, email: string, password: string }): Promise<{ user: any, token: string }> {
    const response = await fetch(`${browserConfig.baseUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...browserConfig.headers,
      },
      body: JSON.stringify(data),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Registration failed' }))
      throw new BrowserQueryError(error.message || 'Registration failed', response.status)
    }

    const rawResult = await response.json()
    // Handle nested response { data: { token, user } } or flat { token, user }
    const result = rawResult.data || rawResult

    // Store token in localStorage by default
    if (typeof localStorage !== 'undefined' && result.token) {
      localStorage.setItem('auth_token', result.token)
    }

    return result
  },

  /**
   * Logout and clear token
   */
  async logout(): Promise<void> {
    const token = await getAuthToken()

    if (token) {
      try {
        await fetch(`${browserConfig.baseUrl}/logout`, {
          method: 'POST',
          headers: await buildHeaders(),
        })
      }
      catch {
        // Ignore errors on logout
      }
    }

    // Clear token from localStorage
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('auth_token')
    }
  },

  /**
   * Get current authenticated user
   */
  async user(): Promise<any | null> {
    const token = await getAuthToken()
    if (!token) return null

    try {
      const response = await fetch(`${browserConfig.baseUrl}/user`, {
        method: 'GET',
        headers: await buildHeaders(),
      })

      if (response.status === 401) {
        browserConfig.onUnauthorized?.()
        return null
      }

      if (!response.ok) return null

      const data = await response.json()
      return data.user || data
    }
    catch {
      return null
    }
  },

  /**
   * Check if user is authenticated
   */
  async check(): Promise<boolean> {
    const user = await this.user()
    return user !== null
  },

  /**
   * Get the current token
   */
  getToken: getAuthToken,
}

// Export types for external use
export type { BrowserModelInstance, BrowserModelQueryBuilder }

// Export for convenience
export default browserQuery
