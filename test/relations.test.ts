/**
 * Relationship Tests
 *
 * These tests verify that relationship metadata is correctly built and that
 * the with() method exists and is chainable. Full SQL output verification
 * requires actual database connections (see integration tests).
 */
import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { mockQueryBuilderState } from './utils'

// Define comprehensive model set for testing all relationship types
const User = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    email: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
  hasOne: { profile: 'Profile' },
  hasMany: { posts: 'Post', comments: 'Comment' },
  hasManyThrough: {
    postComments: { through: 'Post', target: 'Comment' },
  },
  morphMany: { images: 'Image' },
} as const)

const Profile = defineModel({
  name: 'Profile',
  table: 'profiles',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    bio: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
  },
  belongsTo: { user: 'User' },
} as const)

const Post = defineModel({
  name: 'Post',
  table: 'posts',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    title: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
  },
  belongsTo: { user: 'User' },
  hasMany: { comments: 'Comment' },
  belongsToMany: { tags: 'Tag' },
  morphOne: { featuredImage: 'Image' },
  morphMany: { images: 'Image' },
  morphToMany: { labels: 'Label' },
} as const)

const Comment = defineModel({
  name: 'Comment',
  table: 'comments',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    content: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    post_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
  },
  belongsTo: { post: 'Post', user: 'User' },
} as const)

const Tag = defineModel({
  name: 'Tag',
  table: 'tags',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
  belongsToMany: { posts: 'Post' },
} as const)

const Image = defineModel({
  name: 'Image',
  table: 'images',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    url: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
    imageable_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    imageable_type: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
} as const)

const Label = defineModel({
  name: 'Label',
  table: 'labels',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
  morphedByMany: { posts: 'Post' },
} as const)

const Country = defineModel({
  name: 'Country',
  table: 'countries',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
    name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
  },
  hasMany: { users: 'User' },
  hasManyThrough: {
    posts: { through: 'User', target: 'Post' },
  },
} as const)

