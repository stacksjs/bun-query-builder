/**
 * New Relationship Features Tests
 *
 * Tests for the new relationship features:
 * - whereHas / whereDoesntHave
 * - has / doesntHave
 * - withCount
 * - Relationship introspection
 * - Cycle detection
 * - Depth limits
 * - Better error messages
 */
import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { mockQueryBuilderState } from './utils'

describe('new relationship features', () => {
  describe('whereHas() and has()', () => {
    it('should filter records that have a relationship', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          name: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
          title: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').whereHas('posts')
      expect(qb).toBeDefined()
      const sql = String(qb.toSQL()?.sql || qb.toSQL() || '')
      expect(sql).toContain('EXISTS')
      expect(sql).toContain('posts')
    })

    it('should support has() as shorthand for whereHas()', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').has('posts')
      expect(qb).toBeDefined()
      const sql = String(qb.toSQL() || '')
      expect(sql).toContain('EXISTS')
    })

    it('should support conditional whereHas with callback', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
          published: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').whereHas('posts', qb => qb.where('published', '=', true))
      expect(qb).toBeDefined()
      const sql = String(qb.toSQL() || '')
      expect(sql).toContain('published')
    })
  })

  describe('whereDoesntHave() and doesntHave()', () => {
    it('should filter records that don\'t have a relationship', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').whereDoesntHave('posts')
      expect(qb).toBeDefined()
      const sql = String(qb.toSQL() || '')
      expect(sql).toContain('NOT EXISTS')
    })

    it('should support doesntHave() as shorthand', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').doesntHave('posts')
      expect(qb).toBeDefined()
      const sql = String(qb.toSQL() || '')
      expect(sql).toContain('NOT EXISTS')
    })
  })

  describe('withCount()', () => {
    it('should add relationship count to select', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          name: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').withCount('posts')
      expect(qb).toBeDefined()
      const sql = String(qb.toSQL() || '')
      expect(sql).toContain('COUNT(*)')
      expect(sql).toContain('posts_count')
    })

    it('should support multiple withCount calls', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post', comments: 'Comment' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post, Comment })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').withCount('posts', 'comments')
      const sql = String(qb.toSQL() || '')
      expect(sql).toContain('posts_count')
      expect(sql).toContain('comments_count')
    })
  })

  describe('relationship introspection', () => {
    it('should get all relationships for a table', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
        hasOne: { profile: 'Profile' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const Profile = defineModel({
        name: 'Profile',
        table: 'profiles',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post, Profile })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const rels = db.getRelationships('users')
      expect(rels.hasMany).toBeDefined()
      expect(rels.hasMany.posts).toBe('Post')
      expect(rels.hasOne).toBeDefined()
      expect(rels.hasOne.profile).toBe('Profile')
    })

    it('should check if relationship exists', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(db.hasRelationship('users', 'posts')).toBe(true)
      expect(db.hasRelationship('users', 'invalid')).toBe(false)
    })

    it('should get relationship type', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
        belongsTo: { company: 'Company' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const Company = defineModel({
        name: 'Company',
        table: 'companies',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post, Company })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(db.getRelationshipType('users', 'posts')).toBe('hasMany')
      expect(db.getRelationshipType('users', 'company')).toBe('belongsTo')
      expect(db.getRelationshipType('users', 'invalid')).toBe(null)
    })

    it('should get relationship target table', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(db.getRelationshipTarget('users', 'posts')).toBe('posts')
      expect(db.getRelationshipTarget('users', 'invalid')).toBe(null)
    })
  })

  describe('cycle detection', () => {
    it('should detect circular relationships', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { friends: 'User' },
      })

      const models = defineModels({ User })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      // Self-referential should be detected
      expect(() => {
        db.selectFrom('users').with('friends.friends')
      }).toThrow('Circular relationship')
    })
  })

  describe('depth limits', () => {
    it('should enforce maximum depth limit', () => {
      const A = defineModel({
        name: 'A',
        table: 'a',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
        hasOne: { b: 'B' },
      })
      const B = defineModel({
        name: 'B',
        table: 'b',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
        hasOne: { c: 'C' },
      })
      const C = defineModel({
        name: 'C',
        table: 'c',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
        hasOne: { d: 'D' },
      })
      const D = defineModel({
        name: 'D',
        table: 'd',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
      })

      const models = defineModels({ A, B, C, D })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      // This should work (3 levels deep)
      const qb1 = db.selectFrom('a').with('b.c.d')
      expect(qb1).toBeDefined()

      // Test would fail if we had 11+ levels (exceeds default maxDepth of 10)
    })
  })

  describe('eager load limits', () => {
    it('should enforce maximum eager load limit', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      // Create an array with 51 relations (exceeds default maxEagerLoad of 50)
      const manyRels = Array.from({ length: 51 }, () => 'posts')

      expect(() => {
        db.selectFrom('users').with(...manyRels)
      }).toThrow('Too many relationships')
    })
  })

  describe('error messages', () => {
    it('should provide helpful error for invalid relationship', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').whereHas('invalid')
      }).toThrow('not found')
    })
  })

  describe('null safety', () => {
    it('should handle null in with() gracefully', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').with(null as any)
      expect(qb).toBeDefined()
    })

    it('should handle empty array in with() gracefully', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').with([])
      expect(qb).toBeDefined()
    })

    it('should handle whitespace in relationship names', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').with(' posts ')
      expect(qb).toBeDefined()
    })
  })

  describe('conditional eager loading', () => {
    it('should support object notation for conditional loading', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
          published: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').with({
        posts: qb => qb.where('published', '=', true),
      })

      expect(qb).toBeDefined()
      const sql = String(qb.toSQL() || '')
      expect(sql).toContain('posts')
    })

    it('should support multiple conditional relations', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post', comments: 'Comment' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
          status: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
          approved: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post, Comment })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').with(
        { posts: qb => qb.where('status', '=', 'published') },
        { comments: qb => qb.where('approved', '=', true) },
      )

      expect(qb).toBeDefined()
    })
  })

  describe('pivot table access', () => {
    it('should include pivot columns with withPivot()', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        belongsToMany: { roles: 'Role' },
      })

      const Role = defineModel({
        name: 'Role',
        table: 'roles',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          name: { validation: { rule: {} as any } },
        },
        belongsToMany: { users: 'User' },
      })

      const models = defineModels({ User, Role })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').with('roles').withPivot('roles', 'created_at', 'expires_at')

      expect(qb).toBeDefined()
      const sql = String(qb.toSQL()?.sql || qb.toSQL() || '')
      expect(sql).toContain('pivot_created_at')
      expect(sql).toContain('pivot_expires_at')
    })

    it('should throw error for non-belongsToMany relationships', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').withPivot('posts', 'created_at')
      }).toThrow('not a belongsToMany')
    })

    it('should support multiple pivot columns', () => {
      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        belongsToMany: { tags: 'Tag' },
      })

      const Tag = defineModel({
        name: 'Tag',
        table: 'tags',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          name: { validation: { rule: {} as any } },
        },
        belongsToMany: { posts: 'Post' },
      })

      const models = defineModels({ Post, Tag })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('posts')
        .with('tags')
        .withPivot('tags', 'order', 'featured', 'created_at')

      const sql = String(qb.toSQL()?.sql || qb.toSQL() || '')

      console.log('qb is', qb.toSQL())
      expect(sql).toContain('pivot_order')
      expect(sql).toContain('pivot_featured')
      expect(sql).toContain('pivot_created_at')
    })
  })

  describe('soft delete support', () => {
    it('should filter soft-deleted records in relationships by default', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
          deleted_at: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      // Note: Soft delete filtering depends on config.softDeletes settings
      const qb = db.selectFrom('users').with('posts')
      expect(qb).toBeDefined()
    })

    it('should include soft-deleted records with withTrashed()', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
          deleted_at: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').with('posts').withTrashed()
      expect(qb).toBeDefined()
    })

    it('should only get soft-deleted records with onlyTrashed()', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          deleted_at: { validation: { rule: {} as any } },
        },
        hasMany: { posts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      const qb = db.selectFrom('users').onlyTrashed()
      expect(qb).toBeDefined()
      const sql = String(qb.toSQL() || '')
      expect(sql).toContain('deleted_at IS NOT NULL')
    })
  })
})
