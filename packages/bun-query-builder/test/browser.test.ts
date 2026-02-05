/**
 * Browser Query Builder Tests
 *
 * Comprehensive tests using real TrailBuddy model fixtures
 * Tests include:
 * - Basic CRUD operations
 * - Complex relational queries
 * - Eager loading (with/include)
 * - Aggregations and filtering
 * - Authentication flows
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
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
import {
  generateSeedData,
  type UserRecord,
  type TrailRecord,
  type ActivityRecord,
  type TerritoryRecord,
  type TerritoryHistoryRecord,
  type ReviewRecord,
  type KudosRecord,
  type UserStatsRecord,
  type TerritoryStatsRecord,
} from './fixtures/seed'

// Import model definitions to verify structure
import UserModel from './fixtures/models/User'
import TrailModel from './fixtures/models/Trail'
import ActivityModel from './fixtures/models/Activity'
import TerritoryModel from './fixtures/models/Territory'

// Mock data store populated from seed
let mockData: ReturnType<typeof generateSeedData>
let mockTokens: Map<string, number> = new Map()

// Mock server
let server: ReturnType<typeof Bun.serve> | null = null
const TEST_PORT = 9876
const TEST_BASE_URL = `http://localhost:${TEST_PORT}`

function resetMockData() {
  mockData = generateSeedData()
  mockTokens.clear()
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
    if (['sort', 'limit', 'offset', 'fields', 'include', 'count', 'paginate'].includes(key)) continue
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

// Helper to add relations to records
function addRelations<T extends Record<string, any>>(
  records: T[],
  include: string,
  tableName: string
): T[] {
  const relations = include.split(',').map(r => r.trim())

  return records.map(record => {
    const withRelations = { ...record }

    for (const relation of relations) {
      switch (tableName) {
        case 'users':
          if (relation === 'activities') {
            withRelations.activities = mockData.activities.filter(a => a.user_id === record.id)
          }
          if (relation === 'territories') {
            withRelations.territories = mockData.territories.filter(t => t.user_id === record.id)
          }
          if (relation === 'reviews') {
            withRelations.reviews = mockData.reviews.filter(r => r.user_id === record.id)
          }
          if (relation === 'stats' || relation === 'userStats') {
            withRelations.stats = mockData.userStats.find(s => s.user_id === record.id)
          }
          if (relation === 'territoryStats') {
            withRelations.territoryStats = mockData.territoryStats.find(s => s.user_id === record.id)
          }
          break

        case 'activities':
          if (relation === 'user') {
            const user = mockData.users.find(u => u.id === record.user_id)
            if (user) {
              const { password: _, ...userWithoutPassword } = user
              withRelations.user = userWithoutPassword
            }
          }
          if (relation === 'trail') {
            withRelations.trail = mockData.trails.find(t => t.id === record.trail_id)
          }
          if (relation === 'kudos') {
            withRelations.kudos = mockData.kudos.filter(k => k.activity_id === record.id)
          }
          break

        case 'territories':
          if (relation === 'user' || relation === 'owner') {
            const user = mockData.users.find(u => u.id === record.user_id)
            if (user) {
              const { password: _, ...userWithoutPassword } = user
              withRelations.user = userWithoutPassword
            }
          }
          if (relation === 'activity') {
            withRelations.activity = mockData.activities.find(a => a.id === record.activity_id)
          }
          if (relation === 'history') {
            withRelations.history = mockData.territoryHistories.filter(h => h.territory_id === record.id)
          }
          break

        case 'reviews':
          if (relation === 'user') {
            const user = mockData.users.find(u => u.id === record.user_id)
            if (user) {
              const { password: _, ...userWithoutPassword } = user
              withRelations.user = userWithoutPassword
            }
          }
          if (relation === 'trail') {
            withRelations.trail = mockData.trails.find(t => t.id === record.trail_id)
          }
          break

        case 'trails':
          if (relation === 'activities') {
            withRelations.activities = mockData.activities.filter(a => a.trail_id === record.id)
          }
          if (relation === 'reviews') {
            withRelations.reviews = mockData.reviews.filter(r => r.trail_id === record.id)
          }
          break

        case 'territory_histories':
          if (relation === 'territory') {
            withRelations.territory = mockData.territories.find(t => t.id === record.territory_id)
          }
          if (relation === 'user') {
            const user = mockData.users.find(u => u.id === record.user_id)
            if (user) {
              const { password: _, ...userWithoutPassword } = user
              withRelations.user = userWithoutPassword
            }
          }
          break
      }
    }

    return withRelations
  })
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
}

// Mock API server handler
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname
  const method = req.method
  const params = parseQueryParams(url)

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // Auth check helper
  const getAuthUser = (): UserRecord | null => {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return null
    const token = authHeader.slice(7)
    const userId = mockTokens.get(token)
    if (!userId) return null
    return mockData.users.find(u => u.id === userId) || null
  }

  try {
    // === AUTH ENDPOINTS ===
    if (path === '/login' && method === 'POST') {
      const body = await req.json() as { email: string, password: string }
      const user = mockData.users.find(u => u.email === body.email)
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
      if (mockData.users.find(u => u.email === body.email)) {
        return new Response(JSON.stringify({ message: 'Email already exists' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }
      const newUser: UserRecord = {
        id: mockData.users.length + 1,
        name: body.name,
        email: body.email,
        password: body.password,
        active: true,
        role: 'user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      mockData.users.push(newUser)
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

    // === GENERIC REST ENDPOINTS ===
    // Determine which table based on path
    const tableMatch = path.match(/^\/(\w+)(?:\/(\d+))?$/)
    if (tableMatch) {
      const [, tableName, idStr] = tableMatch
      const id = idStr ? Number(idStr) : null

      // Get the data for this table
      let tableData: any[] = []
      switch (tableName) {
        case 'users':
          tableData = mockData.users.map(u => ({ ...u, password: undefined }))
          break
        case 'trails':
          tableData = mockData.trails
          break
        case 'activities':
          tableData = mockData.activities
          break
        case 'territories':
          tableData = mockData.territories
          break
        case 'territory-histories':
        case 'territory_histories':
          tableData = mockData.territoryHistories
          break
        case 'reviews':
          tableData = mockData.reviews
          break
        case 'kudos':
          tableData = mockData.kudos
          break
        case 'user-stats':
        case 'user_stats':
          tableData = mockData.userStats
          break
        case 'territory-stats':
        case 'territory_stats':
          tableData = mockData.territoryStats
          break
        default:
          return new Response(JSON.stringify({ message: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
      }

      // GET single record
      if (id !== null && method === 'GET') {
        let record = tableData.find(r => r.id === id)
        if (!record) {
          return new Response(JSON.stringify({ message: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        // Add relations if requested
        if (params.include) {
          record = addRelations([record], params.include, tableName)[0]
        }
        return new Response(JSON.stringify({ data: record }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // GET collection
      if (id === null && method === 'GET') {
        // Count query
        if (params.count === 'true') {
          const filtered = filterData(tableData, { ...params, limit: '', offset: '' })
          return new Response(JSON.stringify({ count: filtered.length }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }

        // Paginate query
        if (params.paginate === 'true') {
          const allFiltered = filterData(tableData, { ...params, limit: '', offset: '' })
          let filtered = filterData(tableData, params)

          // Add relations if requested
          if (params.include) {
            filtered = addRelations(filtered, params.include, tableName)
          }

          const page = Math.floor(Number(params.offset || 0) / Number(params.limit || 15)) + 1
          const perPage = Number(params.limit || 15)
          return new Response(JSON.stringify({
            data: filtered,
            total: allFiltered.length,
            page,
            perPage,
            lastPage: Math.ceil(allFiltered.length / perPage),
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }

        // Regular query
        let filtered = filterData(tableData, params)

        // Add relations if requested
        if (params.include) {
          filtered = addRelations(filtered, params.include, tableName)
        }

        return new Response(JSON.stringify({ data: filtered }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // POST - create
      if (id === null && method === 'POST') {
        const body = await req.json()
        const newRecord = {
          id: tableData.length + 1,
          ...body,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        // Add to appropriate array
        switch (tableName) {
          case 'users': mockData.users.push(newRecord); break
          case 'trails': mockData.trails.push(newRecord); break
          case 'activities': mockData.activities.push(newRecord); break
          case 'territories': mockData.territories.push(newRecord); break
          case 'reviews': mockData.reviews.push(newRecord); break
          case 'kudos': mockData.kudos.push(newRecord); break
        }
        return new Response(JSON.stringify({ data: newRecord }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // PATCH/PUT - update
      if (id !== null && (method === 'PATCH' || method === 'PUT')) {
        const record = tableData.find(r => r.id === id)
        if (!record) {
          return new Response(JSON.stringify({ message: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        const body = await req.json()
        Object.assign(record, body, { updated_at: new Date().toISOString() })
        return new Response(JSON.stringify({ data: record }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        })
      }

      // DELETE
      if (id !== null && method === 'DELETE') {
        const index = tableData.findIndex(r => r.id === id)
        if (index === -1) {
          return new Response(JSON.stringify({ message: 'Not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          })
        }
        tableData.splice(index, 1)
        return new Response(null, { status: 204, headers: corsHeaders })
      }
    }

    return new Response(JSON.stringify({ message: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
  catch (error) {
    console.error('Server error:', error)
    return new Response(JSON.stringify({ message: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    })
  }
}

// Start mock server
beforeAll(() => {
  server = Bun.serve({
    port: TEST_PORT,
    fetch: handleRequest,
  })

  configureBrowser({
    baseUrl: TEST_BASE_URL,
    getToken: () => (globalThis as any).__testAuthToken || null,
  })
})

afterAll(() => {
  server?.stop()
})

beforeEach(() => {
  resetMockData()
  ;(globalThis as any).__testAuthToken = null
})

// ============================================================================
// MODEL FIXTURES VERIFICATION
// ============================================================================

describe('Model Fixtures', () => {
  it('should have valid User model definition', () => {
    expect(UserModel.name).toBe('User')
    expect(UserModel.table).toBe('users')
    expect(UserModel.hasMany).toContain('Activity')
    expect(UserModel.hasMany).toContain('Territory')
    expect(UserModel.attributes.email.unique).toBe(true)
  })

  it('should have valid Trail model with hasMany relationships', () => {
    expect(TrailModel.name).toBe('Trail')
    expect(TrailModel.hasMany).toContain('Activity')
    expect(TrailModel.hasMany).toContain('Review')
    expect(TrailModel.attributes.difficulty.factory).toBeDefined()
  })

  it('should have valid Activity model with belongsTo relationships', () => {
    expect(ActivityModel.name).toBe('Activity')
    expect(ActivityModel.belongsTo).toContain('User')
    expect(ActivityModel.belongsTo).toContain('Trail')
    expect(ActivityModel.hasMany).toContain('Kudos')
  })

  it('should have valid Territory model with game-specific attributes', () => {
    expect(TerritoryModel.name).toBe('Territory')
    expect(TerritoryModel.attributes.polygonData).toBeDefined()
    expect(TerritoryModel.attributes.areaSize).toBeDefined()
    expect(TerritoryModel.attributes.status).toBeDefined()
  })

  it('should generate interconnected seed data', () => {
    expect(mockData.users.length).toBeGreaterThan(0)
    expect(mockData.trails.length).toBe(10) // TRAIL_NAMES count
    expect(mockData.activities.length).toBeGreaterThan(0)

    // Verify relationships
    const userActivities = mockData.activities.filter(a => a.user_id === 1)
    expect(userActivities.length).toBeGreaterThan(0)

    const trailActivities = mockData.activities.filter(a => a.trail_id === mockData.trails[0].id)
    expect(trailActivities.length).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================================
// BASIC QUERY TESTS
// ============================================================================

describe('Basic Queries', () => {
  it('should fetch all users', async () => {
    const users = await browserQuery<UserRecord>('users').get()
    expect(users.length).toBe(mockData.users.length)
    expect(users[0]).toHaveProperty('name')
    expect(users[0]).not.toHaveProperty('password') // Hidden field
  })

  it('should fetch all trails', async () => {
    const trails = await browserQuery<TrailRecord>('trails').get()
    expect(trails.length).toBe(10)
    expect(trails[0]).toHaveProperty('difficulty')
  })

  it('should find user by ID', async () => {
    const user = await browserQuery<UserRecord>('users').find(1)
    expect(user).not.toBeNull()
    expect(user?.name).toBe('Alex Runner')
  })

  it('should return null for non-existent ID', async () => {
    const user = await browserQuery<UserRecord>('users').find(999)
    expect(user).toBeNull()
  })

  it('should throw on findOrFail with non-existent ID', async () => {
    await expect(browserQuery('users').findOrFail(999)).rejects.toThrow(BrowserQueryError)
  })

  it('should get first record', async () => {
    const trail = await browserQuery<TrailRecord>('trails').first()
    expect(trail).not.toBeNull()
    expect(trail).toHaveProperty('name')
  })

  it('should return null on first() with no matches', async () => {
    const user = await browserQuery<UserRecord>('users')
      .where('email', 'nonexistent@test.com')
      .first()
    expect(user).toBeNull()
  })
})

// ============================================================================
// WHERE CLAUSE TESTS
// ============================================================================

describe('Where Clauses', () => {
  it('should filter by equality', async () => {
    const activeUsers = await browserQuery<UserRecord>('users')
      .where('active', true)
      .get()
    expect(activeUsers.every(u => u.active === true)).toBe(true)
  })

  it('should filter by role', async () => {
    const admins = await browserQuery<UserRecord>('users')
      .where('role', 'admin')
      .get()
    expect(admins.length).toBeGreaterThan(0)
    expect(admins.every(u => u.role === 'admin')).toBe(true)
  })

  it('should filter with greater than operator', async () => {
    const bigTerritories = await browserQuery<TerritoryRecord>('territories')
      .where('area_size', '>', 50000)
      .get()
    expect(bigTerritories.every(t => t.area_size > 50000)).toBe(true)
  })

  it('should chain multiple where clauses', async () => {
    const filtered = await browserQuery<UserRecord>('users')
      .where('active', true)
      .where('role', 'user')
      .get()
    expect(filtered.every(u => u.active === true && u.role === 'user')).toBe(true)
  })

  it('should filter activities by user_id', async () => {
    const userActivities = await browserQuery<ActivityRecord>('activities')
      .where('user_id', 1)
      .get()
    expect(userActivities.length).toBeGreaterThan(0)
    expect(userActivities.every(a => a.user_id === 1)).toBe(true)
  })

  it('should filter by activity type', async () => {
    const runs = await browserQuery<ActivityRecord>('activities')
      .where('activity_type', 'Trail Run')
      .get()
    expect(runs.every(a => a.activity_type === 'Trail Run')).toBe(true)
  })

  it('should filter territories by status', async () => {
    const contested = await browserQuery<TerritoryRecord>('territories')
      .where('status', 'contested')
      .get()
    expect(contested.every(t => t.status === 'contested')).toBe(true)
  })

  it('should filter with whereIn', async () => {
    const specificUsers = await browserQuery<UserRecord>('users')
      .whereIn('id', [1, 2])
      .get()
    expect(specificUsers.length).toBe(2)
    expect(specificUsers.every(u => [1, 2].includes(u.id))).toBe(true)
  })
})

// ============================================================================
// ORDERING TESTS
// ============================================================================

describe('Ordering', () => {
  it('should order by distance ascending', async () => {
    const trails = await browserQuery<TrailRecord>('trails')
      .orderBy('distance', 'asc')
      .get()
    for (let i = 1; i < trails.length; i++) {
      expect(trails[i].distance).toBeGreaterThanOrEqual(trails[i - 1].distance)
    }
  })

  it('should order by area_size descending', async () => {
    const territories = await browserQuery<TerritoryRecord>('territories')
      .orderBy('area_size', 'desc')
      .get()
    for (let i = 1; i < territories.length; i++) {
      expect(territories[i].area_size).toBeLessThanOrEqual(territories[i - 1].area_size)
    }
  })

  it('should use latest() helper', async () => {
    const activities = await browserQuery<ActivityRecord>('activities')
      .latest('completed_at')
      .get()
    expect(activities.length).toBeGreaterThan(0)
  })

  it('should use oldest() helper', async () => {
    const users = await browserQuery<UserRecord>('users')
      .oldest('created_at')
      .get()
    expect(users[0].created_at).toBe('2024-01-01T00:00:00Z')
  })
})

// ============================================================================
// PAGINATION TESTS
// ============================================================================

describe('Pagination', () => {
  it('should limit results', async () => {
    const limited = await browserQuery<TrailRecord>('trails').limit(3).get()
    expect(limited.length).toBe(3)
  })

  it('should offset results', async () => {
    const all = await browserQuery<TrailRecord>('trails').get()
    const offset = await browserQuery<TrailRecord>('trails').offset(2).get()
    expect(offset.length).toBe(all.length - 2)
    expect(offset[0].id).toBe(all[2].id)
  })

  it('should paginate correctly', async () => {
    const page1 = await browserQuery<ActivityRecord>('activities').paginate(1, 5)
    expect(page1.data.length).toBe(5)
    expect(page1.page).toBe(1)
    expect(page1.perPage).toBe(5)
    expect(page1.total).toBeGreaterThan(5)

    const page2 = await browserQuery<ActivityRecord>('activities').paginate(2, 5)
    expect(page2.page).toBe(2)
    expect(page2.data[0].id).not.toBe(page1.data[0].id)
  })

  it('should count records', async () => {
    const count = await browserQuery<UserRecord>('users').count()
    expect(count).toBe(mockData.users.length)
  })

  it('should count filtered records', async () => {
    const count = await browserQuery<UserRecord>('users')
      .where('active', true)
      .count()
    const expected = mockData.users.filter(u => u.active).length
    expect(count).toBe(expected)
  })

  it('should check existence', async () => {
    const exists = await browserQuery<UserRecord>('users')
      .where('email', 'alex@trailbuddy.com')
      .exists()
    expect(exists).toBe(true)

    const notExists = await browserQuery<UserRecord>('users')
      .where('email', 'nobody@nowhere.com')
      .exists()
    expect(notExists).toBe(false)
  })
})

// ============================================================================
// RELATIONAL QUERIES - EAGER LOADING
// ============================================================================

describe('Relational Queries - Eager Loading', () => {
  it('should load user with activities', async () => {
    const users = await browserQuery<UserRecord & { activities: ActivityRecord[] }>('users')
      .where('id', 1)
      .with('activities')
      .get()

    expect(users.length).toBe(1)
    expect(users[0].activities).toBeDefined()
    expect(Array.isArray(users[0].activities)).toBe(true)
    expect(users[0].activities.length).toBeGreaterThan(0)
    expect(users[0].activities.every(a => a.user_id === 1)).toBe(true)
  })

  it('should load user with territories', async () => {
    const users = await browserQuery<UserRecord & { territories: TerritoryRecord[] }>('users')
      .where('id', 1)
      .with('territories')
      .get()

    expect(users[0].territories).toBeDefined()
    expect(users[0].territories.length).toBe(3) // Alex owns 3 territories
  })

  it('should load user with stats', async () => {
    const users = await browserQuery<UserRecord & { stats: UserStatsRecord }>('users')
      .where('id', 1)
      .with('stats')
      .get()

    expect(users[0].stats).toBeDefined()
    expect(users[0].stats.total_distance).toBeGreaterThan(0)
  })

  it('should load activity with user and trail', async () => {
    const activities = await browserQuery<ActivityRecord & { user: UserRecord, trail: TrailRecord }>('activities')
      .where('id', 1)
      .with('user', 'trail')
      .get()

    expect(activities[0].user).toBeDefined()
    expect(activities[0].user.name).toBeDefined()
    expect(activities[0].trail).toBeDefined()
    expect(activities[0].trail.name).toBeDefined()
  })

  it('should load territory with owner and history', async () => {
    const territories = await browserQuery<TerritoryRecord & { user: UserRecord, history: TerritoryHistoryRecord[] }>('territories')
      .where('id', 1)
      .with('user', 'history')
      .get()

    expect(territories[0].user).toBeDefined()
    expect(territories[0].user.name).toBe('Alex Runner')
    expect(territories[0].history).toBeDefined()
    expect(territories[0].history.length).toBeGreaterThan(0)
  })

  it('should load trail with activities and reviews', async () => {
    const trails = await browserQuery<TrailRecord & { activities: ActivityRecord[], reviews: ReviewRecord[] }>('trails')
      .where('id', 1)
      .with('activities', 'reviews')
      .get()

    expect(trails[0].activities).toBeDefined()
    expect(trails[0].reviews).toBeDefined()
  })

  it('should load review with user and trail', async () => {
    const reviews = await browserQuery<ReviewRecord & { user: UserRecord, trail: TrailRecord }>('reviews')
      .limit(1)
      .with('user', 'trail')
      .get()

    expect(reviews[0].user).toBeDefined()
    expect(reviews[0].trail).toBeDefined()
    expect(reviews[0].user.name).toBeDefined()
    expect(reviews[0].trail.name).toBeDefined()
  })
})

// ============================================================================
// COMPLEX RELATIONAL QUERIES
// ============================================================================

describe('Complex Relational Queries', () => {
  it('should get top users by territory count with stats', async () => {
    const users = await browserQuery<UserRecord & { territories: TerritoryRecord[], territoryStats: TerritoryStatsRecord }>('users')
      .where('active', true)
      .with('territories', 'territoryStats')
      .get()

    // Find user with most territories
    const sortedByTerritories = users
      .filter(u => u.territories)
      .sort((a, b) => b.territories.length - a.territories.length)

    expect(sortedByTerritories[0].name).toBe('Alex Runner') // Has 3 territories
    expect(sortedByTerritories[0].territoryStats).toBeDefined()
  })

  it('should get activities for a specific trail with user info', async () => {
    const activities = await browserQuery<ActivityRecord & { user: UserRecord }>('activities')
      .where('trail_id', 1)
      .with('user')
      .orderBy('completed_at', 'desc')
      .get()

    for (const activity of activities) {
      expect(activity.trail_id).toBe(1)
      expect(activity.user).toBeDefined()
    }
  })

  it('should get contested territories with owner info', async () => {
    const contested = await browserQuery<TerritoryRecord & { user: UserRecord, history: TerritoryHistoryRecord[] }>('territories')
      .where('status', 'contested')
      .with('user', 'history')
      .get()

    for (const territory of contested) {
      expect(territory.status).toBe('contested')
      expect(territory.user).toBeDefined()
      // Contested territories should have defense events
      const defenseEvents = territory.history.filter(h => h.event_type === 'defended')
      expect(defenseEvents.length).toBeGreaterThan(0)
    }
  })

  it('should get user leaderboard by total distance', async () => {
    const users = await browserQuery<UserRecord & { stats: UserStatsRecord }>('users')
      .where('active', true)
      .with('stats')
      .get()

    const leaderboard = users
      .filter(u => u.stats)
      .sort((a, b) => b.stats.total_distance - a.stats.total_distance)
      .slice(0, 3)

    expect(leaderboard.length).toBe(3)
    // Alex should be first with most distance
    expect(leaderboard[0].name).toBe('Alex Runner')
  })

  it('should get reviews for highly rated trails', async () => {
    const trails = await browserQuery<TrailRecord & { reviews: ReviewRecord[] }>('trails')
      .where('rating', '>', 4)
      .with('reviews')
      .orderBy('rating', 'desc')
      .get()

    for (const trail of trails) {
      expect(trail.rating).toBeGreaterThan(4)
      if (trail.reviews && trail.reviews.length > 0) {
        expect(trail.reviews[0]).toHaveProperty('rating')
      }
    }
  })

  it('should paginate activities with relations', async () => {
    const page = await browserQuery<ActivityRecord & { user: UserRecord, trail: TrailRecord }>('activities')
      .with('user', 'trail')
      .paginate(1, 5)

    expect(page.data.length).toBe(5)
    expect(page.data[0].user).toBeDefined()
    expect(page.data[0].trail).toBeDefined()
    expect(page.total).toBeGreaterThan(5)
  })
})

// ============================================================================
// CRUD OPERATIONS
// ============================================================================

describe('CRUD Operations', () => {
  it('should create a new trail', async () => {
    const newTrail = await browserQuery<TrailRecord>('trails').create({
      name: 'New Test Trail',
      location: 'Test City, TC',
      distance: 5.5,
      elevation: 500,
      difficulty: 'moderate',
      rating: 4.5,
      review_count: 0,
      estimated_time: '2h 00m',
    })

    expect(newTrail.id).toBeDefined()
    expect(newTrail.name).toBe('New Test Trail')
    expect(newTrail.created_at).toBeDefined()
  })

  it('should create a new activity', async () => {
    const newActivity = await browserQuery<ActivityRecord>('activities').create({
      user_id: 1,
      trail_id: 1,
      activity_type: 'Trail Run',
      distance: 8.5,
      duration: '1:15:30',
      kudos_count: 0,
    })

    expect(newActivity.id).toBeDefined()
    expect(newActivity.user_id).toBe(1)
  })

  it('should update a territory', async () => {
    const updated = await browserQuery<TerritoryRecord>('territories').update(1, {
      name: 'Updated Territory Name',
      conquest_count: 10,
    })

    expect(updated.name).toBe('Updated Territory Name')
    expect(updated.conquest_count).toBe(10)
  })

  it('should delete a review', async () => {
    const initialCount = mockData.reviews.length
    const result = await browserQuery('reviews').delete(1)

    expect(result).toBe(true)
  })
})

// ============================================================================
// AUTHENTICATION
// ============================================================================

describe('Authentication', () => {
  it('should login with valid credentials', async () => {
    const result = await browserAuth.login({
      email: 'alex@trailbuddy.com',
      password: 'any',
    })

    expect(result.token).toBeDefined()
    expect(result.user.email).toBe('alex@trailbuddy.com')
    expect(result.user.name).toBe('Alex Runner')
  })

  it('should fail login with invalid email', async () => {
    await expect(browserAuth.login({
      email: 'nobody@test.com',
      password: 'wrong',
    })).rejects.toThrow()
  })

  it('should register new user', async () => {
    const result = await browserAuth.register({
      name: 'New Test User',
      email: 'newuser@test.com',
      password: 'password123',
    })

    expect(result.token).toBeDefined()
    expect(result.user.email).toBe('newuser@test.com')
  })

  it('should fail registration with existing email', async () => {
    await expect(browserAuth.register({
      name: 'Duplicate',
      email: 'alex@trailbuddy.com',
      password: 'password123',
    })).rejects.toThrow()
  })

  it('should get current user when authenticated', async () => {
    const loginResult = await browserAuth.login({
      email: 'sam@trailbuddy.com',
      password: 'any',
    })
    ;(globalThis as any).__testAuthToken = loginResult.token

    const user = await browserAuth.user()
    expect(user).not.toBeNull()
    expect(user.email).toBe('sam@trailbuddy.com')
  })

  it('should return null when not authenticated', async () => {
    ;(globalThis as any).__testAuthToken = null
    const user = await browserAuth.user()
    expect(user).toBeNull()
  })

  it('should check auth status', async () => {
    ;(globalThis as any).__testAuthToken = null
    expect(await browserAuth.check()).toBe(false)

    const result = await browserAuth.login({
      email: 'alex@trailbuddy.com',
      password: 'any',
    })
    ;(globalThis as any).__testAuthToken = result.token

    expect(await browserAuth.check()).toBe(true)
  })
})

// ============================================================================
// ERROR HANDLING
// ============================================================================

describe('Error Handling', () => {
  it('should throw BrowserQueryError on 404', async () => {
    try {
      await browserQuery('users').findOrFail(999)
      expect(true).toBe(false)
    }
    catch (error) {
      expect(error).toBeInstanceOf(BrowserQueryError)
      expect((error as BrowserQueryError).status).toBe(404)
    }
  })

  it('should handle 401 and call onUnauthorized', async () => {
    let unauthorizedCalled = false
    configureBrowser({
      baseUrl: TEST_BASE_URL,
      getToken: () => 'invalid_token',
      onUnauthorized: () => {
        unauthorizedCalled = true
      },
    })

    await browserAuth.user()
    expect(unauthorizedCalled).toBe(true)

    // Reset config
    configureBrowser({
      baseUrl: TEST_BASE_URL,
      getToken: () => (globalThis as any).__testAuthToken || null,
    })
  })
})

// ============================================================================
// CONFIGURATION & UTILITIES
// ============================================================================

describe('Configuration', () => {
  it('should get browser config', () => {
    const config = getBrowserConfig()
    expect(config.baseUrl).toBe(TEST_BASE_URL)
  })

  it('should detect non-browser environment', () => {
    expect(isBrowser()).toBe(false)
  })

  it('should create typed db factory', () => {
    interface DbSchema {
      users: UserRecord
      trails: TrailRecord
      activities: ActivityRecord
    }

    const db = createBrowserDb<DbSchema>()
    expect(typeof db.users).toBe('function')
    expect(db.users()).toBeInstanceOf(BrowserQueryBuilder)
  })

  it('should expose query state for debugging', () => {
    const query = browserQuery('users')
      .where('active', true)
      .where('role', 'admin')
      .orderBy('created_at', 'desc')
      .limit(10)

    const state = query.toState()
    expect(state.table).toBe('users')
    expect(state.wheres.length).toBe(2)
    expect(state.orderBy.length).toBe(1)
    expect(state.limitValue).toBe(10)
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('Edge Cases', () => {
  it('should handle empty results', async () => {
    const results = await browserQuery<UserRecord>('users')
      .where('email', 'definitely-not-real@nowhere.net')
      .get()
    expect(results).toEqual([])
  })

  it('should handle special characters in queries', async () => {
    const newTrail = await browserQuery<TrailRecord>('trails').create({
      name: 'Trail with Special Chars: @#$% & "quotes"',
      location: 'Test+Location',
      distance: 1,
      elevation: 100,
      difficulty: 'easy',
      rating: 3,
      review_count: 0,
      estimated_time: '30m',
    })
    expect(newTrail.name).toContain('@#$%')
  })

  it('should handle numeric string IDs', async () => {
    const user = await browserQuery<UserRecord>('users').find('1')
    expect(user).not.toBeNull()
    expect(user?.id).toBe(1)
  })

  it('should handle multiple orderBy clauses', async () => {
    const territories = await browserQuery<TerritoryRecord>('territories')
      .orderBy('status', 'asc')
      .orderBy('area_size', 'desc')
      .get()
    expect(territories.length).toBeGreaterThan(0)
  })

  it('should handle update with empty data', async () => {
    const user = await browserQuery<UserRecord>('users').update(1, {})
    expect(user).toHaveProperty('id')
    expect(user.updated_at).toBeDefined()
  })
})
