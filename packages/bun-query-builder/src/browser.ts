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
 */

import type { BrowserConfig } from './types'

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

// Export for convenience
export default browserQuery
