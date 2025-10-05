/**
 * Relationship Edge Cases and Advanced Scenarios Tests
 *
 * Tests for complex scenarios, edge cases, and error conditions in relationships.
 */
import { describe, expect, it } from 'bun:test'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModel, defineModels } from '../src'
import { mockQueryBuilderState } from './utils'

describe('relationship edge cases', () => {
  describe('self-referential relationships', () => {
    it('should handle self-referential hasMany (e.g., user has many followers)', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          parent_id: { validation: { rule: { validate: (_v: number | null) => true } as any } },
        },
        hasMany: { children: 'User' },
        belongsTo: { parent: 'User' },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.hasMany?.children).toBe('User')
      expect(meta.relations?.users.belongsTo?.parent).toBe('User')
    })

    it('should handle self-referential belongsToMany (e.g., user follows users)', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsToMany: { followers: 'User', following: 'User' },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.belongsToMany?.followers).toBe('User')
      expect(meta.relations?.users.belongsToMany?.following).toBe('User')
    })

    it('should allow chaining self-referential relationships', () => {
      const Category = defineModel({
        name: 'Category',
        table: 'categories',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          parent_id: { validation: { rule: { validate: (_v: number | null) => true } as any } },
        },
        hasMany: { subcategories: 'Category' },
        belongsTo: { parent: 'Category' },
      } as const)

      const models = defineModels({ Category })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('categories').with('subcategories')
      }).not.toThrow()

      expect(() => {
        db.selectFrom('categories').with('parent')
      }).not.toThrow()
    })
  })

  describe('circular relationships', () => {
    it('should handle circular relationships between models', () => {
      const Author = defineModel({
        name: 'Author',
        table: 'authors',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { books: 'Book' },
      } as const)

      const Book = defineModel({
        name: 'Book',
        table: 'books',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          author_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { author: 'Author' },
        hasMany: { reviews: 'Review' },
      } as const)

      const Review = defineModel({
        name: 'Review',
        table: 'reviews',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          book_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { book: 'Book' },
      } as const)

      const models = defineModels({ Author, Book, Review })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.authors.hasMany?.books).toBe('Book')
      expect(meta.relations?.books.belongsTo?.author).toBe('Author')
      expect(meta.relations?.books.hasMany?.reviews).toBe('Review')
      expect(meta.relations?.reviews.belongsTo?.book).toBe('Book')
    })

    it('should handle deeply nested circular relationships', () => {
      const A = defineModel({
        name: 'A',
        table: 'a_table',
        attributes: { id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } } },
        hasMany: { bs: 'B' },
      } as const)

      const B = defineModel({
        name: 'B',
        table: 'b_table',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          a_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { a: 'A' },
        hasMany: { cs: 'C' },
      } as const)

      const C = defineModel({
        name: 'C',
        table: 'c_table',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          b_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { b: 'B', a: 'A' },
      } as const)

      const models = defineModels({ A, B, C })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('a_table').with('bs.cs')
      }).not.toThrow()
    })
  })

  describe('custom primary keys', () => {
    it('should respect custom primary key names', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        primaryKey: 'user_uuid',
        attributes: {
          user_uuid: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
        },
        hasMany: { posts: 'Post' },
      } as const)

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        primaryKey: 'post_id',
        attributes: {
          post_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_uuid: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
        },
        belongsTo: { user: 'User' },
      } as const)

      const models = defineModels({ User, Post })
      const meta = buildSchemaMeta(models)

      expect(meta.primaryKeys.users).toBe('user_uuid')
      expect(meta.primaryKeys.posts).toBe('post_id')
    })

    it('should default to "id" when primaryKey not specified', () => {
      const Simple = defineModel({
        name: 'Simple',
        table: 'simple',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const models = defineModels({ Simple })
      const meta = buildSchemaMeta(models)

      expect(meta.primaryKeys.simple).toBe('id')
    })
  })

  describe('table name variations', () => {
    it('should handle explicit table names different from model names', () => {
      const BlogPost = defineModel({
        name: 'BlogPost',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const models = defineModels({ BlogPost })
      const meta = buildSchemaMeta(models)

      expect(meta.modelToTable.BlogPost).toBe('posts')
      expect(meta.tableToModel.posts).toBe('BlogPost')
    })

    it('should infer table names when not specified', () => {
      const User = defineModel({
        name: 'User',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.modelToTable.User).toBe('users')
    })

    it('should handle unconventional table names', () => {
      const Item = defineModel({
        name: 'Item',
        table: 'tbl_items_archive',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const models = defineModels({ Item })
      const meta = buildSchemaMeta(models)

      expect(meta.modelToTable.Item).toBe('tbl_items_archive')
      expect(meta.tableToModel.tbl_items_archive).toBe('Item')
    })
  })

  describe('complex through relationships', () => {
    it('should handle multiple hasManyThrough on same model', () => {
      const Country = defineModel({
        name: 'Country',
        table: 'countries',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { users: 'User' },
        hasManyThrough: {
          posts: { through: 'User', target: 'Post' },
          comments: { through: 'User', target: 'Comment' },
        },
      } as const)

      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          country_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { country: 'Country' },
        hasMany: { posts: 'Post', comments: 'Comment' },
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

      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { user: 'User' },
      } as const)

      const models = defineModels({ Country, User, Post, Comment })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.countries.hasManyThrough?.posts?.through).toBe('User')
      expect(meta.relations?.countries.hasManyThrough?.posts?.target).toBe('Post')
      expect(meta.relations?.countries.hasManyThrough?.comments?.through).toBe('User')
      expect(meta.relations?.countries.hasManyThrough?.comments?.target).toBe('Comment')
    })

    it('should handle chained through relationships (A through B through C)', () => {
      const Organization = defineModel({
        name: 'Organization',
        table: 'organizations',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { departments: 'Department' },
      } as const)

      const Department = defineModel({
        name: 'Department',
        table: 'departments',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          organization_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { organization: 'Organization' },
        hasMany: { employees: 'Employee' },
      } as const)

      const Employee = defineModel({
        name: 'Employee',
        table: 'employees',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          department_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { department: 'Department' },
      } as const)

      const models = defineModels({ Organization, Department, Employee })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('organizations').with('departments.employees')
      }).not.toThrow()
    })
  })

  describe('polymorphic edge cases', () => {
    it('should handle multiple polymorphic relationships on same model', () => {
      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        morphOne: { thumbnail: 'Image' },
        morphMany: { images: 'Image', attachments: 'File' },
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

      const File = defineModel({
        name: 'File',
        table: 'files',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          attachmentable_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          attachmentable_type: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
        },
      } as const)

      const models = defineModels({ Post, Image, File })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.posts.morphOne?.thumbnail).toBe('Image')
      expect(meta.relations?.posts.morphMany?.images).toBe('Image')
      expect(meta.relations?.posts.morphMany?.attachments).toBe('File')
    })

    it('should handle same polymorphic target from multiple sources', () => {
      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        morphMany: { comments: 'Comment' },
      } as const)

      const Video = defineModel({
        name: 'Video',
        table: 'videos',
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

      const models = defineModels({ Post, Video, Comment })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.posts.morphMany?.comments).toBe('Comment')
      expect(meta.relations?.videos.morphMany?.comments).toBe('Comment')
    })
  })

  describe('relationship arrays vs objects', () => {
    it('should handle relationships defined as arrays', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: ['posts', 'comments'] as any,
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.hasMany?.posts).toBe('posts')
      expect(meta.relations?.users.hasMany?.comments).toBe('comments')
    })

    it('should handle relationships defined as objects', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'Post', articles: 'Article' },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.hasMany?.posts).toBe('Post')
      expect(meta.relations?.users.hasMany?.articles).toBe('Article')
    })
  })

  describe('missing or invalid relationship targets', () => {
    it('should handle relationship to non-existent model gracefully', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'NonExistentPost' },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.hasMany?.posts).toBe('NonExistentPost')
      expect(meta.modelToTable.NonExistentPost).toBeUndefined()
    })

    it('should handle with() call for non-existent relation', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
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
        db.selectFrom('users').with('nonExistentRelation')
      }).not.toThrow()
    })
  })

  describe('relationship method chaining order', () => {
    it('should work with where() before with()', () => {
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
        db.selectFrom('users').where({ id: 1 }).with('posts')
      }).not.toThrow()
    })

    it('should work with multiple with() calls', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'Post', comments: 'Comment' },
      } as const)

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const models = defineModels({ User, Post, Comment })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('users').with('posts').with('comments')
      }).not.toThrow()
    })

    it('should work with complex method chains', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          name: { validation: { rule: { validate: (v: string) => typeof v === 'string' } as any } },
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
        db.selectFrom('users')
          .with('posts')
          .where({ id: 1 })
          .orderBy('name', 'asc')
          .limit(10)
          .offset(5)
          .groupBy('name')
      }).not.toThrow()
    })
  })

  describe('stress testing with many relationships', () => {
    it('should handle model with 10+ relationships', () => {
      const Hub = defineModel({
        name: 'Hub',
        table: 'hubs',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: {
          posts: 'Post',
          comments: 'Comment',
          users: 'User',
          tags: 'Tag',
          categories: 'Category',
          files: 'File',
          images: 'Image',
          videos: 'Video',
          audios: 'Audio',
          documents: 'Document',
        },
      } as const)

      const models = defineModels({ Hub })
      const meta = buildSchemaMeta(models)

      const hasMany = meta.relations?.hubs.hasMany || {}
      expect(Object.keys(hasMany).length).toBe(10)
      expect(hasMany.posts).toBe('Post')
      expect(hasMany.documents).toBe('Document')
    })

    it('should handle loading 5+ relationships at once', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { posts: 'Post', comments: 'Comment', likes: 'Like' },
        hasOne: { profile: 'Profile' },
        belongsToMany: { groups: 'Group' },
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
        db.selectFrom('users').with('posts', 'comments', 'likes', 'profile', 'groups')
      }).not.toThrow()
    })

    it('should handle deeply nested relationships (5+ levels)', () => {
      const A = defineModel({
        name: 'A',
        table: 'a',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { bs: 'B' },
      } as const)

      const B = defineModel({
        name: 'B',
        table: 'b',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          a_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { a: 'A' },
        hasMany: { cs: 'C' },
      } as const)

      const C = defineModel({
        name: 'C',
        table: 'c',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          b_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { b: 'B' },
        hasMany: { ds: 'D' },
      } as const)

      const D = defineModel({
        name: 'D',
        table: 'd',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          c_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { c: 'C' },
        hasMany: { es: 'E' },
      } as const)

      const E = defineModel({
        name: 'E',
        table: 'e',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          d_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { d: 'D' },
      } as const)

      const models = defineModels({ A, B, C, D, E })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      expect(() => {
        db.selectFrom('a').with('bs.cs.ds.es')
      }).not.toThrow()
    })
  })

  describe('empty and undefined relationships', () => {
    it('should handle model with no relationships', () => {
      const Standalone = defineModel({
        name: 'Standalone',
        table: 'standalone',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const models = defineModels({ Standalone })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.standalone).toBeDefined()
      expect(meta.relations?.standalone.hasOne).toBeDefined()
      expect(meta.relations?.standalone.hasMany).toBeDefined()
      expect(Object.keys(meta.relations?.standalone.hasOne || {}).length).toBe(0)
    })

    it('should handle empty relationship objects', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: {},
        belongsTo: {},
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(Object.keys(meta.relations?.users.hasMany || {}).length).toBe(0)
      expect(Object.keys(meta.relations?.users.belongsTo || {}).length).toBe(0)
    })
  })

  describe('relationship name edge cases', () => {
    it('should handle relationship names with underscores', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { blog_posts: 'BlogPost', user_comments: 'Comment' },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.hasMany?.blog_posts).toBe('BlogPost')
      expect(meta.relations?.users.hasMany?.user_comments).toBe('Comment')
    })

    it('should handle relationship names that match table names', () => {
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
      } as const)

      const models = defineModels({ User, Post })
      const schema = buildDatabaseSchema(models)
      const meta = buildSchemaMeta(models)

      const db = createQueryBuilder<typeof schema>({
        ...mockQueryBuilderState,
        schema,
        meta,
      })

      // Relation name 'posts' matches table name 'posts'
      expect(() => {
        db.selectFrom('users').with('posts')
      }).not.toThrow()
    })

    it('should handle camelCase relationship names', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        hasMany: { blogPosts: 'BlogPost', userComments: 'Comment' },
      } as const)

      const models = defineModels({ User })
      const meta = buildSchemaMeta(models)

      expect(meta.relations?.users.hasMany?.blogPosts).toBe('BlogPost')
      expect(meta.relations?.users.hasMany?.userComments).toBe('Comment')
    })
  })

  describe('mixed relationship scenarios', () => {
    it('should handle mixing regular and polymorphic relationships', () => {
      const Article = defineModel({
        name: 'Article',
        table: 'articles',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          author_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { author: 'Author' },
        hasMany: { comments: 'Comment' },
        belongsToMany: { tags: 'Tag' },
        morphMany: { images: 'Image' },
        morphToMany: { categories: 'Category' },
      } as const)

      const models = defineModels({ Article })
      const meta = buildSchemaMeta(models)

      const rels = meta.relations?.articles
      expect(rels?.belongsTo?.author).toBe('Author')
      expect(rels?.hasMany?.comments).toBe('Comment')
      expect(rels?.belongsToMany?.tags).toBe('Tag')
      expect(rels?.morphMany?.images).toBe('Image')
      expect(rels?.morphToMany?.categories).toBe('Category')
    })

    it('should handle model being target of multiple relationship types', () => {
      const User = defineModel({
        name: 'User',
        table: 'users',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
      } as const)

      const Post = defineModel({
        name: 'Post',
        table: 'posts',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          author_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { author: 'User' },
      } as const)

      const Comment = defineModel({
        name: 'Comment',
        table: 'comments',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { user: 'User' },
      } as const)

      const Profile = defineModel({
        name: 'Profile',
        table: 'profiles',
        attributes: {
          id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
          user_id: { validation: { rule: { validate: (v: number) => typeof v === 'number' } as any } },
        },
        belongsTo: { user: 'User' },
      } as const)

      const models = defineModels({ User, Post, Comment, Profile })
      const meta = buildSchemaMeta(models)

      // User is target of belongsTo from multiple models
      expect(meta.relations?.posts.belongsTo?.author).toBe('User')
      expect(meta.relations?.comments.belongsTo?.user).toBe('User')
      expect(meta.relations?.profiles.belongsTo?.user).toBe('User')
    })
  })
})