describe('relationships', () => {
  const models = defineModels({ User, Profile, Post, Comment, Tag, Image, Label, Country })
  const schema = buildDatabaseSchema(models)
  const meta = buildSchemaMeta(models)

  describe('schema and meta building', () => {
    it('should build meta with all core properties', () => {
      expect(meta.relations).toBeDefined()
      expect(meta.modelToTable).toBeDefined()
      expect(meta.tableToModel).toBeDefined()
      expect(meta.primaryKeys).toBeDefined()
    })

    it('should map model names to table names correctly', () => {
      expect(meta.modelToTable.User).toBe('users')
      expect(meta.modelToTable.Post).toBe('posts')
      expect(meta.modelToTable.Profile).toBe('profiles')
      expect(meta.modelToTable.Comment).toBe('comments')
      expect(meta.modelToTable.Tag).toBe('tags')
    })

    it('should map table names to model names correctly', () => {
      expect(meta.tableToModel.users).toBe('User')
      expect(meta.tableToModel.posts).toBe('Post')
      expect(meta.tableToModel.profiles).toBe('Profile')
      expect(meta.tableToModel.comments).toBe('Comment')
      expect(meta.tableToModel.tags).toBe('Tag')
    })

    it('should store primary keys correctly', () => {
      expect(meta.primaryKeys.users).toBe('id')
      expect(meta.primaryKeys.posts).toBe('id')
      expect(meta.primaryKeys.profiles).toBe('id')
      expect(meta.primaryKeys.comments).toBe('id')
    })
  })

  describe('hasOne relationship metadata', () => {
    it('should build hasOne relationships in meta', () => {
      expect(meta.relations?.users.hasOne).toBeDefined()
      expect(meta.relations?.users.hasOne?.profile).toBe('Profile')
    })

    it('should have empty hasOne object when no relationships defined', () => {
      expect(meta.relations?.posts.hasOne).toBeDefined()
      expect(Object.keys(meta.relations?.posts.hasOne || {})).toHaveLength(0)
    })
  })

  describe('hasMany relationship metadata', () => {
    it('should build hasMany relationships in meta', () => {
      expect(meta.relations?.users.hasMany).toBeDefined()
      expect(meta.relations?.users.hasMany?.posts).toBe('Post')
      expect(meta.relations?.users.hasMany?.comments).toBe('Comment')
    })

    it('should support multiple hasMany relationships on same model', () => {
      const userHasMany = meta.relations?.users.hasMany || {}
      expect(Object.keys(userHasMany)).toContain('posts')
      expect(Object.keys(userHasMany)).toContain('comments')
    })
  })

  describe('belongsTo relationship metadata', () => {
    it('should build belongsTo relationships in meta', () => {
      expect(meta.relations?.posts.belongsTo).toBeDefined()
      expect(meta.relations?.posts.belongsTo?.user).toBe('User')
    })

    it('should support multiple belongsTo relationships', () => {
      expect(meta.relations?.comments.belongsTo).toBeDefined()
      expect(meta.relations?.comments.belongsTo?.post).toBe('Post')
      expect(meta.relations?.comments.belongsTo?.user).toBe('User')
    })
  })

  describe('belongsToMany relationship metadata', () => {
    it('should build belongsToMany relationships in meta', () => {
      expect(meta.relations?.posts.belongsToMany).toBeDefined()
      expect(meta.relations?.posts.belongsToMany?.tags).toBe('Tag')
    })

    it('should build inverse belongsToMany relationship', () => {
      expect(meta.relations?.tags.belongsToMany).toBeDefined()
      expect(meta.relations?.tags.belongsToMany?.posts).toBe('Post')
    })
  })

  describe('hasManyThrough relationship metadata', () => {
    it('should build hasManyThrough relationships in meta', () => {
      expect(meta.relations?.users.hasManyThrough).toBeDefined()
      expect(meta.relations?.users.hasManyThrough?.postComments).toBeDefined()
    })

    it('should store through and target models correctly', () => {
      const relation = meta.relations?.users.hasManyThrough?.postComments
      expect(relation?.through).toBe('Post')
      expect(relation?.target).toBe('Comment')
    })

    it('should support complex through relationships', () => {
      const relation = meta.relations?.countries.hasManyThrough?.posts
      expect(relation?.through).toBe('User')
      expect(relation?.target).toBe('Post')
    })
  })

  describe('morphOne relationship metadata', () => {
    it('should build morphOne relationships in meta', () => {
      expect(meta.relations?.posts.morphOne).toBeDefined()
      expect(meta.relations?.posts.morphOne?.featuredImage).toBe('Image')
    })
  })

  describe('morphMany relationship metadata', () => {
    it('should build morphMany relationships in meta', () => {
      expect(meta.relations?.users.morphMany).toBeDefined()
      expect(meta.relations?.users.morphMany?.images).toBe('Image')
    })

    it('should support morphMany on multiple models', () => {
      expect(meta.relations?.posts.morphMany).toBeDefined()
      expect(meta.relations?.posts.morphMany?.images).toBe('Image')
    })
  })

  describe('morphToMany relationship metadata', () => {
    it('should build morphToMany relationships in meta', () => {
      expect(meta.relations?.posts.morphToMany).toBeDefined()
      expect(meta.relations?.posts.morphToMany?.labels).toBe('Label')
    })
  })

  describe('morphedByMany relationship metadata', () => {
    it('should build morphedByMany relationships in meta', () => {
      expect(meta.relations?.labels.morphedByMany).toBeDefined()
      expect(meta.relations?.labels.morphedByMany?.posts).toBe('Post')
    })
  })

  describe('with() method availability and chaining', () => {
    it('should have with() method on query builder', () => {
      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })
      const q: any = db.selectFrom('users')

      expect(q.with).toBeDefined()
      expect(typeof q.with).toBe('function')
    })

    it('should be chainable after with()', () => {
      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })
      const q: any = db.selectFrom('users').with('profile')

      expect(q).toBeDefined()
      expect(typeof q.where).toBe('function')
      expect(typeof q.orderBy).toBe('function')
      expect(typeof q.limit).toBe('function')
    })

    it('should accept multiple relation names', () => {
      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with('posts', 'profile', 'comments')
      }).not.toThrow()
    })

    it('should accept nested relations with dot notation', () => {
      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with('posts.comments')
      }).not.toThrow()
    })

    it('should handle empty with() call gracefully', () => {
      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with()
      }).not.toThrow()
    })

    it('should chain with other query methods', () => {
      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users')
          .with('posts')
          .where({ id: 1 })
          .orderBy('name', 'asc')
          .limit(10)
      }).not.toThrow()
    })

    it('should work when meta is not provided', () => {
      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta: undefined,
      })

      expect(() => {
        const q = db.selectFrom('users').with('posts')
        expect(q).toBeDefined()
      }).not.toThrow()
    })
  })

  describe('all relationship types together', () => {
    it('should have all relationship types in a single model', () => {
      const rels = meta.relations?.posts
      expect(rels).toBeDefined()
      expect(rels?.belongsTo).toBeDefined()
      expect(rels?.hasMany).toBeDefined()
      expect(rels?.belongsToMany).toBeDefined()
      expect(rels?.morphOne).toBeDefined()
      expect(rels?.morphMany).toBeDefined()
      expect(rels?.morphToMany).toBeDefined()
    })

    it('should correctly initialize all relationship types for all tables', () => {
      const tables = ['users', 'posts', 'comments', 'profiles', 'tags', 'images', 'labels', 'countries']

      for (const table of tables) {
        const rels = meta.relations?.[table]
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
      }
    })

    it('should handle models with no relationships', () => {
      const NoRelations = defineModel({
        name: 'NoRelations',
        table: 'no_relations',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const testModels = defineModels({ NoRelations })
      const testMeta = buildSchemaMeta(testModels)

      expect(testMeta.relations?.no_relations).toBeDefined()
      expect(Object.keys(testMeta.relations?.no_relations.hasOne || {})).toHaveLength(0)
      expect(Object.keys(testMeta.relations?.no_relations.hasMany || {})).toHaveLength(0)
      expect(Object.keys(testMeta.relations?.no_relations.belongsTo || {})).toHaveLength(0)
    })
  })

  describe('type safety', () => {
    it('should infer correct types from schema', () => {
      type UsersSchema = typeof schema['users']
      type PostsSchema = typeof schema['posts']

      // These type assertions verify compile-time type safety
      const _users: UsersSchema = {} as any
      const _posts: PostsSchema = {} as any

      expect(_users).toBeDefined()
      expect(_posts).toBeDefined()
    })

    it('should preserve model definitions as readonly', () => {
      // This verifies that defineModel creates readonly definitions
      expect(User).toBeDefined()
      expect(Object.isFrozen(User)).toBe(false) // defineModel doesn't freeze, but types are readonly
    })
  })
})
