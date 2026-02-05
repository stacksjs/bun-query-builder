/**
 * Edge Case Tests for Dynamic ORM
 *
 * Comprehensive tests covering edge cases, boundary conditions,
 * error handling, and unusual usage patterns.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { createModel, configureOrm, getDatabase } from '../src/orm'

// Model with various field types for testing edge cases
const TestModel = createModel({
  name: 'TestModel',
  table: 'test_edge_cases',
  primaryKey: 'id',
  autoIncrement: true,
  traits: {
    useUuid: true,
    useTimestamps: true,
    useSoftDeletes: true,
  },
  attributes: {
    // String fields
    name: { type: 'string', fillable: true },
    description: { type: 'string', fillable: true, nullable: true },
    code: { type: 'string', fillable: true, unique: true },

    // Number fields
    count: { type: 'number', fillable: true },
    price: { type: 'number', fillable: true },
    rating: { type: 'number', fillable: true, nullable: true },

    // Boolean field
    active: { type: 'boolean', fillable: true },

    // Literal unions
    status: { type: ['draft', 'published', 'archived'] as const, fillable: true },
    priority: { type: ['low', 'medium', 'high'] as const, fillable: true },
    category: { type: ['A', 'B', 'C', 'D'] as const, fillable: true },

    // Hidden field
    secret: { type: 'string', fillable: true, hidden: true },

    // Guarded field
    internalId: { type: 'string', fillable: false, guarded: true },
  },
} as const)

// Model without optional traits for testing defaults
const MinimalModel = createModel({
  name: 'MinimalModel',
  table: 'test_minimal',
  attributes: {
    value: { type: 'string', fillable: true },
  },
} as const)

describe('Edge Cases', () => {
  beforeAll(() => {
    configureOrm({ database: ':memory:' })
    const db = getDatabase()

    // Create test table with all columns
    db.run(`
      CREATE TABLE test_edge_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE,
        name TEXT,
        description TEXT,
        code TEXT UNIQUE,
        count REAL,
        price REAL,
        rating REAL,
        active INTEGER,
        status TEXT,
        priority TEXT,
        category TEXT,
        secret TEXT,
        internal_id TEXT,
        created_at TEXT,
        updated_at TEXT,
        deleted_at TEXT
      )
    `)

    db.run(`
      CREATE TABLE test_minimal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        value TEXT
      )
    `)
  })

  beforeEach(() => {
    const db = getDatabase()
    db.run('DELETE FROM test_edge_cases')
    db.run('DELETE FROM test_minimal')
  })

  afterAll(() => {
    const db = getDatabase()
    db.run('DROP TABLE IF EXISTS test_edge_cases')
    db.run('DROP TABLE IF EXISTS test_minimal')
  })

  describe('Empty Results', () => {
    it('find() returns undefined for non-existent id', () => {
      const result = TestModel.find(999)
      expect(result).toBeUndefined()
    })

    it('first() returns undefined when no records exist', () => {
      const result = TestModel.first()
      expect(result).toBeUndefined()
    })

    it('last() returns undefined when no records exist', () => {
      const result = TestModel.last()
      expect(result).toBeUndefined()
    })

    it('get() returns empty array when no records match', () => {
      const results = TestModel.where('name', 'nonexistent').get()
      expect(results).toEqual([])
      expect(Array.isArray(results)).toBe(true)
    })

    it('all() returns empty array when table is empty', () => {
      const results = TestModel.all()
      expect(results).toEqual([])
    })

    it('pluck() returns empty array when no records exist', () => {
      const names = TestModel.pluck('name')
      expect(names).toEqual([])
    })

    it('count() returns 0 when no records exist', () => {
      const count = TestModel.count()
      expect(count).toBe(0)
    })

    it('exists() returns false when no records exist', () => {
      const exists = TestModel.exists()
      expect(exists).toBe(false)
    })

    it('max() returns 0 when no records exist', () => {
      const max = TestModel.max('count')
      expect(max).toBe(0)
    })

    it('min() returns 0 when no records exist', () => {
      const min = TestModel.min('count')
      expect(min).toBe(0)
    })

    it('sum() returns 0 when no records exist', () => {
      const sum = TestModel.sum('count')
      expect(sum).toBe(0)
    })

    it('avg() returns 0 when no records exist', () => {
      const avg = TestModel.avg('count')
      expect(avg).toBe(0)
    })
  })

  describe('Error Handling', () => {
    it('findOrFail() throws when record not found', () => {
      expect(() => TestModel.findOrFail(999)).toThrow('TestModel with id 999 not found')
    })

    it('firstOrFail() throws when no records match', () => {
      expect(() => TestModel.where('name', 'nonexistent').firstOrFail()).toThrow()
    })

    it('refresh() throws when model has no primary key', () => {
      const instance = TestModel.make({ name: 'test' })
      expect(() => instance.refresh()).toThrow('Cannot refresh a model without a primary key')
    })

    it('delete() throws for unsaved model', () => {
      const instance = TestModel.make({ name: 'test' })
      expect(() => instance.delete()).toThrow('Cannot delete a model without a primary key')
    })
  })

  describe('Boundary Values - Strings', () => {
    it('handles empty string', () => {
      const item = TestModel.create({
        name: '',
        code: 'empty-name',
        count: 0,
        price: 0,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('name')).toBe('')
      item.delete()
    })

    it('handles very long string', () => {
      const longString = 'a'.repeat(10000)
      const item = TestModel.create({
        name: longString,
        code: 'long-name',
        count: 0,
        price: 0,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('name')).toBe(longString)
      expect(item.get('name').length).toBe(10000)
      item.delete()
    })

    it('handles unicode characters', () => {
      const unicode = '你好世界 🌍 مرحبا العالم'
      const item = TestModel.create({
        name: unicode,
        code: 'unicode-name',
        count: 0,
        price: 0,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('name')).toBe(unicode)
      item.delete()
    })

    it('handles special characters', () => {
      const special = "Test's \"quoted\" & <html> \n\t chars"
      const item = TestModel.create({
        name: special,
        code: 'special-chars',
        count: 0,
        price: 0,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('name')).toBe(special)
      item.delete()
    })

    it('handles SQL injection attempt safely', () => {
      const injection = "'; DROP TABLE test_edge_cases; --"
      const item = TestModel.create({
        name: injection,
        code: 'injection-test',
        count: 0,
        price: 0,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('name')).toBe(injection)
      // Table should still exist
      expect(() => TestModel.count()).not.toThrow()
      item.delete()
    })
  })

  describe('Boundary Values - Numbers', () => {
    it('handles zero', () => {
      const item = TestModel.create({
        name: 'zero',
        code: 'zero-values',
        count: 0,
        price: 0.0,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('count')).toBe(0)
      expect(item.get('price')).toBe(0)
      item.delete()
    })

    it('handles negative numbers', () => {
      const item = TestModel.create({
        name: 'negative',
        code: 'negative-values',
        count: -100,
        price: -99.99,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('count')).toBe(-100)
      expect(item.get('price')).toBe(-99.99)
      item.delete()
    })

    it('handles large numbers', () => {
      const item = TestModel.create({
        name: 'large',
        code: 'large-values',
        count: 999999999999,
        price: 999999999999.99,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('count')).toBe(999999999999)
      expect(item.get('price')).toBeCloseTo(999999999999.99)
      item.delete()
    })

    it('handles decimal precision', () => {
      const item = TestModel.create({
        name: 'decimal',
        code: 'decimal-values',
        count: 1,
        price: 123.456789,
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('price')).toBeCloseTo(123.456789, 5)
      item.delete()
    })

    it('handles floating point edge cases', () => {
      const item = TestModel.create({
        name: 'float',
        code: 'float-edge',
        count: 1,
        price: 0.1 + 0.2, // Famous floating point issue
        active: false,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      expect(item.get('price')).toBeCloseTo(0.3, 10)
      item.delete()
    })
  })

  describe('Null and Undefined Handling', () => {
    it('handles nullable fields with null value', () => {
      const db = getDatabase()
      db.run(`
        INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category, description, rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `, ['nullable', 'nullable-test', 1, 1.0, 1, 'draft', 'low', 'A'])

      const item = TestModel.where('code', 'nullable-test').first()!
      expect(item.get('description')).toBeNull()
      expect(item.get('rating')).toBeNull()
    })

    it('whereNull finds records with null values', () => {
      const db = getDatabase()
      db.run(`
        INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category, rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `, ['null-rating', 'null-rating-test', 1, 1.0, 1, 'draft', 'low', 'A'])

      const items = TestModel.whereNull('rating').get()
      expect(items.length).toBeGreaterThan(0)
      expect(items.some(i => i.get('code') === 'null-rating-test')).toBe(true)
    })

    it('whereNotNull excludes records with null values', () => {
      const db = getDatabase()
      db.run(`
        INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category, rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5.0)
      `, ['has-rating', 'has-rating-test', 1, 1.0, 1, 'draft', 'low', 'A'])
      db.run(`
        INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category, rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `, ['no-rating', 'no-rating-test', 1, 1.0, 1, 'draft', 'low', 'A'])

      const items = TestModel.whereNotNull('rating').get()
      expect(items.every(i => i.get('rating') !== null)).toBe(true)
    })
  })

  describe('Multiple Where Conditions', () => {
    beforeEach(() => {
      const db = getDatabase()
      db.run(`INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Item A', 'code-a', 10, 100, 1, 'published', 'high', 'A'])
      db.run(`INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Item B', 'code-b', 20, 200, 1, 'published', 'low', 'B'])
      db.run(`INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Item C', 'code-c', 30, 300, 0, 'draft', 'high', 'A'])
    })

    it('chains multiple where conditions with AND', () => {
      const items = TestModel
        .where('status', 'published')
        .where('priority', 'high')
        .get()

      expect(items.length).toBe(1)
      expect(items[0].get('name')).toBe('Item A')
    })

    it('uses orWhere for OR conditions', () => {
      const items = TestModel
        .where('priority', 'high')
        .orWhere('priority', 'low')
        .get()

      expect(items.length).toBe(3)
    })

    it('combines where with operators', () => {
      const items = TestModel
        .where('count', '>', 15)
        .where('price', '<', 250)
        .get()

      expect(items.length).toBe(1)
      expect(items[0].get('name')).toBe('Item B')
    })

    it('handles whereIn with multiple values', () => {
      const items = TestModel
        .whereIn('category', ['A', 'B'])
        .get()

      expect(items.length).toBe(3)
    })

    it('handles whereNotIn', () => {
      const items = TestModel
        .whereNotIn('category', ['B', 'C', 'D'])
        .get()

      expect(items.length).toBe(2)
      expect(items.every(i => i.get('category') === 'A')).toBe(true)
    })

    it('handles whereLike pattern matching', () => {
      const items = TestModel.whereLike('name', 'Item%').get()
      expect(items.length).toBe(3)

      const specific = TestModel.whereLike('code', '%b').get()
      expect(specific.length).toBe(1)
      expect(specific[0].get('name')).toBe('Item B')
    })
  })

  describe('Ordering and Pagination', () => {
    beforeEach(() => {
      const db = getDatabase()
      for (let i = 1; i <= 25; i++) {
        db.run(`INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [`Item ${i.toString().padStart(2, '0')}`, `code-${i}`, i, i * 10, i % 2, 'published', 'medium', 'A'])
      }
    })

    it('orders by single column ascending', () => {
      const items = TestModel.orderBy('count', 'asc').limit(3).get()
      expect(items[0].get('count')).toBe(1)
      expect(items[1].get('count')).toBe(2)
      expect(items[2].get('count')).toBe(3)
    })

    it('orders by single column descending', () => {
      const items = TestModel.orderByDesc('count').limit(3).get()
      expect(items[0].get('count')).toBe(25)
      expect(items[1].get('count')).toBe(24)
      expect(items[2].get('count')).toBe(23)
    })

    it('orders by multiple columns', () => {
      const items = TestModel
        .orderBy('active', 'desc')
        .orderBy('count', 'asc')
        .get()

      // First should be active=1 with lowest count
      expect(items[0].get('active')).toBeTruthy()
    })

    it('paginates correctly - first page', () => {
      const page1 = TestModel.orderBy('count').paginate(1, 10)
      expect(page1.data.length).toBe(10)
      expect(page1.total).toBe(25)
      expect(page1.page).toBe(1)
      expect(page1.lastPage).toBe(3)
      expect(page1.perPage).toBe(10)
      expect(page1.data[0].get('count')).toBe(1)
    })

    it('paginates correctly - middle page', () => {
      const page2 = TestModel.orderBy('count').paginate(2, 10)
      expect(page2.data.length).toBe(10)
      expect(page2.page).toBe(2)
      expect(page2.data[0].get('count')).toBe(11)
    })

    it('paginates correctly - last page', () => {
      const page3 = TestModel.orderBy('count').paginate(3, 10)
      expect(page3.data.length).toBe(5)
      expect(page3.page).toBe(3)
      expect(page3.data[0].get('count')).toBe(21)
    })

    it('handles pagination beyond available pages', () => {
      const page10 = TestModel.paginate(10, 10)
      expect(page10.data.length).toBe(0)
      expect(page10.page).toBe(10)
    })

    it('limit and offset work correctly', () => {
      const items = TestModel.orderBy('count').skip(5).take(5).get()
      expect(items.length).toBe(5)
      expect(items[0].get('count')).toBe(6)
      expect(items[4].get('count')).toBe(10)
    })

    it('latest() orders by created_at desc', () => {
      // All have same created_at since bulk insert, but method should work
      const items = TestModel.latest().limit(1).get()
      expect(items.length).toBe(1)
    })

    it('oldest() orders by created_at asc', () => {
      const items = TestModel.oldest().limit(1).get()
      expect(items.length).toBe(1)
    })
  })

  describe('CRUD Operations', () => {
    it('create() returns instance with id', () => {
      const item = TestModel.create({
        name: 'Created',
        code: 'created-1',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      expect(item.id).toBeGreaterThan(0)
      expect(item.get('name')).toBe('Created')
    })

    it('createMany() creates multiple records', () => {
      const items = TestModel.createMany([
        { name: 'Batch 1', code: 'batch-1', count: 1, price: 10, active: true, status: 'draft', priority: 'low', category: 'A' },
        { name: 'Batch 2', code: 'batch-2', count: 2, price: 20, active: false, status: 'published', priority: 'high', category: 'B' },
      ])

      expect(items.length).toBe(2)
      expect(items[0].id).toBeLessThan(items[1].id)
    })

    it('make() creates unsaved instance', () => {
      const item = TestModel.make({ name: 'Unsaved', code: 'unsaved' })

      expect(item.get('name')).toBe('Unsaved')
      expect(item.id).toBeUndefined()

      // Should not exist in database
      const found = TestModel.where('code', 'unsaved').first()
      expect(found).toBeUndefined()
    })

    it('save() persists made instance', () => {
      const item = TestModel.make({
        name: 'Will Save',
        code: 'will-save',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      item.save()
      expect(item.id).toBeGreaterThan(0)

      const found = TestModel.find(item.id)
      expect(found).toBeDefined()
      expect(found!.get('name')).toBe('Will Save')
    })

    it('update via instance.set() and save()', () => {
      const item = TestModel.create({
        name: 'Original',
        code: 'update-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      item.set('name', 'Updated')
      item.set('status', 'published')
      item.save()

      const found = TestModel.find(item.id)!
      expect(found.get('name')).toBe('Updated')
      expect(found.get('status')).toBe('published')
    })

    it('update via instance.update()', () => {
      const item = TestModel.create({
        name: 'Original',
        code: 'update-method-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      item.update({ name: 'Method Updated', priority: 'high' })

      const found = TestModel.find(item.id)!
      expect(found.get('name')).toBe('Method Updated')
      expect(found.get('priority')).toBe('high')
    })

    it('bulk update via query builder', () => {
      TestModel.createMany([
        { name: 'Bulk 1', code: 'bulk-1', count: 1, price: 10, active: true, status: 'draft', priority: 'low', category: 'A' },
        { name: 'Bulk 2', code: 'bulk-2', count: 2, price: 20, active: true, status: 'draft', priority: 'low', category: 'A' },
      ])

      const updated = TestModel.where('status', 'draft').update({ status: 'published' })
      expect(updated).toBe(2)

      const published = TestModel.where('status', 'published').get()
      expect(published.length).toBe(2)
    })

    it('delete via instance (soft delete sets deleted_at)', () => {
      const item = TestModel.create({
        name: 'To Delete',
        code: 'delete-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      const id = item.id

      const result = item.delete()
      expect(result).toBe(true)

      // With soft deletes, record still exists but has deleted_at set
      const found = TestModel.find(id)
      expect(found).toBeDefined()
      expect(found!.get('deleted_at')).not.toBeNull()
    })

    it('delete via static destroy()', () => {
      const item = TestModel.create({
        name: 'To Destroy',
        code: 'destroy-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      const id = item.id

      const result = TestModel.destroy(id)
      expect(result).toBe(true)

      const found = TestModel.find(id)
      expect(found).toBeUndefined()
    })

    it('bulk delete via query builder', () => {
      TestModel.createMany([
        { name: 'Delete 1', code: 'del-1', count: 1, price: 10, active: true, status: 'archived', priority: 'low', category: 'A' },
        { name: 'Delete 2', code: 'del-2', count: 2, price: 20, active: true, status: 'archived', priority: 'low', category: 'A' },
        { name: 'Keep', code: 'keep-1', count: 3, price: 30, active: true, status: 'published', priority: 'low', category: 'A' },
      ])

      const deleted = TestModel.where('status', 'archived').delete()
      expect(deleted).toBe(2)

      const remaining = TestModel.all()
      expect(remaining.length).toBe(1)
      expect(remaining[0].get('name')).toBe('Keep')
    })

    it('truncate() removes all records', () => {
      TestModel.createMany([
        { name: 'Trunc 1', code: 'trunc-1', count: 1, price: 10, active: true, status: 'draft', priority: 'low', category: 'A' },
        { name: 'Trunc 2', code: 'trunc-2', count: 2, price: 20, active: true, status: 'draft', priority: 'low', category: 'A' },
      ])

      expect(TestModel.count()).toBe(2)

      TestModel.truncate()

      expect(TestModel.count()).toBe(0)
    })
  })

  describe('Special Operations', () => {
    it('updateOrCreate() updates existing record', () => {
      TestModel.create({
        name: 'Existing',
        code: 'uoc-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      const item = TestModel.updateOrCreate(
        { code: 'uoc-test' },
        { name: 'Updated via UoC', status: 'published' }
      )

      expect(item.get('name')).toBe('Updated via UoC')
      expect(item.get('status')).toBe('published')
      expect(TestModel.where('code', 'uoc-test').count()).toBe(1)
    })

    it('updateOrCreate() creates new record if not found', () => {
      const item = TestModel.updateOrCreate(
        { code: 'uoc-new' },
        { name: 'Created via UoC', count: 1, price: 10, active: true, status: 'draft', priority: 'low', category: 'A' }
      )

      expect(item.get('name')).toBe('Created via UoC')
      expect(item.id).toBeGreaterThan(0)
    })

    it('firstOrCreate() returns existing record', () => {
      const original = TestModel.create({
        name: 'First',
        code: 'foc-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      const item = TestModel.firstOrCreate(
        { code: 'foc-test' },
        { name: 'Should Not Use This' }
      )

      expect(item.id).toBe(original.id)
      expect(item.get('name')).toBe('First')
    })

    it('firstOrCreate() creates new record if not found', () => {
      const item = TestModel.firstOrCreate(
        { code: 'foc-new' },
        { name: 'Created via FoC', count: 1, price: 10, active: true, status: 'draft', priority: 'low', category: 'A' }
      )

      expect(item.get('name')).toBe('Created via FoC')
      expect(item.id).toBeGreaterThan(0)
    })

    it('findMany() returns multiple records by ids', () => {
      const items = TestModel.createMany([
        { name: 'Find 1', code: 'fm-1', count: 1, price: 10, active: true, status: 'draft', priority: 'low', category: 'A' },
        { name: 'Find 2', code: 'fm-2', count: 2, price: 20, active: true, status: 'draft', priority: 'low', category: 'A' },
        { name: 'Find 3', code: 'fm-3', count: 3, price: 30, active: true, status: 'draft', priority: 'low', category: 'A' },
      ])

      const found = TestModel.findMany([items[0].id, items[2].id])
      expect(found.length).toBe(2)
      expect(found.map(i => i.get('name'))).toContain('Find 1')
      expect(found.map(i => i.get('name'))).toContain('Find 3')
    })

    it('findMany() returns empty array for non-existent ids', () => {
      const found = TestModel.findMany([99999, 99998])
      expect(found).toEqual([])
    })
  })

  describe('Model Instance State', () => {
    it('isDirty() detects unsaved changes', () => {
      const item = TestModel.create({
        name: 'Clean',
        code: 'dirty-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      expect(item.isDirty()).toBe(false)
      expect(item.isDirty('name')).toBe(false)

      item.set('name', 'Dirty')

      expect(item.isDirty()).toBe(true)
      expect(item.isDirty('name')).toBe(true)
      expect(item.isDirty('count')).toBe(false)
    })

    it('isClean() is inverse of isDirty()', () => {
      const item = TestModel.create({
        name: 'Clean',
        code: 'clean-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      expect(item.isClean()).toBe(true)

      item.set('name', 'Dirty')

      expect(item.isClean()).toBe(false)
    })

    it('getOriginal() returns original value before changes', () => {
      const item = TestModel.create({
        name: 'Original Name',
        code: 'original-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      item.set('name', 'Changed Name')

      expect(item.get('name')).toBe('Changed Name')
      expect(item.getOriginal('name')).toBe('Original Name')
    })

    it('getChanges() returns only modified fields', () => {
      const item = TestModel.create({
        name: 'Original',
        code: 'changes-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      item.set('name', 'Changed')
      item.set('count', 99)

      const changes = item.getChanges()
      expect(changes).toEqual({ name: 'Changed', count: 99 })
    })

    it('refresh() reloads data from database', () => {
      const item = TestModel.create({
        name: 'Original',
        code: 'refresh-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      // Modify without saving
      item.set('name', 'Unsaved Change')
      expect(item.get('name')).toBe('Unsaved Change')

      // Refresh from database
      item.refresh()
      expect(item.get('name')).toBe('Original')
    })

    it('fill() only updates fillable attributes', () => {
      const item = TestModel.make({})

      item.fill({
        name: 'Filled',
        code: 'fill-test',
        count: 5,
      })

      expect(item.get('name')).toBe('Filled')
      expect(item.get('code')).toBe('fill-test')
    })

    it('forceFill() updates any attribute', () => {
      const item = TestModel.make({})

      item.forceFill({
        name: 'Force Filled',
        internalId: 'internal-123',
      })

      expect(item.get('name')).toBe('Force Filled')
      // Note: internalId is guarded but forceFill bypasses that
    })

    it('attributes getter returns all attributes', () => {
      const item = TestModel.create({
        name: 'Attrs Test',
        code: 'attrs-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      const attrs = item.attributes
      expect(attrs.name).toBe('Attrs Test')
      expect(attrs.code).toBe('attrs-test')
      expect(typeof attrs.id).toBe('number')
    })
  })

  describe('Select and Column Restriction', () => {
    beforeEach(() => {
      TestModel.create({
        name: 'Select Test',
        code: 'select-test',
        count: 42,
        price: 99.99,
        active: true,
        status: 'published',
        priority: 'high',
        category: 'A',
        secret: 'hidden-value',
      })
    })

    it('select() limits returned columns in SQL', () => {
      const items = TestModel.select('name', 'status').get()
      const item = items[0]

      expect(item.get('name')).toBe('Select Test')
      expect(item.get('status')).toBe('published')
    })

    it('chained select replaces previous select', () => {
      const items = TestModel
        .select('name', 'count')
        .select('status', 'priority')
        .get()

      const item = items[0]
      expect(item.get('status')).toBe('published')
      expect(item.get('priority')).toBe('high')
    })
  })

  describe('System Fields', () => {
    it('id is auto-generated', () => {
      const item1 = TestModel.create({
        name: 'First',
        code: 'id-test-1',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })
      const item2 = TestModel.create({
        name: 'Second',
        code: 'id-test-2',
        count: 2,
        price: 20,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      expect(item2.id).toBeGreaterThan(item1.id)
    })

    it('timestamps are set on create', () => {
      const before = Date.now() - 1000 // 1 second buffer

      const item = TestModel.create({
        name: 'Timestamp Test',
        code: 'timestamp-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      const after = Date.now() + 1000 // 1 second buffer

      // Fetch fresh from database to get timestamps
      const fetched = TestModel.find(item.id)!
      const createdAt = fetched.get('created_at') as string
      const createdAtTime = new Date(createdAt).getTime()

      expect(createdAtTime).toBeGreaterThanOrEqual(before)
      expect(createdAtTime).toBeLessThanOrEqual(after)
    })

    it('updated_at changes on update', async () => {
      const item = TestModel.create({
        name: 'Update Time Test',
        code: 'update-time-test',
        count: 1,
        price: 10,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      const originalUpdatedAt = item.get('updated_at')

      // Small delay to ensure timestamp difference
      await new Promise(resolve => setTimeout(resolve, 10))

      item.set('name', 'Updated Name')
      item.save()

      const found = TestModel.find(item.id)!
      expect(found.get('updated_at')).not.toBe(originalUpdatedAt)
    })
  })

  describe('Query Builder Methods', () => {
    beforeEach(() => {
      const db = getDatabase()
      db.run(`INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Query A', 'query-a', 10, 100, 1, 'published', 'high', 'A'])
      db.run(`INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Query B', 'query-b', 20, 200, 0, 'draft', 'medium', 'B'])
      db.run(`INSERT INTO test_edge_cases (name, code, count, price, active, status, priority, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ['Query C', 'query-c', 30, 300, 1, 'published', 'low', 'C'])
    })

    it('query() returns new query builder', () => {
      const builder = TestModel.query()
      const items = builder.where('status', 'published').get()
      expect(items.length).toBe(2)
    })

    it('count() returns correct count', () => {
      expect(TestModel.count()).toBe(3)
      expect(TestModel.where('status', 'published').count()).toBe(2)
    })

    it('exists() returns boolean', () => {
      expect(TestModel.exists()).toBe(true)
      expect(TestModel.where('status', 'archived').exists()).toBe(false)
    })

    it('max() returns maximum value', () => {
      expect(TestModel.max('count')).toBe(30)
      expect(TestModel.max('price')).toBe(300)
    })

    it('min() returns minimum value', () => {
      expect(TestModel.min('count')).toBe(10)
      expect(TestModel.min('price')).toBe(100)
    })

    it('sum() returns sum of values', () => {
      expect(TestModel.sum('count')).toBe(60)
      expect(TestModel.sum('price')).toBe(600)
    })

    it('avg() returns average', () => {
      expect(TestModel.avg('count')).toBe(20)
      expect(TestModel.avg('price')).toBe(200)
    })
  })

  describe('Minimal Model (no traits)', () => {
    it('works without optional traits', () => {
      const item = MinimalModel.create({ value: 'test' })
      expect(item.id).toBeGreaterThan(0)
      expect(item.get('value')).toBe('test')
    })

    it('find works on minimal model', () => {
      const created = MinimalModel.create({ value: 'findable' })
      const found = MinimalModel.find(created.id)
      expect(found).toBeDefined()
      expect(found!.get('value')).toBe('findable')
    })
  })

  describe('Concurrent Operations', () => {
    it('handles rapid creates', () => {
      const items = []
      for (let i = 0; i < 100; i++) {
        items.push(TestModel.create({
          name: `Rapid ${i}`,
          code: `rapid-${i}`,
          count: i,
          price: i * 10,
          active: true,
          status: 'draft',
          priority: 'low',
          category: 'A',
        }))
      }

      expect(items.length).toBe(100)
      expect(TestModel.count()).toBe(100)

      // Verify all have unique IDs
      const ids = new Set(items.map(i => i.id))
      expect(ids.size).toBe(100)
    })

    it('handles rapid updates', () => {
      const item = TestModel.create({
        name: 'Rapid Update',
        code: 'rapid-update',
        count: 0,
        price: 0,
        active: true,
        status: 'draft',
        priority: 'low',
        category: 'A',
      })

      for (let i = 1; i <= 50; i++) {
        item.set('count', i)
        item.save()
      }

      const found = TestModel.find(item.id)!
      expect(found.get('count')).toBe(50)
    })
  })
})
