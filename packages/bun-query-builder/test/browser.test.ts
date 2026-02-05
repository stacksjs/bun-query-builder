/**
 * Browser Query Builder Tests
 *
 * These tests verify the browser module works correctly by:
 * 1. Starting a mock API server
 * 2. Testing all query builder methods
 * 3. Testing auth helpers
 * 4. Testing edge cases and error handling
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import {
  BrowserQueryBuilder,
  BrowserQueryError,
  browserAuth,
  browserQuery,
  configureBrowser,
  createBrowserDb,
  getBrowserConfig,
  isBrowser,
} from '../src/browser'

// Mock data store (simulates database)
interface User {
  id: number
  name: string
  email: string
  password?: string
  active: boolean
  role: string
  created_at: string
  updated_at: string
}

interface Territory {
  id: number
  user_id: number
  name: string
  area_size: number
  status: 'active' | 'contested' | 'expired'
  center_lat: number
  center_lng: number
  created_at: string
}

let mockUsers: User[] = []
let mockTerritories: Territory[] = []
let mockTokens: Map<string, number> = new Map() // token -> userId
let nextUserId = 1
let nextTerritoryId = 1

// Mock server
let server: ReturnType<typeof Bun.serve> | null = null
const TEST_PORT = 9876
const TEST_BASE_URL = `http://localhost:${TEST_PORT}`

function resetMockData() {
  mockUsers = [
    {
      id: 1,
      name: 'John Doe',
      email: 'john@example.com',
      password: 'hashedpassword123',
      active: true,
      role: 'admin',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    },
    {
      id: 2,
      name: 'Jane Smith',
      email: 'jane@example.com',
      password: 'hashedpassword456',
      active: true,
      role: 'user',
      created_at: '2024-01-02T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    },
    {
      id: 3,
      name: 'Bob Wilson',
      email: 'bob@example.com',
      password: 'hashedpassword789',
      active: false,
      role: 'user',
      created_at: '2024-01-03T00:00:00Z',
      updated_at: '2024-01-03T00:00:00Z',
    },
  ]
  mockTerritories = [
    {
      id: 1,
      user_id: 1,
      name: 'Downtown Loop',
      area_size: 45000,
      status: 'active',
      center_lat: 37.7749,
      center_lng: -122.4194,
      created_at: '2024-01-01T00:00:00Z',
    },
    {
      id: 2,
      user_id: 1,
      name: 'Park District',
      area_size: 32500,
      status: 'active',
      center_lat: 37.7849,
      center_lng: -122.4094,
      created_at: '2024-01-02T00:00:00Z',
    },
    {
      id: 3,
      user_id: 2,
      name: 'Riverfront Trail',
      area_size: 78000,
      status: 'contested',
      center_lat: 37.7649,
      center_lng: -122.4294,
      created_at: '2024-01-03T00:00:00Z',
    },
  ]
  mockTokens.clear()
  nextUserId = 4
  nextTerritoryId = 4
}

// Helper to parse query params
function parseQueryParams(url: URL): Record<string, string> {
  const params: Record<string, string> = {}
  url.searchParams.forEach((value, key) => {
    params[key] = value
  })
  return params
}

// Helper to filter data based on query params
function filterData<T extends Record<string, any>>(data: T[], params: Record<string, string>): T[] {
  let result = [...data]

  // Simple equality filters
  for (const [key, value] of Object.entries(params)) {
    if (key === 'sort' || key === 'limit' || key === 'offset' || key === 'fields' || key === 'include' || key === 'count' || key === 'paginate') continue
    if (key.startsWith('filter[')) continue

    // Handle array syntax like user_id[]
    if (key.endsWith('[]')) {
      const field = key.slice(0, -2)
      const values = value.split(',')
      result = result.filter(item => values.includes(String(item[field])))
    }
    else {
      result = result.filter(item => String(item[key]) === value)
    }
  }

  // Handle filter syntax like filter[area_size][>]=10000
  for (const [key, value] of Object.entries(params)) {
    const filterMatch = key.match(/^filter\[(\w+)\]\[([<>=!]+|like|in|not in|is|is_not)\]$/)
    if (filterMatch) {
      const [, field, op] = filterMatch
      result = result.filter((item) => {
        const itemValue = item[field]
        switch (op) {
          case '>': return Number(itemValue) > Number(value)
          case '<': return Number(itemValue) < Number(value)
          case '>=': return Number(itemValue) >= Number(value)
          case '<=': return Number(itemValue) <= Number(value)
          case '!=': return String(itemValue) !== value
          case 'like': return String(itemValue).toLowerCase().includes(value.toLowerCase().replace(/%/g, ''))
          case 'is': return value === 'null' ? itemValue === null : itemValue === value
          case 'is_not': return value === 'null' ? itemValue !== null : itemValue !== value
          default: return true
        }
      })
    }
  }

  // Handle sorting
  if (params.sort) {
    const sorts = params.sort.split(',')
    result.sort((a, b) => {
      for (const sort of sorts) {
        const desc = sort.startsWith('-')
        const field = desc ? sort.slice(1) : sort
        const aVal = a[field]
        const bVal = b[field]
        if (aVal < bVal) return desc ? 1 : -1
        if (aVal > bVal) return desc ? -1 : 1
      }
      return 0
    })
  }

  // Handle offset
  if (params.offset) {
    result = result.slice(Number(params.offset))
  }

  // Handle limit
  if (params.limit) {
    result = result.slice(0, Number(params.limit))
  }

  return result
}

// Mock API server handler
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  const params = parseQueryParams(url)

  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
  }

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Auth check helper
  const getAuthUser = (): User | null => {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return null
    const token = authHeader.slice(7)
    const userId = mockTokens.get(token)
    if (!userId) return null
    return mockUsers.find(u => u.id === userId) || null
  }

  try {
    // Auth endpoints
    if (path === '/login' && method === 'POST') {
      const body = await req.json() as { email: string, password: string }
      const user = mockUsers.find(u => u.email === body.email)
      if (!user) {
        return new Response(JSON.stringify({ message: 'Invalid credentials' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
      const token = `test_token_${Date.now()}_${user.id}`
      mockTokens.set(token, user.id)
      const { password: _, ...userWithoutPassword } = user
      return new Response(JSON.stringify({ data: { token, user: userWithoutPassword } }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    if (path === '/register' && method === 'POST') {
      const body = await req.json() as { name: string, email: string, password: string }
      if (mockUsers.find(u => u.email === body.email)) {
        return new Response(JSON.stringify({ message: 'Email already exists' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
      const newUser: User = {
        id: nextUserId++,
        name: body.name,
        email: body.email,
        password: body.password,
        active: true,
        role: 'user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      mockUsers.push(newUser)
      const token = `test_token_${Date.now()}_${newUser.id}`
      mockTokens.set(token, newUser.id)
      const { password: _, ...userWithoutPassword } = newUser
      return new Response(JSON.stringify({ data: { token, user: userWithoutPassword } }), {
        status: 201,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    if (path === '/logout' && method === 'POST') {
      const authHeader = req.headers.get('Authorization')
      if (authHeader?.startsWith('Bearer ')) {
        mockTokens.delete(authHeader.slice(7))
      }
      return new Response(JSON.stringify({ message: 'Logged out' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    if ((path === '/me' || path === '/user') && method === 'GET') {
      const user = getAuthUser()
      if (!user) {
        return new Response(JSON.stringify({ message: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
      const { password: _, ...userWithoutPassword } = user
      return new Response(JSON.stringify({ user: userWithoutPassword }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Users endpoints
    if (path === '/users' && method === 'GET') {
      if (params.count === 'true') {
        const filtered = filterData(mockUsers, { ...params, limit: '', offset: '' })
        return new Response(JSON.stringify({ count: filtered.length }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
      if (params.paginate === 'true') {
        const allFiltered = filterData(mockUsers, { ...params, limit: '', offset: '' })
        const filtered = filterData(mockUsers, params)
        const page = Math.floor(Number(params.offset || 0) / Number(params.limit || 15)) + 1
        const perPage = Number(params.limit || 15)
        return new Response(JSON.stringify({
          data: filtered.map(u => ({ ...u, password: undefined })),
          total: allFiltered.length,
          page,
          perPage,
          lastPage: Math.ceil(allFiltered.length / perPage),
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
      const filtered = filterData(mockUsers, params)
      return new Response(JSON.stringify({ data: filtered.map(u => ({ ...u, password: undefined })) }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const userIdMatch = path.match(/^\/users\/(\d+)$/)
    if (userIdMatch) {
      const id = Number(userIdMatch[1])
      const user = mockUsers.find(u => u.id === id)

      if (method === 'GET') {
        if (!user) {
          return new Response(JSON.stringify({ message: 'User not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        const { password: _, ...userWithoutPassword } = user
        return new Response(JSON.stringify({ data: userWithoutPassword }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      if (method === 'PATCH' || method === 'PUT') {
        if (!user) {
          return new Response(JSON.stringify({ message: 'User not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        const body = await req.json() as Partial<User>
        Object.assign(user, body, { updated_at: new Date().toISOString() })
        const { password: _, ...userWithoutPassword } = user
        return new Response(JSON.stringify({ data: userWithoutPassword }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      if (method === 'DELETE') {
        const index = mockUsers.findIndex(u => u.id === id)
        if (index === -1) {
          return new Response(JSON.stringify({ message: 'User not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        mockUsers.splice(index, 1)
        return new Response(null, { status: 204, headers: corsHeaders })
      }
    }

    if (path === '/users' && method === 'POST') {
      const body = await req.json() as Partial<User>
      const newUser: User = {
        id: nextUserId++,
        name: body.name || 'New User',
        email: body.email || `user${nextUserId}@example.com`,
        active: body.active ?? true,
        role: body.role || 'user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      mockUsers.push(newUser)
      return new Response(JSON.stringify({ data: newUser }), {
        status: 201,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // Territories endpoints
    if (path === '/territories' && method === 'GET') {
      if (params.count === 'true') {
        const filtered = filterData(mockTerritories, { ...params, limit: '', offset: '' })
        return new Response(JSON.stringify({ count: filtered.length }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
      const filtered = filterData(mockTerritories, params)
      return new Response(JSON.stringify({ data: filtered }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    const territoryIdMatch = path.match(/^\/territories\/(\d+)$/)
    if (territoryIdMatch) {
      const id = Number(territoryIdMatch[1])
      const territory = mockTerritories.find(t => t.id === id)

      if (method === 'GET') {
        if (!territory) {
          return new Response(JSON.stringify({ message: 'Territory not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        return new Response(JSON.stringify({ data: territory }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      if (method === 'PATCH' || method === 'PUT') {
        if (!territory) {
          return new Response(JSON.stringify({ message: 'Territory not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        const body = await req.json() as Partial<Territory>
        Object.assign(territory, body)
        return new Response(JSON.stringify({ data: territory }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      if (method === 'DELETE') {
        const index = mockTerritories.findIndex(t => t.id === id)
        if (index === -1) {
          return new Response(JSON.stringify({ message: 'Territory not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        mockTerritories.splice(index, 1)
        return new Response(null, { status: 204, headers: corsHeaders })
      }
    }

    if (path === '/territories' && method === 'POST') {
      const body = await req.json() as Partial<Territory>
      const newTerritory: Territory = {
        id: nextTerritoryId++,
        user_id: body.user_id || 1,
        name: body.name || 'New Territory',
        area_size: body.area_size || 10000,
        status: body.status || 'active',
        center_lat: body.center_lat || 0,
        center_lng: body.center_lng || 0,
        created_at: new Date().toISOString(),
      }
      mockTerritories.push(newTerritory)
      return new Response(JSON.stringify({ data: newTerritory }), {
        status: 201,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      })
    }

    // 404 for unknown routes
    return new Response(JSON.stringify({ message: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
  catch (error) {
    return new Response(JSON.stringify({ message: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
}

// Start mock server before all tests
beforeAll(() => {
  server = Bun.serve({
    port: TEST_PORT,
    fetch: handleRequest,
  })

  // Configure browser client
  configureBrowser({
    baseUrl: TEST_BASE_URL,
    getToken: () => {
      // Use a mock localStorage for tests
      return (globalThis as any).__testAuthToken || null
    },
  })
})

// Clean up after all tests
afterAll(() => {
  server?.stop()
})

// Reset mock data before each test
beforeEach(() => {
  resetMockData()
  // Clear test auth token
  ;(globalThis as any).__testAuthToken = null
})

// ============================================================================
// BASIC QUERY TESTS
// ============================================================================

describe('BrowserQueryBuilder - Basic Queries', () => {
  it('should fetch all records from a table', async () => {
    const users = await browserQuery('users').get()
    expect(Array.isArray(users)).toBe(true)
    expect(users.length).toBe(3)
    expect(users[0]).toHaveProperty('id')
    expect(users[0]).toHaveProperty('name')
    expect(users[0]).toHaveProperty('email')
  })

  it('should return empty array when no records match', async () => {
    const users = await browserQuery('users').where('email', 'nonexistent@example.com').get()
    expect(Array.isArray(users)).toBe(true)
    expect(users.length).toBe(0)
  })

  it('should fetch a single record by ID with find()', async () => {
    const user = await browserQuery('users').find(1)
    expect(user).not.toBeNull()
    expect(user?.id).toBe(1)
    expect(user?.name).toBe('John Doe')
  })

  it('should return null for non-existent ID with find()', async () => {
    const user = await browserQuery('users').find(999)
    expect(user).toBeNull()
  })

  it('should throw for non-existent ID with findOrFail()', async () => {
    await expect(browserQuery('users').findOrFail(999)).rejects.toThrow()
  })

  it('should fetch first record with first()', async () => {
    const user = await browserQuery('users').first()
    expect(user).not.toBeNull()
    expect(user).toHaveProperty('id')
  })

  it('should return null when first() finds nothing', async () => {
    const user = await browserQuery('users').where('email', 'nonexistent@example.com').first()
    expect(user).toBeNull()
  })

  it('should throw when firstOrFail() finds nothing', async () => {
    await expect(
      browserQuery('users').where('email', 'nonexistent@example.com').firstOrFail(),
    ).rejects.toThrow()
  })
})

// ============================================================================
// WHERE CLAUSE TESTS
// ============================================================================

describe('BrowserQueryBuilder - Where Clauses', () => {
  it('should filter with simple where equality', async () => {
    const users = await browserQuery<User>('users').where('active', true).get()
    expect(users.length).toBe(2)
    expect(users.every(u => u.active === true)).toBe(true)
  })

  it('should filter with where using operator', async () => {
    const users = await browserQuery<User>('users').where('active', '=', true).get()
    expect(users.length).toBe(2)
  })

  it('should filter with where greater than', async () => {
    const territories = await browserQuery<Territory>('territories')
      .where('area_size', '>', 40000)
      .get()
    expect(territories.length).toBe(2)
    expect(territories.every(t => t.area_size > 40000)).toBe(true)
  })

  it('should filter with where less than', async () => {
    const territories = await browserQuery<Territory>('territories')
      .where('area_size', '<', 50000)
      .get()
    expect(territories.length).toBe(2)
    expect(territories.every(t => t.area_size < 50000)).toBe(true)
  })

  it('should chain multiple where clauses', async () => {
    const users = await browserQuery<User>('users')
      .where('active', true)
      .where('role', 'user')
      .get()
    expect(users.length).toBe(1)
    expect(users[0].name).toBe('Jane Smith')
  })

  it('should support andWhere alias', async () => {
    const users = await browserQuery<User>('users')
      .where('active', true)
      .andWhere('role', 'admin')
      .get()
    expect(users.length).toBe(1)
    expect(users[0].name).toBe('John Doe')
  })

  it('should support whereIn', async () => {
    const territories = await browserQuery<Territory>('territories')
      .whereIn('user_id', [1])
      .get()
    expect(territories.length).toBe(2)
    expect(territories.every(t => t.user_id === 1)).toBe(true)
  })
})

// ============================================================================
// ORDER BY TESTS
// ============================================================================

describe('BrowserQueryBuilder - Ordering', () => {
  it('should order by ascending', async () => {
    const territories = await browserQuery<Territory>('territories')
      .orderBy('area_size', 'asc')
      .get()
    expect(territories[0].area_size).toBeLessThanOrEqual(territories[1].area_size)
    expect(territories[1].area_size).toBeLessThanOrEqual(territories[2].area_size)
  })

  it('should order by descending', async () => {
    const territories = await browserQuery<Territory>('territories')
      .orderBy('area_size', 'desc')
      .get()
    expect(territories[0].area_size).toBeGreaterThanOrEqual(territories[1].area_size)
    expect(territories[1].area_size).toBeGreaterThanOrEqual(territories[2].area_size)
  })

  it('should support orderByDesc helper', async () => {
    const territories = await browserQuery<Territory>('territories')
      .orderByDesc('area_size')
      .get()
    expect(territories[0].area_size).toBe(78000) // largest
  })

  it('should support latest() helper', async () => {
    const users = await browserQuery<User>('users').latest().get()
    expect(users[0].created_at).toBe('2024-01-03T00:00:00Z')
  })

  it('should support oldest() helper', async () => {
    const users = await browserQuery<User>('users').oldest().get()
    expect(users[0].created_at).toBe('2024-01-01T00:00:00Z')
  })
})

// ============================================================================
// LIMIT & OFFSET TESTS
// ============================================================================

describe('BrowserQueryBuilder - Pagination', () => {
  it('should limit results', async () => {
    const users = await browserQuery('users').limit(2).get()
    expect(users.length).toBe(2)
  })

  it('should support take() alias', async () => {
    const users = await browserQuery('users').take(1).get()
    expect(users.length).toBe(1)
  })

  it('should offset results', async () => {
    const allUsers = await browserQuery('users').get()
    const offsetUsers = await browserQuery('users').offset(1).get()
    expect(offsetUsers.length).toBe(allUsers.length - 1)
    expect(offsetUsers[0].id).toBe(allUsers[1].id)
  })

  it('should support skip() alias', async () => {
    const users = await browserQuery('users').skip(2).get()
    expect(users.length).toBe(1)
  })

  it('should combine limit and offset', async () => {
    const users = await browserQuery('users').offset(1).limit(1).get()
    expect(users.length).toBe(1)
    expect(users[0].id).toBe(2)
  })

  it('should paginate results', async () => {
    const page1 = await browserQuery<User>('users').paginate(1, 2)
    expect(page1.data.length).toBe(2)
    expect(page1.page).toBe(1)
    expect(page1.perPage).toBe(2)
    expect(page1.total).toBe(3)
    expect(page1.lastPage).toBe(2)

    const page2 = await browserQuery<User>('users').paginate(2, 2)
    expect(page2.data.length).toBe(1)
    expect(page2.page).toBe(2)
  })
})

// ============================================================================
// COUNT & EXISTS TESTS
// ============================================================================

describe('BrowserQueryBuilder - Count & Exists', () => {
  it('should count all records', async () => {
    const count = await browserQuery('users').count()
    expect(count).toBe(3)
  })

  it('should count filtered records', async () => {
    const count = await browserQuery<User>('users').where('active', true).count()
    expect(count).toBe(2)
  })

  it('should check if records exist', async () => {
    const exists = await browserQuery<User>('users').where('active', true).exists()
    expect(exists).toBe(true)
  })

  it('should return false when no records exist', async () => {
    const exists = await browserQuery('users').where('email', 'nonexistent@example.com').exists()
    expect(exists).toBe(false)
  })
})

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

describe('BrowserQueryBuilder - CRUD Operations', () => {
  it('should create a new record', async () => {
    const newUser = await browserQuery<User>('users').create({
      name: 'New User',
      email: 'new@example.com',
      active: true,
      role: 'user',
    })
    expect(newUser).toHaveProperty('id')
    expect(newUser.name).toBe('New User')
    expect(newUser.email).toBe('new@example.com')

    // Verify it was created
    const found = await browserQuery('users').find(newUser.id)
    expect(found).not.toBeNull()
  })

  it('should support insert() alias', async () => {
    const newUser = await browserQuery<User>('users').insert({
      name: 'Inserted User',
      email: 'inserted@example.com',
    })
    expect(newUser).toHaveProperty('id')
    expect(newUser.name).toBe('Inserted User')
  })

  it('should update a record', async () => {
    const updated = await browserQuery<User>('users').update(1, {
      name: 'Updated Name',
    })
    expect(updated.name).toBe('Updated Name')

    // Verify it was updated
    const found = await browserQuery<User>('users').find(1)
    expect(found?.name).toBe('Updated Name')
  })

  it('should delete a record', async () => {
    const result = await browserQuery('users').delete(1)
    expect(result).toBe(true)

    // Verify it was deleted
    const found = await browserQuery('users').find(1)
    expect(found).toBeNull()
  })

  it('should support destroy() alias', async () => {
    const result = await browserQuery('users').destroy(2)
    expect(result).toBe(true)
  })
})

// ============================================================================
// AUTH TESTS
// ============================================================================

describe('browserAuth - Authentication', () => {
  it('should login successfully with valid credentials', async () => {
    const result = await browserAuth.login({
      email: 'john@example.com',
      password: 'password123',
    })
    expect(result).toHaveProperty('token')
    expect(result).toHaveProperty('user')
    expect(result.user.email).toBe('john@example.com')
  })

  it('should fail login with invalid credentials', async () => {
    await expect(
      browserAuth.login({
        email: 'nonexistent@example.com',
        password: 'wrong',
      }),
    ).rejects.toThrow()
  })

  it('should register a new user', async () => {
    const result = await browserAuth.register({
      name: 'New Registered User',
      email: 'newregistered@example.com',
      password: 'password123',
    })
    expect(result).toHaveProperty('token')
    expect(result).toHaveProperty('user')
    expect(result.user.email).toBe('newregistered@example.com')
  })

  it('should fail registration with existing email', async () => {
    await expect(
      browserAuth.register({
        name: 'Duplicate',
        email: 'john@example.com', // Already exists
        password: 'password123',
      }),
    ).rejects.toThrow()
  })

  it('should get current user when authenticated', async () => {
    // Login first
    const loginResult = await browserAuth.login({
      email: 'jane@example.com',
      password: 'password',
    })
    // Set the token for subsequent requests
    ;(globalThis as any).__testAuthToken = loginResult.token

    const user = await browserAuth.user()
    expect(user).not.toBeNull()
    expect(user?.email).toBe('jane@example.com')
  })

  it('should return null for user when not authenticated', async () => {
    ;(globalThis as any).__testAuthToken = null
    const user = await browserAuth.user()
    expect(user).toBeNull()
  })

  it('should check authentication status', async () => {
    ;(globalThis as any).__testAuthToken = null
    expect(await browserAuth.check()).toBe(false)

    // Login
    const result = await browserAuth.login({
      email: 'john@example.com',
      password: 'password',
    })
    ;(globalThis as any).__testAuthToken = result.token

    expect(await browserAuth.check()).toBe(true)
  })

  it('should logout successfully', async () => {
    // Login first
    const loginResult = await browserAuth.login({
      email: 'john@example.com',
      password: 'password',
    })
    ;(globalThis as any).__testAuthToken = loginResult.token

    // Logout
    await browserAuth.logout()
    // Note: In our mock, we don't clear the global token automatically
    // In real usage, logout clears localStorage
  })
})

// ============================================================================
// ERROR HANDLING TESTS
// ============================================================================

describe('BrowserQueryBuilder - Error Handling', () => {
  it('should throw BrowserQueryError for 404', async () => {
    try {
      await browserQuery('users').findOrFail(999)
      expect(true).toBe(false) // Should not reach here
    }
    catch (error) {
      expect(error).toBeInstanceOf(BrowserQueryError)
      expect((error as BrowserQueryError).status).toBe(404)
    }
  })

  it('should throw BrowserQueryError for 401 unauthorized', async () => {
    // Configure to call onUnauthorized
    let unauthorizedCalled = false
    configureBrowser({
      baseUrl: TEST_BASE_URL,
      getToken: () => 'invalid_token',
      onUnauthorized: () => {
        unauthorizedCalled = true
      },
    })

    try {
      await browserAuth.user()
    }
    catch (error) {
      expect(error).toBeInstanceOf(BrowserQueryError)
      expect((error as BrowserQueryError).status).toBe(401)
    }

    expect(unauthorizedCalled).toBe(true)

    // Reset config
    configureBrowser({
      baseUrl: TEST_BASE_URL,
      getToken: () => (globalThis as any).__testAuthToken || null,
    })
  })

  it('should handle network errors gracefully', async () => {
    // Configure with invalid URL
    configureBrowser({
      baseUrl: 'http://localhost:99999', // Invalid port
      getToken: () => null,
    })

    try {
      await browserQuery('users').get()
      expect(true).toBe(false) // Should not reach here
    }
    catch (error) {
      expect(error).toBeDefined()
    }

    // Reset config
    configureBrowser({
      baseUrl: TEST_BASE_URL,
      getToken: () => (globalThis as any).__testAuthToken || null,
    })
  })
})

// ============================================================================
// CONFIGURATION TESTS
// ============================================================================

describe('Browser Configuration', () => {
  it('should configure browser client', () => {
    configureBrowser({
      baseUrl: 'https://api.example.com',
      timeout: 5000,
    })

    const config = getBrowserConfig()
    expect(config.baseUrl).toBe('https://api.example.com')
    expect(config.timeout).toBe(5000)

    // Reset
    configureBrowser({
      baseUrl: TEST_BASE_URL,
      getToken: () => (globalThis as any).__testAuthToken || null,
    })
  })

  it('should detect browser environment', () => {
    // In Bun test environment, we're not in a browser
    expect(isBrowser()).toBe(false)
  })

  it('should create db shortcut factory', () => {
    const db = createBrowserDb<{ users: User, territories: Territory }>()
    expect(typeof db.users).toBe('function')
    expect(typeof db.territories).toBe('function')

    const usersQuery = db.users()
    expect(usersQuery).toBeInstanceOf(BrowserQueryBuilder)
  })
})

// ============================================================================
// QUERY STATE TESTS
// ============================================================================

describe('BrowserQueryBuilder - Query State', () => {
  it('should expose query state for debugging', () => {
    const query = browserQuery('users')
      .where('active', true)
      .where('role', 'admin')
      .orderBy('created_at', 'desc')
      .limit(10)
      .offset(5)

    const state = query.toState()

    expect(state.table).toBe('users')
    expect(state.wheres.length).toBe(2)
    expect(state.orderBy.length).toBe(1)
    expect(state.limitValue).toBe(10)
    expect(state.offsetValue).toBe(5)
  })

  it('should be chainable', () => {
    const query = browserQuery('users')
      .select('id', 'name')
      .where('active', true)
      .orderBy('name')
      .limit(5)

    expect(query).toBeInstanceOf(BrowserQueryBuilder)
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('BrowserQueryBuilder - Edge Cases', () => {
  it('should handle empty response', async () => {
    const users = await browserQuery('users')
      .where('email', 'definitely-not-existing@nowhere.com')
      .get()
    expect(users).toEqual([])
  })

  it('should handle special characters in values', async () => {
    // Create user with special characters
    const newUser = await browserQuery<User>('users').create({
      name: 'Test User with Special Chars: @#$%',
      email: 'special+test@example.com',
      active: true,
      role: 'user',
    })
    expect(newUser.name).toBe('Test User with Special Chars: @#$%')
    expect(newUser.email).toBe('special+test@example.com')
  })

  it('should handle numeric string IDs', async () => {
    const user = await browserQuery('users').find('1')
    expect(user).not.toBeNull()
    expect(user?.id).toBe(1)
  })

  it('should handle multiple orderBy clauses', async () => {
    const territories = await browserQuery<Territory>('territories')
      .orderBy('status', 'asc')
      .orderBy('area_size', 'desc')
      .get()
    expect(territories.length).toBe(3)
  })

  it('should handle update with empty data', async () => {
    const user = await browserQuery<User>('users').update(1, {})
    expect(user).toHaveProperty('id')
  })

  it('should handle create with minimal data', async () => {
    const territory = await browserQuery<Territory>('territories').create({
      name: 'Minimal Territory',
    })
    expect(territory).toHaveProperty('id')
    expect(territory.name).toBe('Minimal Territory')
  })
})

// ============================================================================
// COMPLEX QUERIES
// ============================================================================

describe('BrowserQueryBuilder - Complex Queries', () => {
  it('should handle complex query with multiple conditions', async () => {
    const territories = await browserQuery<Territory>('territories')
      .where('status', 'active')
      .where('area_size', '>', 30000)
      .orderBy('area_size', 'desc')
      .limit(5)
      .get()

    expect(territories.every(t => t.status === 'active')).toBe(true)
    expect(territories.every(t => t.area_size > 30000)).toBe(true)
    expect(territories.length).toBeLessThanOrEqual(5)
  })

  it('should handle query for related data by foreign key', async () => {
    // Get territories for a specific user
    const userTerritories = await browserQuery<Territory>('territories')
      .where('user_id', 1)
      .orderBy('created_at', 'desc')
      .get()

    expect(userTerritories.length).toBe(2)
    expect(userTerritories.every(t => t.user_id === 1)).toBe(true)
  })
})
