import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  createModel,
  configureOrm,
  getDatabase,
  createTableFromModel,
  seedModel,
  type ModelDefinition,
} from '../src/orm'

// Import model definitions
import UserDefinition from './fixtures/models/User'
import TrailDefinition from './fixtures/models/Trail'
import ActivityDefinition from './fixtures/models/Activity'
import ReviewDefinition from './fixtures/models/Review'

// Simple faker mock for testing
const mockFaker = {
  person: {
    fullName: () => `User ${Math.random().toString(36).substring(7)}`,
  },
  internet: {
    email: () => `user${Math.floor(Math.random() * 10000)}@test.com`,
    password: () => 'hashedpassword123',
  },
  location: {
    street: () => 'Main Street',
    streetAddress: () => '123 Test St',
    city: () => 'Test City',
    state: (_opts?: { abbreviated?: boolean }) => 'CA',
    country: () => 'USA',
    latitude: () => 37.7749 + Math.random() * 0.1,
    longitude: () => -122.4194 + Math.random() * 0.1,
  },
  lorem: {
    sentence: () => 'A test sentence.',
    sentences: (count: number = 3) => Array(count).fill('A test sentence.').join(' '),
    paragraphs: (count: number = 2) => Array(count).fill('A test paragraph.').join('\n\n'),
  },
  number: {
    int: (opts: { min?: number; max?: number } = {}) => {
      const min = opts.min ?? 0
      const max = opts.max ?? 100
      return Math.floor(Math.random() * (max - min + 1)) + min
    },
    float: (opts: { min?: number; max?: number; fractionDigits?: number } = {}) => {
      const min = opts.min ?? 0
      const max = opts.max ?? 100
      const value = Math.random() * (max - min) + min
      if (opts.fractionDigits !== undefined) {
        return Number(value.toFixed(opts.fractionDigits))
      }
      return value
    },
  },
  date: {
    recent: (_opts?: { days?: number }) => new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000),
    past: () => new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000),
  },
  helpers: {
    arrayElement: <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)],
    arrayElements: <T>(arr: T[], count: number): T[] => {
      const shuffled = [...arr].sort(() => Math.random() - 0.5)
      return shuffled.slice(0, count)
    },
    multiple: <T>(fn: () => T, count: number): T[] => Array(count).fill(null).map(() => fn()),
  },
  image: {
    avatar: () => 'https://example.com/avatar.png',
    url: () => 'https://example.com/image.png',
  },
  datatype: {
    boolean: () => Math.random() > 0.5,
  },
  string: {
    alphanumeric: (_length: number = 10) => Math.random().toString(36).substring(2, 12),
  },
}

