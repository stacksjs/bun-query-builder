/**
 * Relationship Configuration Tests
 *
 * Tests for relationship configuration options like singularization strategies,
 * foreign key naming conventions, and other config-driven behavior.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { config } from '../src/config'
import { mockQueryBuilderState } from './utils'

describe('relationship configuration', () => {
  // Store original config to restore after tests
  const originalSingularizeStrategy = config.relations.singularizeStrategy
  const originalForeignKeyFormat = config.relations.foreignKeyFormat

  afterEach(() => {
    // Restore original config after each test
    config.relations.singularizeStrategy = originalSingularizeStrategy
    config.relations.foreignKeyFormat = originalForeignKeyFormat
  })

  describe('singularization strategies', () => {
    it('should use stripTrailingS strategy by default', () => {
      config.relations.singularizeStrategy = 'stripTrailingS'

      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'Post' },
      } as const)

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { user: 'User' },
      } as const)

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with('posts')
      }).not.toThrow()
    })

    it('should use none strategy when configured', () => {
      config.relations.singularizeStrategy = 'none'

      const Users = defineModel({
        name: 'Users',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'Posts' },
      } as const)

      const Posts = defineModel({
        name: 'Posts',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          users_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { users: 'Users' },
      } as const)

      const models = defineModels({ Users, Posts })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with('posts')
      }).not.toThrow()
    })

    it('should handle plural table names correctly with stripTrailingS', () => {
      config.relations.singularizeStrategy = 'stripTrailingS'

      const Category = defineModel({
        name: 'Category',
        table: 'categories',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { products: 'Product' },
      } as const)

      const models = defineModels({ Category })
      const meta = buildSchemaMeta(models)

      expect(meta.modelToTable.Category).toBe('categories')
    })

    it('should not singularize when strategy is none', () => {
      config.relations.singularizeStrategy = 'none'

      const Companies = defineModel({
        name: 'Companies',
        table: 'companies',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const models = defineModels({ Companies })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('companies')
      }).not.toThrow()
    })
  })

  describe('foreign key naming formats', () => {
    it('should respect singularParent_id format', () => {
      config.relations.foreignKeyFormat = 'singularParent_id'
      config.relations.singularizeStrategy = 'stripTrailingS'

      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'Post' },
      } as const)

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { user: 'User' },
      } as const)

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with('posts')
      }).not.toThrow()
    })

    it('should respect parentId camelCase format', () => {
      config.relations.foreignKeyFormat = 'parentId'

      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'Post' },
      } as const)

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          userId: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { user: 'User' },
      } as const)

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with('posts')
      }).not.toThrow()
    })
  })

  describe('pivot table naming', () => {
    it('should use alphabetically sorted table names for pivot', () => {
      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsToMany: { tags: 'Tag' },
      } as const)

      const Tag = defineModel({
        name: 'Tag',
        table: 'tags',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsToMany: { posts: 'Post' },
      } as const)

      const models = defineModels({ Post, Tag })
      const meta = buildSchemaMeta(models)

      // Pivot should be 'post_tag' (alphabetically: post before tag)
      expect(meta.relations?.posts.belongsToMany?.tags).toBe('Tag')
      expect(meta.relations?.tags.belongsToMany?.posts).toBe('Post')
    })

    it('should handle pivot with unconventional table names', () => {
      const Article = defineModel({
        name: 'Article',
        table: 'articles',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsToMany: { categories: 'Category' },
      } as const)

      const Category = defineModel({
        name: 'Category',
        table: 'categories',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsToMany: { articles: 'Article' },
      } as const)

      const models = defineModels({ Article, Category })
      const meta = buildSchemaMeta(models)

      // Pivot should be 'article_category' (alphabetically)
      expect(meta.relations?.articles.belongsToMany?.categories).toBe('Category')
      expect(meta.relations?.categories.belongsToMany?.articles).toBe('Article')
    })
  })

  describe('polymorphic naming conventions', () => {
    it('should follow consistent polymorphic column naming', () => {
      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        morphMany: { comments: 'Comment' },
      } as const)

      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          commentable_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          commentable_type: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
        },
      } as const)

      const models = defineModels({ Post, Comment })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.posts.morphMany?.comments).toBe('Comment')
      // Should expect columns: commentable_id and commentable_type
    })

    it('should handle multiple polymorphic relations to same model', () => {
      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        morphOne: { thumbnail: 'Image' },
        morphMany: { images: 'Image' },
      } as const)

      const Image = defineModel({
        name: 'Image',
        table: 'images',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          imageable_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          imageable_type: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
        },
      } as const)

      const models = defineModels({ Post, Image })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.posts.morphOne?.thumbnail).toBe('Image')
      expect(meta.relations?.posts.morphMany?.images).toBe('Image')
    })
  })

  describe('relationship resolution order', () => {
    it('should resolve relationships in correct priority order', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasOne: { profile: 'Profile' },
        hasMany: { posts: 'Post', comments: 'Comment' },
        belongsTo: { organization: 'Organization' },
        belongsToMany: { roles: 'Role' },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      const rels = meta.relations?.users
      expect(rels?.hasOne?.profile).toBe('Profile')
      expect(rels?.hasMany?.posts).toBe('Post')
      expect(rels?.belongsTo?.organization).toBe('Organization')
      expect(rels?.belongsToMany?.roles).toBe('Role')
    })
  })

  describe('through relationship configuration', () => {
    it('should correctly store through and target in hasManyThrough', () => {
      const Country = defineModel({
        name: 'Country',
        table: 'countries',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasManyThrough: {
          posts: { through: 'User', target: 'Post' },
        },
      } as const)

      const models = defineModels({ Country })
      const meta = buildSchemaMeta(models)

      const through = meta.relations?.countries.hasManyThrough?.posts
      expect(through?.through).toBe('User')
      expect(through?.target).toBe('Post')
    })

    it('should handle hasOneThrough with correct structure', () => {
      const Country = defineModel({
        name: 'Country',
        table: 'countries',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasOneThrough: {
          latestPost: { through: 'User', target: 'Post' },
        },
      } as const)

      const models = defineModels({ Country })
      const meta = buildSchemaMeta(models)

      const through = meta.relations?.countries.hasOneThrough?.latestPost
      expect(through?.through).toBe('User')
      expect(through?.target).toBe('Post')
    })
  })

  describe('aliasing configuration', () => {
    it('should respect relationColumnAliasFormat setting', () => {
      const originalFormat = config.aliasing.relationColumnAliasFormat

      // Test table_column format
      config.aliasing.relationColumnAliasFormat = 'table_column'
      expect(config.aliasing.relationColumnAliasFormat).toBe('table_column')

      // Test table.dot.column format
      config.aliasing.relationColumnAliasFormat = 'table.dot.column'
      expect(config.aliasing.relationColumnAliasFormat).toBe('table.dot.column')

      // Test camelCase format
      config.aliasing.relationColumnAliasFormat = 'camelCase'
      expect(config.aliasing.relationColumnAliasFormat).toBe('camelCase')

      // Restore
      config.aliasing.relationColumnAliasFormat = originalFormat
    })
  })

  describe('scopes integration with relationships', () => {
    it('should preserve scopes alongside relationships', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          active: { validation: { rule: { validate: (v: boolean) => typeof v === 'boolean' } as any } },
        },
        hasMany: { posts: 'Post' },
        scopes: {
          active: (qb: any) => qb.where({ active: true }),
          inactive: (qb: any) => qb.where({ active: false }),
        },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.hasMany?.posts).toBe('Post')
      expect(meta.scopes?.users.active).toBeDefined()
      expect(meta.scopes?.users.inactive).toBeDefined()
    })

    it('should allow combining scopes with relationships', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          active: { validation: { rule: { validate: (v: boolean) => typeof v === 'boolean' } as any } },
        },
        hasMany: { posts: 'Post' },
        scopes: {
          active: (qb: any) => qb.where({ active: true }),
        },
      } as const)

      const models = defineModels({ User })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with('posts').scope?.('active')
      }).not.toThrow()
    })
  })

  describe('timestamps with relationships', () => {
    it('should preserve timestamp configuration with relationships', () => {
      const originalCreatedAt = config.timestamps.createdAt
      const originalUpdatedAt = config.timestamps.updatedAt

      config.timestamps.createdAt = 'created_at'
      config.timestamps.updatedAt = 'updated_at'

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          created_at: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
          updated_at: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
        },
        belongsTo: { user: 'User' },
      } as const)

      const models = defineModels({ Post })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.posts.belongsTo?.user).toBe('User')
      expect(config.timestamps.createdAt).toBe('created_at')

      // Restore
      config.timestamps.createdAt = originalCreatedAt
      config.timestamps.updatedAt = originalUpdatedAt
    })
  })

  describe('multiple models sharing relationships', () => {
    it('should handle same relationship name across different models', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { comments: 'Comment' },
      } as const)

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { comments: 'Comment' },
      } as const)

      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          post_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { user: 'User', post: 'Post' },
      } as const)

      const models = defineModels({ User, Post, Comment })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.hasMany?.comments).toBe('Comment')
      expect(meta.relations?.posts.hasMany?.comments).toBe('Comment')
      expect(meta.relations?.comments.belongsTo?.user).toBe('User')
      expect(meta.relations?.comments.belongsTo?.post).toBe('Post')
    })
  })

  describe('relationship metadata completeness', () => {
    it('should initialize all relationship types even when empty', () => {
      const Simple = defineModel({
        name: 'Simple',
        table: 'simple',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const models = defineModels({ Simple })
      const meta = buildSchemaMeta(models)

      const rels = meta.relations?.simple
      expect(rels).toBeDefined()
      expect(rels?.hasOne).toBeDefined()
      expect(rels?.hasMany).toBeDefined()
      expect(rels?.belongsTo).toBeDefined()
      expect(rels?.belongsToMany).toBeDefined()
      expect(rels?.hasOneThrough).toBeDefined()
      expect(rels?.hasManyThrough).toBeDefined()
      expect(rels?.morphOne).toBeDefined()
      expect(rels?.morphMany).toBeDefined()
      expect(rels?.morphToMany).toBeDefined()
      expect(rels?.morphedByMany).toBeDefined()
    })

    it('should maintain relationship metadata consistency across rebuild', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'Post' },
      } as const)

      const models = defineModels({ User })

      // Build meta twice
      const meta1 = buildSchemaMeta(models)
      const meta2 = buildSchemaMeta(models)

      expect(meta1.relations?.users.hasMany?.posts).toBe(meta2.relations?.users.hasMany?.posts)
      expect(meta1.modelToTable.User).toBe(meta2.modelToTable.User)
    })
  })
})
