/**
 * Advanced Relationship Tests
 *
 * These tests verify complex relationship scenarios, query combinations,
 * and potential edge cases that could uncover bugs or unexpected behavior.
 */
import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { mockQueryBuilderState } from './utils'

describe('advanced relationship scenarios', () => {
  describe('relationships with complex queries', () => {
    it('should combine with() and where() clauses', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          status: { validation: { rule: {} as any } },
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
      const qb = db.selectFrom('users')
        .where('status', '=', 'active')
        .with('posts')

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })

    it('should combine with() and select() without breaking joins', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          name: { validation: { rule: {} as any } },
          email: { validation: { rule: {} as any } },
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
      const qb = db.selectFrom('users')
        .select(['id', 'name'])
        .with('posts')

      expect(qb).toBeDefined()
      // Verify it's a chainable query object
      expect(qb).toHaveProperty('where')
    })

    it('should handle with() combined with orderBy', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          created_at: { validation: { rule: {} as any } },
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
      const qb = db.selectFrom('users')
        .with('posts')
        .orderBy('created_at', 'desc')

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })

    it('should handle with() combined with limit and offset', () => {
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
      const qb = db.selectFrom('users')
        .with('posts')
        .limit(10)
        .offset(5)

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })

    it('should handle with() combined with groupBy', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          role: { validation: { rule: {} as any } },
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
      const qb = db.selectFrom('users')
        .with('posts')
        .groupBy('role')

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })
  })

  describe('duplicate and redundant relationship loads', () => {
    it('should handle duplicate relation names in with() call', () => {
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
      const qb = db.selectFrom('users').with(['posts', 'posts', 'posts'])

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })

    it('should handle multiple consecutive with() calls for same relation', () => {
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
      const qb = db.selectFrom('users')
        .with('posts')
        .with('posts')

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })
  })

  describe('case sensitivity in relationship names', () => {
    it('should respect case in relationship names', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { Posts: 'Post', posts: 'Post' },
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
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users?.hasMany?.Posts).toBe('Post')
      expect(meta.relations?.users?.hasMany?.posts).toBe('Post')
    })

    it('should handle PascalCase relationship names', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { BlogPosts: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { PostAuthor: 'User' },
      })

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })
      const qb = db.selectFrom('users').with('BlogPosts')

      expect(qb).toBeDefined()
      expect(meta.relations?.users?.hasMany?.BlogPosts).toBe('Post')
    })
  })

  describe('relationship name conflicts', () => {
    it('should handle relationship name same as attribute name', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          posts: { validation: { rule: {} as any } }, // Column named 'posts'
        },
        hasMany: { posts: 'Post' }, // Relation named 'posts'
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
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users?.hasMany?.posts).toBe('Post')
      // Note: tables is not part of meta, it's part of schema
      const schema = buildDatabaseSchema(models)
      // Check that the 'posts' column exists even though there's a relationship with the same name
      expect('posts' in schema.users.columns).toBe(true)
    })

    it('should handle relationship name same as table name', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { users: 'User' }, // Self-referential with table name
      })

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users?.hasMany?.users).toBe('User')
    })
  })

  describe('null and undefined foreign key handling', () => {
    it('should handle models with nullable foreign keys', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          manager_id: { validation: { rule: {} as any }, nullable: true },
        },
        belongsTo: { manager: 'User' },
      })

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users?.belongsTo?.manager).toBe('User')
    })

    it('should handle relationships when FK column is undefined', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          // Note: profile_id not defined in attributes
        },
        hasOne: { profile: 'Profile' },
      })

      const Profile = defineModel({
        name: 'Profile',
        table: 'profiles',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
        belongsTo: { user: 'User' },
      })

      const models = defineModels({ User, Profile })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users?.hasOne?.profile).toBe('Profile')
    })
  })

  describe('bidirectional relationship consistency', () => {
    it('should maintain consistency when both sides define relationship', () => {
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
      const meta = buildSchemaMeta(models)

      // Both sides should be properly registered
      expect(meta.relations?.users?.hasMany?.posts).toBe('Post')
      expect(meta.relations?.posts?.belongsTo?.user).toBe('User')
    })

    it('should work with one-sided relationship definitions', () => {
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
        // No belongsTo defined
      })

      const models = defineModels({ User, Post })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users?.hasMany?.posts).toBe('Post')
    })
  })

  describe('very long relationship chains', () => {
    it('should handle 10-level deep nested relationships', () => {
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
        hasOne: { e: 'E' },
      })
      const E = defineModel({
        name: 'E',
        table: 'e',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
        hasOne: { f: 'F' },
      })
      const F = defineModel({
        name: 'F',
        table: 'f',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
        hasOne: { g: 'G' },
      })
      const G = defineModel({
        name: 'G',
        table: 'g',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
        hasOne: { h: 'H' },
      })
      const H = defineModel({
        name: 'H',
        table: 'h',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
        hasOne: { i: 'I' },
      })
      const I = defineModel({
        name: 'I',
        table: 'i',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
        hasOne: { j: 'J' },
      })
      const J = defineModel({
        name: 'J',
        table: 'j',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} as any } } },
      })

      const models = defineModels({ A, B, C, D, E, F, G, H, I, J })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })
      const qb = db.selectFrom('a').with('b.c.d.e.f.g.h.i.j')

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })
  })

  describe('special characters and unicode in relationships', () => {
    it('should handle unicode in relationship names', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { publicações: 'Post' }, // Portuguese
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users?.hasMany?.publicações).toBe('Post')
    })

    it('should handle numbers in relationship names', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        hasMany: { posts2023: 'Post' },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          user_id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ User, Post })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users?.hasMany?.posts2023).toBe('Post')
    })
  })

  describe('relationship loading order and priority', () => {
    it('should handle relationships loaded in different orders', () => {
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

      const qb1 = createQueryBuilder({
        ...mockQueryBuilderState,
        schema,
        meta,
      }).selectFrom('users').with(['posts', 'comments'])
      const qb2 = createQueryBuilder({
        ...mockQueryBuilderState,
        schema,
        meta,
      }).selectFrom('users').with(['comments', 'posts'])

      expect(qb1).toBeDefined()
      expect(qb2).toBeDefined()
    })
  })

  describe('relationship with aggregate and raw queries', () => {
    it('should handle with() alongside count()', () => {
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
      const qb = db.selectFrom('users')
        .with('posts')
        .count('id')

      expect(qb).toBeDefined()
      // count() returns a different type, not a regular query builder
      expect(qb).toHaveProperty('then')
    })

    it('should handle with() alongside distinct()', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          email: { validation: { rule: {} as any } },
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
      const qb = db.selectFrom('users')
        .distinct()
        .with('posts')

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })
  })

  describe('polymorphic relationship variations', () => {
    it('should handle polymorphic with multiple morph types on same model', () => {
      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
        morphMany: { comments: 'Comment', reactions: 'Reaction' },
      })

      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          commentable_id: { validation: { rule: {} as any } },
          commentable_type: { validation: { rule: {} as any } },
        },
      })

      const Reaction = defineModel({
        name: 'Reaction',
        table: 'reactions',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          reactable_id: { validation: { rule: {} as any } },
          reactable_type: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ Post, Comment, Reaction })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.posts?.morphMany?.comments).toBe('Comment')
      expect(meta.relations?.posts?.morphMany?.reactions).toBe('Reaction')
    })

    it('should handle morphTo relationships correctly', () => {
      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
          commentable_id: { validation: { rule: {} as any } },
          commentable_type: { validation: { rule: {} as any } },
        },
        morphTo: { commentable: ['Post', 'Video'] },
      })

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const Video = defineModel({
        name: 'Video',
        table: 'videos',
        primaryKey: 'id',
        attributes: {
          id: { validation: { rule: {} as any } },
        },
      })

      const models = defineModels({ Comment, Post, Video })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.comments?.morphTo?.commentable).toBeDefined()
    })
  })

  describe('empty arrays and edge values in with()', () => {
    it('should handle with([]) empty array', () => {
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
      const qb = db.selectFrom('users').with([])

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })

    it('should handle with(null) gracefully', () => {
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
      const qb = db.selectFrom('users').with(null as any)

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })

    it('should handle with() with whitespace in relation names', () => {
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
      const qb = db.selectFrom('users').with(' posts ')

      expect(qb).toBeDefined()
      expect(typeof qb.get).toBe('function')
    })
  })
})