describe('Dynamic ORM', () => {
  let db: Database

  beforeAll(() => {
    // Configure with in-memory database for testing
    configureOrm({ database: ':memory:' })
    db = getDatabase()
  })

  afterAll(() => {
    db.close()
  })

  describe('createModel', () => {
    it('creates a model class with static methods', () => {
      const User = createModel(UserDefinition as ModelDefinition)

      expect(User.where).toBeDefined()
      expect(User.find).toBeDefined()
      expect(User.create).toBeDefined()
      expect(User.all).toBeDefined()
      expect(User.first).toBeDefined()
      expect(User.count).toBeDefined()
      expect(User.paginate).toBeDefined()
    })

    it('returns correct table and definition info', () => {
      const User = createModel(UserDefinition as ModelDefinition)

      expect(User.getTable()).toBe('users')
      expect(User.getDefinition().name).toBe('User')
    })
  })

  describe('createTableFromModel', () => {
    it('creates users table from User model', () => {
      createTableFromModel(UserDefinition as ModelDefinition)

      // Check table exists
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").all()
      expect(tables.length).toBe(1)
    })

    it('creates trails table from Trail model', () => {
      createTableFromModel(TrailDefinition as ModelDefinition)

      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='trails'").all()
      expect(tables.length).toBe(1)
    })

    it('creates activities table from Activity model', () => {
      createTableFromModel(ActivityDefinition as ModelDefinition)

      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='activities'").all()
      expect(tables.length).toBe(1)
    })

    it('creates reviews table from Review model', () => {
      createTableFromModel(ReviewDefinition as ModelDefinition)

      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='reviews'").all()
      expect(tables.length).toBe(1)
    })
  })

  describe('CRUD Operations', () => {
    const User = createModel(UserDefinition as ModelDefinition)

    beforeEach(() => {
      // Clear users table
      db.run('DELETE FROM users')
    })

    it('creates a new user', async () => {
      const user = await User.create({
        name: 'John Doe',
        email: 'john@test.com',
        password: 'hashedpassword',
      })

      expect(user.id).toBeDefined()
      expect(user.get('name')).toBe('John Doe')
      expect(user.get('email')).toBe('john@test.com')
    })

    it('finds user by id', async () => {
      const created = await User.create({
        name: 'Jane Doe',
        email: 'jane@test.com',
        password: 'hashedpassword',
      })

      const found = await User.find(created.id!)
      expect(found).toBeDefined()
      expect(found?.get('name')).toBe('Jane Doe')
    })

    it('returns undefined for non-existent id', async () => {
      const found = await User.find(99999)
      expect(found).toBeUndefined()
    })

    it('throws on findOrFail for non-existent id', async () => {
      await expect(User.findOrFail(99999)).rejects.toThrow('User with id 99999 not found')
    })

    it('updates a user', async () => {
      const user = await User.create({
        name: 'Original Name',
        email: 'original@test.com',
        password: 'pass',
      })

      await user.update({ name: 'Updated Name' })
      const updated = await User.find(user.id!)

      expect(updated?.get('name')).toBe('Updated Name')
    })

    it('deletes a user', async () => {
      const user = await User.create({
        name: 'To Delete',
        email: 'delete@test.com',
        password: 'pass',
      })

      const id = user.id!
      await user.delete()

      const found = await User.find(id)
      expect(found).toBeUndefined()
    })

    it('destroys user by id', async () => {
      const user = await User.create({
        name: 'To Destroy',
        email: 'destroy@test.com',
        password: 'pass',
      })

      const id = user.id!
      const result = await User.destroy(id)

      expect(result).toBe(true)
      const found = await User.find(id)
      expect(found).toBeUndefined()
    })

    it('creates multiple users', async () => {
      const users = await User.createMany([
        { name: 'User 1', email: 'user1@test.com', password: 'pass' },
        { name: 'User 2', email: 'user2@test.com', password: 'pass' },
        { name: 'User 3', email: 'user3@test.com', password: 'pass' },
      ])

      expect(users.length).toBe(3)
      expect(users[0].get('name')).toBe('User 1')
      expect(users[2].get('name')).toBe('User 3')
    })
  })

  describe('Query Builder', () => {
    const User = createModel(UserDefinition as ModelDefinition)

    beforeAll(async () => {
      // Clear and seed test data
      db.run('DELETE FROM users')

      await User.createMany([
        { name: 'Alice', email: 'alice@test.com', password: 'pass' },
        { name: 'Bob', email: 'bob@test.com', password: 'pass' },
        { name: 'Charlie', email: 'charlie@test.com', password: 'pass' },
        { name: 'Diana', email: 'diana@test.com', password: 'pass' },
        { name: 'Eve', email: 'eve@test.com', password: 'pass' },
      ])
    })

    it('gets all users', async () => {
      const users = await User.all()
      expect(users.length).toBe(5)
    })

    it('gets first user', async () => {
      const user = await User.first()
      expect(user).toBeDefined()
      expect(user?.get('name')).toBe('Alice')
    })

    it('gets last user', async () => {
      const user = await User.last()
      expect(user).toBeDefined()
      expect(user?.get('name')).toBe('Eve')
    })

    it('filters with where', async () => {
      const users = await User.where('name', 'Alice').get()
      expect(users.length).toBe(1)
      expect(users[0].get('name')).toBe('Alice')
    })

    it('filters with whereLike', async () => {
      const users = await User.whereLike('email', '%@test.com').get()
      expect(users.length).toBe(5)
    })

    it('chains where clauses', async () => {
      const users = await User.where('name', 'Alice').where('email', 'alice@test.com').get()
      expect(users.length).toBe(1)
    })

    it('uses orWhere', async () => {
      const users = await User.where('name', 'Alice').orWhere('name', 'Bob').get()
      expect(users.length).toBe(2)
    })

    it('uses whereIn', async () => {
      const users = await User.whereIn('name', ['Alice', 'Charlie', 'Eve']).get()
      expect(users.length).toBe(3)
    })

    it('uses whereNotIn', async () => {
      const users = await User.whereNotIn('name', ['Alice', 'Bob']).get()
      expect(users.length).toBe(3)
    })

    it('orders by column ascending', async () => {
      const users = await User.orderBy('name', 'asc').get()
      expect(users[0].get('name')).toBe('Alice')
      expect(users[4].get('name')).toBe('Eve')
    })

    it('orders by column descending', async () => {
      const users = await User.orderByDesc('name').get()
      expect(users[0].get('name')).toBe('Eve')
      expect(users[4].get('name')).toBe('Alice')
    })

    it('limits results', async () => {
      const users = await User.limit(2).get()
      expect(users.length).toBe(2)
    })

    it('uses take alias for limit', async () => {
      const users = await User.take(3).get()
      expect(users.length).toBe(3)
    })

    it('skips/offsets results', async () => {
      const users = await User.orderBy('name').skip(2).take(2).get()
      expect(users.length).toBe(2)
      expect(users[0].get('name')).toBe('Charlie')
    })

    it('selects specific columns', async () => {
      const users = await User.select('name', 'email').get()
      expect(users.length).toBe(5)
      expect(users[0].get('name')).toBeDefined()
    })

    it('counts records', async () => {
      const count = await User.count()
      expect(count).toBe(5)
    })

    it('counts with where', async () => {
      const count = await User.where('name', 'Alice').count()
      expect(count).toBe(1)
    })

    it('checks existence', async () => {
      const exists = await User.where('name', 'Alice').exists()
      expect(exists).toBe(true)

      const notExists = await User.where('name', 'Nobody').exists()
      expect(notExists).toBe(false)
    })

    it('paginates results', async () => {
      const result = await User.paginate(1, 2)
      expect(result.data.length).toBe(2)
      expect(result.total).toBe(5)
      expect(result.page).toBe(1)
      expect(result.perPage).toBe(2)
      expect(result.lastPage).toBe(3)
    })

    it('paginates second page', async () => {
      const result = await User.paginate(2, 2)
      expect(result.data.length).toBe(2)
      expect(result.page).toBe(2)
    })

    it('paginates last page', async () => {
      const result = await User.paginate(3, 2)
      expect(result.data.length).toBe(1) // 5 total, 2 per page, page 3 has 1
      expect(result.page).toBe(3)
    })

    it('uses latest helper', async () => {
      const users = await User.latest('id').take(1).get()
      expect(users[0].get('name')).toBe('Eve')
    })

    it('uses oldest helper', async () => {
      const users = await User.oldest('id').take(1).get()
      expect(users[0].get('name')).toBe('Alice')
    })

    it('plucks single column', async () => {
      const names = await User.orderBy('name').pluck('name')
      expect(names).toEqual(['Alice', 'Bob', 'Charlie', 'Diana', 'Eve'])
    })
  })

  describe('Query Builder - Bulk Operations', () => {
    const User = createModel(UserDefinition as ModelDefinition)

    beforeEach(async () => {
      db.run('DELETE FROM users')
      await User.createMany([
        { name: 'Alice', email: 'alice@test.com', password: 'pass' },
        { name: 'Bob', email: 'bob@test.com', password: 'pass' },
        { name: 'Charlie', email: 'charlie@test.com', password: 'pass' },
      ])
    })

    it('bulk updates matching records', async () => {
      const count = await User.where('name', 'Alice').update({ name: 'Updated Alice' })
      expect(count).toBe(1)

      const user = await User.where('name', 'Updated Alice').first()
      expect(user).toBeDefined()
    })

    it('bulk deletes matching records', async () => {
      const count = await User.where('name', 'Alice').delete()
      expect(count).toBe(1)

      const total = await User.count()
      expect(total).toBe(2)
    })

    it('truncates table', async () => {
      await User.truncate()
      const count = await User.count()
      expect(count).toBe(0)
    })
  })

  describe('Model Instance', () => {
    const User = createModel(UserDefinition as ModelDefinition)

    beforeEach(() => {
      db.run('DELETE FROM users')
    })

    it('tracks dirty state', async () => {
      const user = await User.create({
        name: 'Test User',
        email: 'test@test.com',
        password: 'pass',
      })

      expect(user.isDirty()).toBe(false)

      user.set('name', 'Changed')
      expect(user.isDirty()).toBe(true)
      expect(user.isDirty('name')).toBe(true)
      expect(user.isDirty('email')).toBe(false)
    })

    it('tracks clean state', async () => {
      const user = await User.create({
        name: 'Test User',
        email: 'test@test.com',
        password: 'pass',
      })

      expect(user.isClean()).toBe(true)
      user.set('name', 'Changed')
      expect(user.isClean()).toBe(false)
    })

    it('gets original values', async () => {
      const user = await User.create({
        name: 'Original',
        email: 'original@test.com',
        password: 'pass',
      })

      user.set('name', 'Changed')
      expect(user.getOriginal('name')).toBe('Original')
      expect(user.get('name')).toBe('Changed')
    })

    it('gets changes', async () => {
      const user = await User.create({
        name: 'Original',
        email: 'original@test.com',
        password: 'pass',
      })

      user.set('name', 'Changed')
      user.set('email', 'changed@test.com')

      const changes = user.getChanges()
      expect(changes.name).toBe('Changed')
      expect(changes.email).toBe('changed@test.com')
    })

    it('fills respecting fillable', async () => {
      const user = User.make()
      user.fill({ name: 'Test', email: 'test@test.com', password: 'pass' })

      expect(user.get('name')).toBe('Test')
      expect(user.get('email')).toBe('test@test.com')
    })

    it('converts to JSON excluding hidden fields', async () => {
      const user = await User.create({
        name: 'Test User',
        email: 'test@test.com',
        password: 'secretpassword',
      })

      const json = user.toJSON()
      expect(json.name).toBe('Test User')
      expect(json.email).toBe('test@test.com')
      expect(json.password).toBeUndefined() // password is hidden
    })

    it('refreshes from database', async () => {
      const user = await User.create({
        name: 'Original',
        email: 'original@test.com',
        password: 'pass',
      })

      // Update directly in database
      db.run('UPDATE users SET name = ? WHERE id = ?', ['Updated', user.id])

      // Local instance still has old value
      expect(user.get('name')).toBe('Original')

      // Refresh from database
      await user.refresh()
      expect(user.get('name')).toBe('Updated')
    })
  })

  describe('firstOrCreate and updateOrCreate', () => {
    const User = createModel(UserDefinition as ModelDefinition)

    beforeEach(() => {
      db.run('DELETE FROM users')
    })

    it('firstOrCreate creates when not exists', async () => {
      const user = await User.firstOrCreate(
        { email: 'new@test.com' },
        { name: 'New User', password: 'pass' }
      )

      expect(user.get('name')).toBe('New User')
      expect(user.get('email')).toBe('new@test.com')
    })

    it('firstOrCreate returns existing when exists', async () => {
      await User.create({
        name: 'Existing',
        email: 'existing@test.com',
        password: 'pass',
      })

      const user = await User.firstOrCreate(
        { email: 'existing@test.com' },
        { name: 'New Name', password: 'newpass' }
      )

      expect(user.get('name')).toBe('Existing') // Not overwritten
    })

    it('updateOrCreate creates when not exists', async () => {
      const user = await User.updateOrCreate(
        { email: 'new@test.com' },
        { name: 'New User', password: 'pass' }
      )

      expect(user.get('name')).toBe('New User')
    })

    it('updateOrCreate updates when exists', async () => {
      await User.create({
        name: 'Original',
        email: 'existing@test.com',
        password: 'pass',
      })

      const user = await User.updateOrCreate(
        { email: 'existing@test.com' },
        { name: 'Updated Name' }
      )

      expect(user.get('name')).toBe('Updated Name')

      // Verify only one record exists
      const count = await User.count()
      expect(count).toBe(1)
    })
  })

  describe('findMany', () => {
    const User = createModel(UserDefinition as ModelDefinition)

    beforeAll(async () => {
      db.run('DELETE FROM users')
      await User.createMany([
        { name: 'User 1', email: 'user1@test.com', password: 'pass' },
        { name: 'User 2', email: 'user2@test.com', password: 'pass' },
        { name: 'User 3', email: 'user3@test.com', password: 'pass' },
      ])
    })

    it('finds multiple by ids', async () => {
      const all = await User.all()
      const ids = [all[0].id, all[2].id]

      const users = await User.findMany(ids as number[])
      expect(users.length).toBe(2)
    })
  })

  describe('Seeding', () => {
    beforeEach(() => {
      db.run('DELETE FROM users')
      db.run('DELETE FROM trails')
    })

    it('seeds users using factory functions', async () => {
      await seedModel(UserDefinition as ModelDefinition, 5, mockFaker)

      const User = createModel(UserDefinition as ModelDefinition)
      const count = await User.count()
      expect(count).toBe(5)
    })

    it('seeds trails using factory functions', async () => {
      await seedModel(TrailDefinition as ModelDefinition, 3, mockFaker)

      const Trail = createModel(TrailDefinition as ModelDefinition)
      const count = await Trail.count()
      expect(count).toBe(3)
    })

    it('uses default count from useSeeder trait', async () => {
      const smallModel: ModelDefinition = {
        name: 'TestModel',
        table: 'test_models',
        traits: {
          useSeeder: { count: 3 },
        },
        attributes: {
          name: {
            fillable: true,
            factory: () => 'Test',
          },
        },
      }

      createTableFromModel(smallModel)
      await seedModel(smallModel, undefined, mockFaker)

      const result = db.query('SELECT COUNT(*) as count FROM test_models').get() as { count: number }
      expect(result.count).toBe(3)

      // Cleanup
      db.run('DROP TABLE test_models')
    })

    it('seeds using real ts-mocker with compatibility layer', async () => {
      // This test verifies the @faker-js/faker -> ts-mocker compatibility
      const simpleModel: ModelDefinition = {
        name: 'SimpleModel',
        table: 'simple_models',
        attributes: {
          name: {
            fillable: true,
            // Uses @faker-js/faker style API (location.city instead of address.city)
            factory: (faker: any) => faker.location.city(),
          },
          count: {
            fillable: true,
            factory: (faker: any) => faker.number.int({ min: 1, max: 100 }),
          },
        },
      }

      createTableFromModel(simpleModel)
      // No faker passed - will use ts-mocker internally with compat layer
      await seedModel(simpleModel, 2)

      const result = db.query('SELECT * FROM simple_models').all() as any[]
      expect(result.length).toBe(2)
      expect(result[0].name).toBeDefined()
      expect(typeof result[0].name).toBe('string')
      // SQLite stores as TEXT, so count may be string - verify it's a valid number
      expect(Number(result[0].count)).toBeGreaterThanOrEqual(1)
      expect(Number(result[0].count)).toBeLessThanOrEqual(100)

      // Cleanup
      db.run('DROP TABLE simple_models')
    })
  })

  describe('Dynamic whereColumn Methods', () => {
    const User = createModel(UserDefinition as ModelDefinition)

    beforeAll(async () => {
      db.run('DELETE FROM users')
      await User.createMany([
        { name: 'Alice', email: 'alice@test.com', password: 'pass' },
        { name: 'Bob', email: 'bob@test.com', password: 'pass' },
      ])
    })

    it('creates dynamic whereEmail method', async () => {
      const UserClass = User as any
      expect(UserClass.whereEmail).toBeDefined()

      const users = await UserClass.whereEmail('alice@test.com').get()
      expect(users.length).toBe(1)
      expect(users[0].get('name')).toBe('Alice')
    })

    it('creates dynamic whereName method', async () => {
      const UserClass = User as any
      expect(UserClass.whereName).toBeDefined()

      const users = await UserClass.whereName('Bob').get()
      expect(users.length).toBe(1)
      expect(users[0].get('email')).toBe('bob@test.com')
    })
  })

  describe('Complex Relational Queries', () => {
    const User = createModel(UserDefinition as ModelDefinition)
    const Trail = createModel(TrailDefinition as ModelDefinition)
    const Activity = createModel(ActivityDefinition as ModelDefinition)
    const Review = createModel(ReviewDefinition as ModelDefinition)

    beforeAll(async () => {
      // Clear all tables
      db.run('DELETE FROM users')
      db.run('DELETE FROM trails')
      db.run('DELETE FROM activities')
      db.run('DELETE FROM reviews')

      // Add foreign key columns manually (since our createTable doesn't handle them)
      try {
        db.run('ALTER TABLE activities ADD COLUMN user_id INTEGER')
      } catch { /* column may exist */ }
      try {
        db.run('ALTER TABLE activities ADD COLUMN trail_id INTEGER')
      } catch { /* column may exist */ }
      try {
        db.run('ALTER TABLE reviews ADD COLUMN user_id INTEGER')
      } catch { /* column may exist */ }
      try {
        db.run('ALTER TABLE reviews ADD COLUMN trail_id INTEGER')
      } catch { /* column may exist */ }

      // Create test data
      await User.createMany([
        { name: 'Hiker Alice', email: 'alice@hiking.com', password: 'pass' },
        { name: 'Trail Runner Bob', email: 'bob@running.com', password: 'pass' },
      ])

      // Insert trails directly with all fields
      db.run(`INSERT INTO trails (name, difficulty, distance, elevation, location, latitude, longitude, rating)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Mountain Peak Trail', 'hard', 8.5, 2500, 'Colorado', 39.7392, -104.9903, 4.8])
      db.run(`INSERT INTO trails (name, difficulty, distance, elevation, location, latitude, longitude, rating)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Easy Nature Walk', 'easy', 2.0, 100, 'California', 37.7749, -122.4194, 4.2])

      // Insert activities with foreign keys
      db.run(`INSERT INTO activities (activityType, distance, duration, user_id, trail_id)
              VALUES (?, ?, ?, ?, ?)`, ['Hike', 8.5, '3:00:00', 1, 1])
      db.run(`INSERT INTO activities (activityType, distance, duration, user_id, trail_id)
              VALUES (?, ?, ?, ?, ?)`, ['Trail Run', 2.0, '0:20:00', 2, 2])

      // Insert reviews
      db.run(`INSERT INTO reviews (rating, title, content, user_id, trail_id)
              VALUES (?, ?, ?, ?, ?)`, [5, 'Amazing!', 'Best trail ever', 1, 1])
      db.run(`INSERT INTO reviews (rating, title, content, user_id, trail_id)
              VALUES (?, ?, ?, ?, ?)`, [4, 'Nice walk', 'Pleasant and easy', 2, 2])
    })

    it('finds trails by difficulty', async () => {
      const hardTrails = await Trail.where('difficulty', 'hard').get()
      expect(hardTrails.length).toBe(1)
      expect(hardTrails[0].get('name')).toBe('Mountain Peak Trail')
    })

    it('finds trails with rating above threshold', async () => {
      const topTrails = await Trail.where('rating', '>', 4.5).get()
      expect(topTrails.length).toBe(1)
    })

    it('finds activities by type', async () => {
      const hikes = await Activity.where('activityType', 'Hike').get()
      expect(hikes.length).toBe(1)
    })

    it('finds activities by user', async () => {
      const userActivities = await Activity.where('user_id', 1).get()
      expect(userActivities.length).toBe(1)
      expect(userActivities[0].get('activityType')).toBe('Hike')
    })

    it('finds reviews by rating', async () => {
      const fiveStars = await Review.where('rating', 5).get()
      expect(fiveStars.length).toBe(1)
      expect(fiveStars[0].get('title')).toBe('Amazing!')
    })

    it('combines multiple conditions', async () => {
      const results = await Activity
        .where('activityType', 'Hike')
        .where('distance', '>', 5)
        .get()
      expect(results.length).toBe(1)
      expect(results[0].get('activityType')).toBe('Hike')
    })

    it('gets average trail rating', async () => {
      const avg = await Trail.avg('rating')
      expect(avg).toBeCloseTo(4.5, 1)
    })

    it('gets total activity distance', async () => {
      const total = await Activity.sum('distance')
      expect(total).toBe(10.5)
    })

    it('gets max trail distance', async () => {
      const max = await Trail.max('distance')
      expect(Number(max)).toBe(8.5)
    })

    it('gets min elevation', async () => {
      const min = await Trail.min('elevation')
      expect(Number(min)).toBe(100)
    })
  })
})
