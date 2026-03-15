/* eslint-disable unused-imports/no-unused-vars */
/**
 * Comprehensive type-level and runtime test suite for bun-query-builder.
 *
 * This file serves two purposes:
 * 1. Type-level tests: compile-time type checks that verify narrow typing
 *    (types that are too broad or incorrect will cause TS errors).
 * 2. Runtime tests: bun:test assertions for SQL generation, schema inference,
 *    migrations, and query builder behavior.
 */
import type { ColumnName, InsertQueryBuilder, SelectQueryBuilder, UpdateQueryBuilder, DeleteQueryBuilder, WhereOperator } from '../src'
import { describe, expect, test } from 'bun:test'
import { v } from '@stacksjs/ts-validation'
import {
  buildDatabaseSchema,
  buildSchemaMeta,
  createQueryBuilder,
} from '../src'
import { defineModel, defineModels } from '../src/schema'
import type { DatabaseSchema, InferAttributes, InferPrimaryKey, InferTableName } from '../src/schema'
import {
  buildMigrationPlan,
  generateSql,
  generateSqlString,
  generateDiffSql,
} from '../src/migrations'
import { mockQueryBuilderState } from './utils'

// ─── Model Definitions ──────────────────────────────────────────────────────

const User = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  hasMany: { posts: 'Post' },
  hasOne: { profile: 'Profile' },
  attributes: {
    id: { validation: { rule: v.integer() } },
    email: { unique: true, validation: { rule: v.string() } },
    name: { validation: { rule: v.string() } },
    age: { default: 0, validation: { rule: v.integer() } },
    role: { validation: { rule: v.string() } },
    is_active: { validation: { rule: v.boolean() } },
    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },
  },
} as const)

const Profile = defineModel({
  name: 'Profile',
  table: 'profiles',
  primaryKey: 'id',
  belongsTo: { user: 'User' },
  attributes: {
    id: { validation: { rule: v.integer() } },
    user_id: { validation: { rule: v.integer() } },
    bio: { validation: { rule: v.text() } },
    avatar_url: { validation: { rule: v.string() } },
    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },
  },
} as const)

const Post = defineModel({
  name: 'Post',
  table: 'posts',
  primaryKey: 'id',
  belongsTo: { user: 'User' },
  hasMany: { comments: 'Comment', tags: 'Tag' },
  attributes: {
    id: { validation: { rule: v.integer() } },
    user_id: { validation: { rule: v.integer() } },
    title: { validation: { rule: v.string() } },
    body: { validation: { rule: v.text() } },
    published: { validation: { rule: v.boolean() } },
    view_count: { validation: { rule: v.integer() } },
    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },
  },
} as const)

const Comment = defineModel({
  name: 'Comment',
  table: 'comments',
  primaryKey: 'id',
  belongsTo: { post: 'Post', user: 'User' },
  attributes: {
    id: { validation: { rule: v.integer() } },
    post_id: { validation: { rule: v.integer() } },
    user_id: { validation: { rule: v.integer() } },
    content: { validation: { rule: v.text() } },
    is_approved: { validation: { rule: v.boolean() } },
    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },
  },
} as const)

const Tag = defineModel({
  name: 'Tag',
  table: 'tags',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: v.integer() } },
    label: { validation: { rule: v.string() } },
    slug: { validation: { rule: v.string() } },
    created_at: { validation: { rule: v.date() } },
  },
} as const)

// Model with custom primary key for testing non-id PKs
const Session = defineModel({
  name: 'Session',
  table: 'sessions',
  primaryKey: 'token',
  attributes: {
    token: { validation: { rule: v.string() } },
    user_id: { validation: { rule: v.integer() } },
    data: { validation: { rule: v.text() } },
    expires_at: { validation: { rule: v.date() } },
  },
} as const)

// ─── Schema & Query Builder Setup ───────────────────────────────────────────

const models = defineModels({ User, Post, Comment, Profile, Tag, Session })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)
type DB = typeof schema

const db = createQueryBuilder<DB>({ schema, meta })

// Mock-based query builder for SQL text validation
function mockDb() {
  return createQueryBuilder<DB>({
    ...mockQueryBuilderState,
    meta,
    schema,
  })
}

// Helper to extract selected type from a SelectQueryBuilder
type SelectedOf<T> = T extends SelectQueryBuilder<any, any, infer S, any> ? S : never

// Helper: toSQL() returns an object with .sql string, not a plain string
function toSql(queryBuilder: { toSQL: () => any }): string {
  const result = queryBuilder.toSQL()
  if (typeof result === 'string') return result
  if (result && typeof result.sql === 'string') return result.sql
  return String(result)
}

// ─── Type-level Utility: Asserting Types ─────────────────────────────────────
type Expect<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Not<T extends boolean> = T extends true ? false : true
type Extends<A, B> = A extends B ? true : false

// =============================================================================
// COMPILE-TIME TYPE ASSERTIONS
// =============================================================================

// ─── Schema Shape ────────────────────────────────────────────────────────────

type _AssertTablesExist = Expect<Equal<keyof DB, 'users' | 'posts' | 'comments' | 'profiles' | 'tags' | 'sessions'>>

// ─── Column Type Inference from Validators ──────────────────────────────────

type UsersColumns = DB['users']['columns']
type _AssertUserId = Expect<Equal<UsersColumns['id'], number>>
type _AssertUserEmail = Expect<Equal<UsersColumns['email'], string>>
type _AssertUserName = Expect<Equal<UsersColumns['name'], string>>
type _AssertUserAge = Expect<Equal<UsersColumns['age'], number>>
type _AssertUserRole = Expect<Equal<UsersColumns['role'], string>>
type _AssertUserIsActive = Expect<Equal<UsersColumns['is_active'], boolean>>
type _AssertUserCreatedAt = Expect<Equal<UsersColumns['created_at'], string | Date>>
type _AssertUserUpdatedAt = Expect<Equal<UsersColumns['updated_at'], string | Date>>

type PostsColumns = DB['posts']['columns']
type _AssertPostId = Expect<Equal<PostsColumns['id'], number>>
type _AssertPostUserId = Expect<Equal<PostsColumns['user_id'], number>>
type _AssertPostTitle = Expect<Equal<PostsColumns['title'], string>>
type _AssertPostBody = Expect<Equal<PostsColumns['body'], string>>
type _AssertPostPublished = Expect<Equal<PostsColumns['published'], boolean>>
type _AssertPostViewCount = Expect<Equal<PostsColumns['view_count'], number>>

type CommentsColumns = DB['comments']['columns']
type _AssertCommentId = Expect<Equal<CommentsColumns['id'], number>>
type _AssertCommentPostId = Expect<Equal<CommentsColumns['post_id'], number>>
type _AssertCommentUserId = Expect<Equal<CommentsColumns['user_id'], number>>
type _AssertCommentContent = Expect<Equal<CommentsColumns['content'], string>>
type _AssertCommentIsApproved = Expect<Equal<CommentsColumns['is_approved'], boolean>>

type TagsColumns = DB['tags']['columns']
type _AssertTagId = Expect<Equal<TagsColumns['id'], number>>
type _AssertTagLabel = Expect<Equal<TagsColumns['label'], string>>
type _AssertTagSlug = Expect<Equal<TagsColumns['slug'], string>>

type SessionsColumns = DB['sessions']['columns']
type _AssertSessionToken = Expect<Equal<SessionsColumns['token'], string>>
type _AssertSessionUserId = Expect<Equal<SessionsColumns['user_id'], number>>
type _AssertSessionData = Expect<Equal<SessionsColumns['data'], string>>

// ─── Primary Key Inference ──────────────────────────────────────────────────

type _AssertUsersPK = Expect<Equal<DB['users']['primaryKey'], 'id'>>
type _AssertPostsPK = Expect<Equal<DB['posts']['primaryKey'], 'id'>>
type _AssertSessionsPK = Expect<Equal<DB['sessions']['primaryKey'], 'token'>>

// ─── InferTableName ─────────────────────────────────────────────────────────

type _AssertInferTableUser = Expect<Equal<InferTableName<typeof User>, 'users'>>
type _AssertInferTablePost = Expect<Equal<InferTableName<typeof Post>, 'posts'>>
type _AssertInferTableSession = Expect<Equal<InferTableName<typeof Session>, 'sessions'>>

// ─── InferPrimaryKey ────────────────────────────────────────────────────────

type _AssertInferPKUser = Expect<Equal<InferPrimaryKey<typeof User>, 'id'>>
type _AssertInferPKSession = Expect<Equal<InferPrimaryKey<typeof Session>, 'token'>>

// ─── ColumnName helper ──────────────────────────────────────────────────────

type UserColumnNames = ColumnName<DB, 'users'>
type _AssertColumnNamesIncludeId = Expect<Extends<'id', UserColumnNames>>
type _AssertColumnNamesIncludeEmail = Expect<Extends<'email', UserColumnNames>>
type _AssertColumnNamesNotIncludeInvalid = Expect<Not<Extends<'invalid_column', UserColumnNames>>>

// ─── selectFrom Return Type ─────────────────────────────────────────────────

type SelectFromUsersType = SelectedOf<ReturnType<typeof db.selectFrom<'users'>>>
type _AssertSelectFromUsers = Expect<Equal<SelectFromUsersType, UsersColumns>>

type SelectFromPostsType = SelectedOf<ReturnType<typeof db.selectFrom<'posts'>>>
type _AssertSelectFromPosts = Expect<Equal<SelectFromPostsType, PostsColumns>>

type SelectFromSessionsType = SelectedOf<ReturnType<typeof db.selectFrom<'sessions'>>>
type _AssertSelectFromSessions = Expect<Equal<SelectFromSessionsType, SessionsColumns>>

// ─── Where Clause Narrow Typing ─────────────────────────────────────────────

const _whereObjValid = db.selectFrom('users').where({ id: 1 })
const _whereObjMulti = db.selectFrom('users').where({ id: 1, email: 'test@test.com' })
const _whereId = db.selectFrom('users').whereId(42)
const _whereEmail = db.selectFrom('users').whereEmail('test@example.com')
const _whereName = db.selectFrom('users').whereName('Alice')
const _whereIsActive = db.selectFrom('users').whereIsActive(true)
const _whereAge = db.selectFrom('users').whereAge(25)
const _orWhereEmail = db.selectFrom('users').orWhereEmail('bob@example.com')
const _andWhereName = db.selectFrom('users').andWhereName('Bob')
const _whereTitle = db.selectFrom('posts').whereTitle('Hello World')
const _wherePublished = db.selectFrom('posts').wherePublished(true)
const _whereUserId = db.selectFrom('posts').whereUserId(1)
const _whereViewCount = db.selectFrom('posts').whereViewCount(100)
const _whereIsApproved = db.selectFrom('comments').whereIsApproved(true)

// ─── Insert Typing ──────────────────────────────────────────────────────────

const _insertUser = db.insertInto('users').values({ email: 'a@b.com', name: 'A' })
const _insertPost = db.insertInto('posts').values({ title: 'Hello', body: 'World', user_id: 1, published: true })
const _insertComment = db.insertInto('comments').values({ post_id: 1, user_id: 2, content: 'Nice!' })

// Returning narrows to requested columns
const _insertReturning = db.insertInto('users').values({ email: 'a@b.com' }).returning('id', 'email')
type InsertReturningType = SelectedOf<typeof _insertReturning>
type _AssertInsertReturning = Expect<Equal<InsertReturningType, Pick<UsersColumns, 'id' | 'email'>>>

// returningAll returns all columns
const _insertReturningAll = db.insertInto('users').values({ email: 'a@b.com' }).returningAll()
type InsertReturningAllType = SelectedOf<typeof _insertReturningAll>
type _AssertInsertReturningAll = Expect<Equal<InsertReturningAllType, UsersColumns>>

// ─── Update Typing ──────────────────────────────────────────────────────────

const _updateUser = db.updateTable('users').set({ name: 'Updated' }).where({ id: 1 })
const _updateReturning = db.updateTable('users').set({ name: 'Updated' }).where({ id: 1 }).returning('id', 'name')
type UpdateReturningType = SelectedOf<typeof _updateReturning>
type _AssertUpdateReturning = Expect<Equal<UpdateReturningType, Pick<UsersColumns, 'id' | 'name'>>>

// set() only accepts valid columns
const _updatePost = db.updateTable('posts').set({ title: 'New Title', published: false })

// ─── Delete Typing ──────────────────────────────────────────────────────────

const _deleteUser = db.deleteFrom('users').where({ id: 1 })
const _deleteReturning = db.deleteFrom('users').where({ id: 1 }).returning('id', 'email')
type DeleteReturningType = SelectedOf<typeof _deleteReturning>
type _AssertDeleteReturning = Expect<Equal<DeleteReturningType, Pick<UsersColumns, 'id' | 'email'>>>

// ─── OrderBy Typing ─────────────────────────────────────────────────────────

const _orderById = db.selectFrom('users').orderBy('id', 'desc')
const _orderByEmail = db.selectFrom('users').orderBy('email')
const _orderByCreatedAt = db.selectFrom('users').orderBy('created_at', 'asc')
const _orderByDescId = db.selectFrom('users').orderByDesc('id')

// ─── Join Typing ────────────────────────────────────────────────────────────

const _joinQuery = db.selectFrom('posts').join('users', 'posts.user_id', '=', 'users.id')
const _multiJoinQuery = db.selectFrom('posts')
  .join('users', 'posts.user_id', '=', 'users.id')
  .join('comments', 'comments.post_id', '=', 'posts.id')
const _leftJoinQuery = db.selectFrom('users').leftJoin('posts', 'users.id', '=', 'posts.user_id')
const _rightJoinQuery = db.selectFrom('users').rightJoin('posts', 'users.id', '=', 'posts.user_id')
const _crossJoinQuery = db.selectFrom('users').crossJoin('tags')

// ─── Aggregate Typing ───────────────────────────────────────────────────────

async function _aggregateTypingTests() {
  const _count: number = await db.selectFrom('users').count()
  const _sum: number = await db.selectFrom('posts').sum('view_count')
  const _avg: number = await db.selectFrom('users').avg('age')
  const _max = await db.selectFrom('users').max('age')
  const _min = await db.selectFrom('users').min('id')
}

async function _topLevelAggregates() {
  const _count: number = await db.count('users')
  const _sum: number = await db.sum('posts', 'view_count')
  const _avg: number = await db.avg('users', 'age')
}

// ─── Table API Typing ───────────────────────────────────────────────────────

const _tableInsert = db.table('users').insert({ email: 'x@y.z', name: 'X' })
const _tableUpdate = db.table('users').update({ name: 'Updated' })
const _tableDelete = db.table('users').delete()
const _tableSelect = db.table('users').select('id', 'email')

// ─── CRUD Helpers Typing ────────────────────────────────────────────────────

async function _crudHelperTypes() {
  const created: UsersColumns = await db.create('users', { email: 'a@b.com', name: 'Alice' })
  const found: UsersColumns | undefined = await db.find('users', 1)
  const foundOrFail: UsersColumns = await db.findOrFail('users', 1)
  const foundMany: UsersColumns[] = await db.findMany('users', [1, 2, 3])
  const saved: UsersColumns = await db.save('users', { id: 1, name: 'Updated' })
  const foc: UsersColumns = await db.firstOrCreate('users', { email: 'a@b.com' }, { name: 'A' })
  const uoc: UsersColumns = await db.updateOrCreate('users', { email: 'a@b.com' }, { name: 'B' })
  void created; void found; void foundOrFail; void foundMany; void saved; void foc; void uoc
}

// ─── Chaining Preserves Types ───────────────────────────────────────────────

const _chainedQuery = db.selectFrom('users').where({ id: 1 }).orderBy('created_at', 'desc').limit(10)
type ChainedType = SelectedOf<typeof _chainedQuery>
type _AssertChainedType = Expect<Equal<ChainedType, UsersColumns>>

// ─── whereIn / whereNotIn Typing ────────────────────────────────────────────

const _whereIn = db.selectFrom('users').whereIn('id', [1, 2, 3])
const _whereNotIn = db.selectFrom('users').whereNotIn('role', ['admin', 'superadmin'])
const _orWhereIn = db.selectFrom('users').orWhereIn('id', [4, 5])

// ─── whereLike Typing ───────────────────────────────────────────────────────

const _whereLike = db.selectFrom('users').whereLike('name', '%Ali%')
const _orWhereLike = db.selectFrom('users').orWhereLike('name', 'B%')
const _whereNotLike = db.selectFrom('users').whereNotLike('email', '%spam%')

// ─── whereAny / whereAll / whereNone Typing ─────────────────────────────────

const _whereAny = db.selectFrom('users').whereAny(['name', 'email'], 'like', '%test%')
const _whereAll = db.selectFrom('users').whereAll(['name', 'role'], '=', 'admin')
const _whereNone = db.selectFrom('users').whereNone(['name', 'email'], '=', 'banned')

// ─── Relation loading ───────────────────────────────────────────────────────

const _withPosts = db.selectFrom('users').with?.('posts')
const _withProfile = db.selectFrom('users').with?.('profile')
const _withMultiple = db.selectFrom('users').with?.('posts', 'profile')
const _withComments = db.selectFrom('posts').with?.('comments')

// ─── Transaction Typing ─────────────────────────────────────────────────────

async function _transactionTypes() {
  const result: string = await db.transaction(async (tx) => {
    await tx.insertInto('users').values({ email: 'tx@test.com', name: 'TxUser' }).execute()
    return 'done'
  })
  void result
}

// ─── Pagination Return Types ────────────────────────────────────────────────

async function _paginationTypes() {
  const paginated = await db.selectFrom('users').paginate(10, 1)
  const _data: readonly UsersColumns[] = paginated.data
  const _meta: { perPage: number, page: number, total: number, lastPage: number } = paginated.meta
  void _data; void _meta
}

// ─── Execution Return Types ─────────────────────────────────────────────────

async function _executionReturnTypes() {
  const rows: readonly UsersColumns[] = await db.selectFrom('users').execute()
  const row: Readonly<UsersColumns> | undefined = await db.selectFrom('users').executeTakeFirst()
  const rowOrThrow: Readonly<UsersColumns> = await db.selectFrom('users').executeTakeFirstOrThrow()
  const getRows: readonly UsersColumns[] = await db.selectFrom('users').get()
  const firstRow: Readonly<UsersColumns> | undefined = await db.selectFrom('users').first()
  const firstOrFail: Readonly<UsersColumns> = await db.selectFrom('users').firstOrFail()
  void rows; void row; void rowOrThrow; void getRows; void firstRow; void firstOrFail
}

// ─── Phantom properties ─────────────────────────────────────────────────────

const _usersRows: UsersColumns[] = db.selectFrom('users').rows
const _usersRow: UsersColumns = db.selectFrom('users').row
const _postsRows: PostsColumns[] = db.selectFrom('posts').rows

// ─── Bulk insert ────────────────────────────────────────────────────────────

const _bulkInsert = db.insertInto('users').values([
  { email: 'a@b.com', name: 'A' },
  { email: 'b@c.com', name: 'B' },
])

// ─── Multi-table join ───────────────────────────────────────────────────────

const _commentWithPostAndUser = db
  .selectFrom('comments')
  .join('posts', 'comments.post_id', '=', 'posts.id')
  .join('users', 'comments.user_id', '=', 'users.id')

// ─── Soft deletes / Cache / Locks / Clone ───────────────────────────────────

const _withTrashed = db.selectFrom('users').withTrashed?.()
const _onlyTrashed = db.selectFrom('users').onlyTrashed?.()
const _cached = db.selectFrom('users').cache?.(5000)
const _forUpdate = db.selectFrom('users').lockForUpdate()
const _sharedLock = db.selectFrom('users').sharedLock()
const _cloned = db.selectFrom('users').clone?.()

// =============================================================================
// RUNTIME TESTS
// =============================================================================

describe('Schema Inference', () => {
  test('buildDatabaseSchema creates correct table keys', () => {
    const tableNames = Object.keys(schema)
    expect(tableNames).toContain('users')
    expect(tableNames).toContain('posts')
    expect(tableNames).toContain('comments')
    expect(tableNames).toContain('profiles')
    expect(tableNames).toContain('tags')
    expect(tableNames).toContain('sessions')
    expect(tableNames).toHaveLength(6)
  })

  test('users columns exist in schema', () => {
    const cols = Object.keys(schema.users.columns)
    expect(cols).toContain('id')
    expect(cols).toContain('email')
    expect(cols).toContain('name')
    expect(cols).toContain('age')
    expect(cols).toContain('role')
    expect(cols).toContain('is_active')
    expect(cols).toContain('created_at')
    expect(cols).toContain('updated_at')
    expect(cols).toHaveLength(8)
  })

  test('posts columns exist in schema', () => {
    const cols = Object.keys(schema.posts.columns)
    expect(cols).toContain('id')
    expect(cols).toContain('user_id')
    expect(cols).toContain('title')
    expect(cols).toContain('body')
    expect(cols).toContain('published')
    expect(cols).toContain('view_count')
  })

  test('comments columns exist with is_approved', () => {
    const cols = Object.keys(schema.comments.columns)
    expect(cols).toContain('is_approved')
    expect(cols).toContain('content')
    expect(cols).toContain('post_id')
    expect(cols).toContain('user_id')
  })

  test('sessions table has custom primary key', () => {
    expect(schema.sessions.primaryKey).toBe('token')
    const cols = Object.keys(schema.sessions.columns)
    expect(cols).toContain('token')
    expect(cols).toContain('user_id')
    expect(cols).toContain('data')
    expect(cols).toContain('expires_at')
  })

  test('primary keys are inferred correctly', () => {
    expect(schema.users.primaryKey).toBe('id')
    expect(schema.posts.primaryKey).toBe('id')
    expect(schema.comments.primaryKey).toBe('id')
    expect(schema.profiles.primaryKey).toBe('id')
    expect(schema.tags.primaryKey).toBe('id')
    expect(schema.sessions.primaryKey).toBe('token')
  })

  test('model without explicit primaryKey defaults to id', () => {
    const Simple = defineModel({
      name: 'Simple',
      table: 'simples',
      attributes: { id: { validation: { rule: v.integer() } }, value: { validation: { rule: v.string() } } },
    } as const)
    const s = buildDatabaseSchema(defineModels({ Simple }))
    expect(s.simples.primaryKey).toBe('id')
  })
})

describe('Schema Meta', () => {
  test('modelToTable mapping', () => {
    expect(meta.modelToTable.User).toBe('users')
    expect(meta.modelToTable.Post).toBe('posts')
    expect(meta.modelToTable.Comment).toBe('comments')
    expect(meta.modelToTable.Profile).toBe('profiles')
    expect(meta.modelToTable.Tag).toBe('tags')
    expect(meta.modelToTable.Session).toBe('sessions')
  })

  test('tableToModel mapping', () => {
    expect(meta.tableToModel.users).toBe('User')
    expect(meta.tableToModel.posts).toBe('Post')
    expect(meta.tableToModel.sessions).toBe('Session')
  })

  test('primaryKeys mapping', () => {
    expect(meta.primaryKeys.users).toBe('id')
    expect(meta.primaryKeys.posts).toBe('id')
    expect(meta.primaryKeys.sessions).toBe('token')
  })

  test('hasMany relations', () => {
    expect(meta.relations!.users.hasMany!.posts).toBe('Post')
    expect(meta.relations!.posts.hasMany!.comments).toBe('Comment')
    expect(meta.relations!.posts.hasMany!.tags).toBe('Tag')
  })

  test('hasOne relations', () => {
    expect(meta.relations!.users.hasOne!.profile).toBe('Profile')
  })

  test('belongsTo relations', () => {
    expect(meta.relations!.posts.belongsTo!.user).toBe('User')
    expect(meta.relations!.comments.belongsTo!.post).toBe('Post')
    expect(meta.relations!.comments.belongsTo!.user).toBe('User')
    expect(meta.relations!.profiles.belongsTo!.user).toBe('User')
  })

  test('model without relations has empty relation maps', () => {
    expect(meta.relations!.tags).toBeDefined()
  })
})

describe('SQL Generation: SELECT', () => {
  test('selectFrom generates SELECT * FROM table', () => {
    const s = toSql(db.selectFrom('users'))
    expect(s).toContain('SELECT')
    expect(s).toContain('users')
  })

  test('select with specific columns', () => {
    const s = toSql(db.select('users', 'id', 'email'))
    expect(s).toContain('id')
    expect(s).toContain('email')
  })

  test('where with object', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }))
    expect(s).toContain('WHERE')
    expect(s).toContain('id')
  })

  test('where with tuple', () => {
    const s = toSql(db.selectFrom('users').where(['age', '>', 18]))
    expect(s).toContain('WHERE')
    expect(s).toContain('age')
    expect(s).toContain('>')
  })

  test('andWhere chains AND', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }).andWhere({ role: 'admin' }))
    expect(s).toContain('AND')
    expect(s).toContain('role')
  })

  test('orWhere chains OR', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }).orWhere({ id: 2 }))
    expect(s).toContain('OR')
  })

  test('orderBy generates ORDER BY', () => {
    const s = toSql(db.selectFrom('users').orderBy('created_at', 'desc'))
    expect(s).toContain('ORDER BY')
    expect(s.toLowerCase()).toContain('desc')
  })

  test('limit generates LIMIT', () => {
    const s = toSql(db.selectFrom('users').limit(10))
    expect(s).toContain('LIMIT')
    expect(s).toContain('10')
  })

  test('offset generates OFFSET', () => {
    const s = toSql(db.selectFrom('users').offset(20))
    expect(s).toContain('OFFSET')
  })

  test('chained where + orderBy + limit + offset', () => {
    const s = toSql(db.selectFrom('users').where({ is_active: true }).orderBy('created_at', 'desc').limit(5).offset(10))
    expect(s).toContain('WHERE')
    expect(s).toContain('ORDER BY')
    expect(s).toContain('LIMIT')
    expect(s).toContain('OFFSET')
  })

  test('groupBy generates GROUP BY', () => {
    const s = toSql(db.selectFrom('users').groupBy('role'))
    expect(s).toContain('GROUP BY')
    expect(s).toContain('role')
  })

  test('groupBy multiple columns', () => {
    const s = toSql(db.selectFrom('users').groupBy('role', 'is_active'))
    expect(s).toContain('GROUP BY')
    expect(s).toContain('role')
    expect(s).toContain('is_active')
  })

  test('whereBetween', () => {
    const s = toSql(db.selectFrom('users').whereBetween('id', 1, 100))
    expect(s).toContain('BETWEEN')
  })

  test('where on posts table', () => {
    const s = toSql(db.selectFrom('posts').where({ published: true }))
    expect(s).toContain('WHERE')
    expect(s).toContain('published')
  })

  test('where on comments table', () => {
    const s = toSql(db.selectFrom('comments').where({ is_approved: true }))
    expect(s).toContain('is_approved')
  })

  test('where on sessions table with custom PK', () => {
    const s = toSql(db.selectFrom('sessions').where({ user_id: 1 }))
    expect(s).toContain('user_id')
  })
})

describe('SQL Generation: JOIN', () => {
  test('join generates JOIN clause', () => {
    const s = toSql(db.selectFrom('posts').join('users', 'posts.user_id', '=', 'users.id'))
    expect(s).toContain('JOIN')
    expect(s).toContain('users')
    expect(s).toContain('posts.user_id')
  })

  test('innerJoin', () => {
    const s = toSql(db.selectFrom('posts').innerJoin('users', 'posts.user_id', '=', 'users.id'))
    expect(s).toContain('INNER JOIN')
  })

  test('leftJoin', () => {
    const s = toSql(db.selectFrom('users').leftJoin('profiles', 'users.id', '=', 'profiles.user_id'))
    expect(s.toUpperCase()).toContain('LEFT')
    expect(s).toContain('profiles')
  })

  test('rightJoin', () => {
    const s = toSql(db.selectFrom('users').rightJoin('posts', 'users.id', '=', 'posts.user_id'))
    expect(s.toUpperCase()).toContain('RIGHT')
  })

  test('crossJoin', () => {
    const s = toSql(db.selectFrom('users').crossJoin('tags'))
    expect(s).toContain('CROSS JOIN')
    expect(s).toContain('tags')
  })

  test('multiple joins', () => {
    const s = toSql(db.selectFrom('comments')
      .join('posts', 'comments.post_id', '=', 'posts.id')
      .join('users', 'comments.user_id', '=', 'users.id'))
    const joinCount = (s.match(/JOIN/gi) || []).length
    expect(joinCount).toBeGreaterThanOrEqual(2)
  })

  test('three-way join: comments → posts → users', () => {
    const s = toSql(db.selectFrom('comments')
      .join('posts', 'comments.post_id', '=', 'posts.id')
      .join('users', 'posts.user_id', '=', 'users.id')
      .where({ is_approved: true })
      .orderBy('created_at', 'desc'))
    expect(s).toContain('comments')
    expect(s).toContain('posts')
    expect(s).toContain('users')
    expect(s).toContain('WHERE')
    expect(s).toContain('ORDER BY')
  })

  test('users with profiles left join', () => {
    const s = toSql(db.selectFrom('users').leftJoin('profiles', 'users.id', '=', 'profiles.user_id'))
    expect(s).toContain('profiles')
  })
})

describe('SQL Generation: INSERT', () => {
  test('insertInto generates INSERT INTO', () => {
    const s = toSql(db.insertInto('users').values({ email: 'a@b.com', name: 'A' }))
    expect(s).toContain('INSERT INTO')
    expect(s).toContain('users')
  })

  test('bulk insert', () => {
    const s = toSql(db.insertInto('users').values([
      { email: 'a@b.com', name: 'A' },
      { email: 'b@c.com', name: 'B' },
    ]))
    expect(s).toContain('INSERT INTO')
  })

  test('insert with returning', () => {
    const s = toSql(db.insertInto('users').values({ email: 'a@b.com' }).returning('id', 'email'))
    expect(s).toContain('RETURNING')
    expect(s).toContain('id')
    expect(s).toContain('email')
  })

  test('insert into posts', () => {
    const s = toSql(db.insertInto('posts').values({ title: 'Hi', body: 'World', user_id: 1, published: true }))
    expect(s).toContain('INSERT INTO')
    expect(s).toContain('posts')
  })

  test('insert into sessions (custom PK)', () => {
    const s = toSql(db.insertInto('sessions').values({ token: 'abc123', user_id: 1, data: '{}' }))
    expect(s).toContain('INSERT INTO')
    expect(s).toContain('sessions')
  })
})

describe('SQL Generation: UPDATE', () => {
  test('updateTable generates UPDATE SET', () => {
    const s = toSql(db.updateTable('users').set({ name: 'Updated' }).where({ id: 1 }))
    expect(s).toContain('UPDATE')
    expect(s).toContain('SET')
  })

  test('update posts', () => {
    const s = toSql(db.updateTable('posts').set({ published: false }).where({ user_id: 1 }))
    expect(s).toContain('UPDATE')
    expect(s).toContain('posts')
  })
})

describe('Query Builder Instance', () => {
  test('selectFrom returns builder with all core methods', () => {
    const qb = db.selectFrom('users')
    const methods = ['where', 'orderBy', 'limit', 'offset', 'toSQL', 'distinct', 'lockForUpdate',
      'sharedLock', 'join', 'leftJoin', 'rightJoin', 'crossJoin', 'groupBy', 'union', 'unionAll',
      'count', 'sum', 'avg', 'max', 'min', 'forPage', 'dump', 'dd', 'whereLike', 'whereNotLike',
      'whereAny', 'whereAll', 'whereNone', 'whereBetween', 'whereNotBetween', 'addSelect',
      'latest', 'oldest', 'inRandomOrder', 'andWhere', 'orWhere', 'whereIn', 'whereNotIn',
      'orWhereIn', 'orWhereNotIn', 'orWhereLike', 'orWhereNotLike', 'orderByDesc',
      'execute', 'executeTakeFirst', 'executeTakeFirstOrThrow', 'get', 'first', 'firstOrFail',
      'find', 'findOrFail', 'paginate', 'simplePaginate', 'pipe', 'tap']
    for (const m of methods) {
      expect(typeof (qb as any)[m]).toBe('function')
    }
  })

  test('insertInto returns builder with values and toSQL', () => {
    const qb = db.insertInto('users')
    expect(typeof qb.values).toBe('function')
    expect(typeof qb.toSQL).toBe('function')
    expect(typeof qb.returning).toBe('function')
    expect(typeof qb.returningAll).toBe('function')
    expect(typeof qb.execute).toBe('function')
  })

  test('updateTable returns builder with set, where, toSQL', () => {
    const qb = db.updateTable('users')
    expect(typeof qb.set).toBe('function')
    expect(typeof qb.where).toBe('function')
    expect(typeof qb.toSQL).toBe('function')
    expect(typeof qb.returning).toBe('function')
    expect(typeof qb.returningAll).toBe('function')
  })

  test('deleteFrom returns builder with where, toSQL', () => {
    const qb = db.deleteFrom('users')
    expect(typeof qb.where).toBe('function')
    expect(typeof qb.toSQL).toBe('function')
    expect(typeof qb.returning).toBe('function')
  })

  test('table returns builder with insert, update, delete, select', () => {
    const qb = db.table('users')
    expect(typeof qb.insert).toBe('function')
    expect(typeof qb.update).toBe('function')
    expect(typeof qb.delete).toBe('function')
    expect(typeof qb.select).toBe('function')
  })

  test('dynamic where methods exist on users selectFrom', () => {
    const qb = db.selectFrom('users')
    for (const col of ['Id', 'Email', 'Name', 'Age', 'Role', 'IsActive', 'CreatedAt', 'UpdatedAt']) {
      expect(typeof (qb as any)[`where${col}`]).toBe('function')
      expect(typeof (qb as any)[`orWhere${col}`]).toBe('function')
      expect(typeof (qb as any)[`andWhere${col}`]).toBe('function')
    }
  })

  test('dynamic where methods exist on posts selectFrom', () => {
    const qb = db.selectFrom('posts')
    for (const col of ['Id', 'UserId', 'Title', 'Body', 'Published', 'ViewCount']) {
      expect(typeof (qb as any)[`where${col}`]).toBe('function')
    }
  })

  test('dynamic where methods exist on comments selectFrom', () => {
    const qb = db.selectFrom('comments')
    for (const col of ['Id', 'PostId', 'UserId', 'Content', 'IsApproved']) {
      expect(typeof (qb as any)[`where${col}`]).toBe('function')
    }
  })

  test('dynamic where methods exist on sessions selectFrom', () => {
    const qb = db.selectFrom('sessions')
    for (const col of ['Token', 'UserId', 'Data', 'ExpiresAt']) {
      expect(typeof (qb as any)[`where${col}`]).toBe('function')
    }
  })
})

describe('SQL Generation: dump/dd', () => {
  test('dump returns the query builder for chaining', () => {
    const qb = db.selectFrom('users').whereId(1).dump()
    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
  })

  test('dd throws after dumping', () => {
    expect(() => { db.selectFrom('users').whereId(1).dd() }).toThrow()
  })
})

describe('Query Builder: fluent chaining', () => {
  test('chaining methods produces cumulative SQL', () => {
    const sqlWhere = toSql(db.selectFrom('users').where({ id: 1 }))
    const sqlOrder = toSql(db.selectFrom('users').orderBy('id'))
    const sqlBoth = toSql(db.selectFrom('users').where({ id: 1 }).orderBy('id'))

    expect(sqlWhere).toContain('WHERE')
    expect(sqlOrder).toContain('ORDER BY')
    expect(sqlBoth).toContain('WHERE')
    expect(sqlBoth).toContain('ORDER BY')
  })

  test('complex multi-clause chain', () => {
    const s = toSql(db.selectFrom('users')
      .where({ is_active: true })
      .andWhere({ role: 'admin' })
      .orderBy('created_at', 'desc')
      .limit(10)
      .offset(20))
    expect(s).toContain('WHERE')
    expect(s).toContain('AND')
    expect(s).toContain('ORDER BY')
    expect(s).toContain('LIMIT')
    expect(s).toContain('OFFSET')
  })

  test('join then where then orderBy then limit', () => {
    const s = toSql(db.selectFrom('posts')
      .join('users', 'posts.user_id', '=', 'users.id')
      .where({ id: 1 })
      .orderBy('created_at', 'desc')
      .limit(5))
    expect(s).toContain('JOIN')
    expect(s).toContain('WHERE')
    expect(s).toContain('ORDER BY')
    expect(s).toContain('LIMIT')
  })

  test('where → orWhere → andWhere', () => {
    const s = toSql(db.selectFrom('users')
      .where({ id: 1 })
      .orWhere({ email: 'test@test.com' })
      .andWhere({ is_active: true }))
    expect(s).toContain('WHERE')
    expect(s).toContain('OR')
    expect(s).toContain('AND')
  })
})

describe('Migration Plan', () => {
  test('generates plans for all models', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    expect(plan.dialect).toBe('postgres')
    expect(plan.tables.length).toBeGreaterThanOrEqual(6)
    const tableNames = plan.tables.map((t: any) => t.table)
    expect(tableNames).toContain('users')
    expect(tableNames).toContain('posts')
    expect(tableNames).toContain('comments')
    expect(tableNames).toContain('profiles')
    expect(tableNames).toContain('tags')
    expect(tableNames).toContain('sessions')
  })

  test('users table columns', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const colNames = usersTable.columns.map((c: any) => c.name)
    expect(colNames).toContain('id')
    expect(colNames).toContain('email')
    expect(colNames).toContain('name')
    expect(colNames).toContain('age')
    expect(colNames).toContain('role')
    expect(colNames).toContain('is_active')
  })

  test('email column is unique', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const emailCol = usersTable.columns.find((c: any) => c.name === 'email')!
    expect(emailCol.isUnique).toBe(true)
  })

  test('id column is primary key', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const idCol = usersTable.columns.find((c: any) => c.name === 'id')!
    expect(idCol.isPrimaryKey).toBe(true)
  })

  test('sessions table has token as PK', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const sessionsTable = plan.tables.find((t: any) => t.table === 'sessions')!
    const tokenCol = sessionsTable.columns.find((c: any) => c.name === 'token')!
    expect(tokenCol.isPrimaryKey).toBe(true)
  })

  test('posts table has user_id column', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const postsTable = plan.tables.find((t: any) => t.table === 'posts')!
    expect(postsTable.columns.find((c: any) => c.name === 'user_id')).toBeDefined()
  })

  test('generateSql produces CREATE TABLE statements', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const stmts = generateSql(plan)
    expect(stmts.length).toBeGreaterThan(0)
    expect(stmts.join('\n')).toContain('CREATE TABLE')
  })

  test('generateSqlString produces a single SQL string', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const sqlString = generateSqlString(plan)
    expect(typeof sqlString).toBe('string')
    expect(sqlString).toContain('CREATE TABLE')
  })

  test('generates valid SQL for all three dialects', () => {
    for (const dialect of ['postgres', 'sqlite', 'mysql'] as const) {
      const plan = buildMigrationPlan(models, { dialect })
      const stmts = generateSql(plan)
      expect(stmts.length).toBeGreaterThan(0)
      expect(stmts.join('\n')).toContain('CREATE TABLE')
    }
  })
})

describe('Migration Plan: Column Type Inference', () => {
  test('integer validator → integer/bigint', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const idCol = usersTable.columns.find((c: any) => c.name === 'id')!
    expect(['integer', 'bigint']).toContain(idCol.type)
  })

  test('string validator → string', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const emailCol = usersTable.columns.find((c: any) => c.name === 'email')!
    expect(emailCol.type).toBe('string')
  })

  test('boolean validator → boolean', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const isActiveCol = usersTable.columns.find((c: any) => c.name === 'is_active')!
    expect(isActiveCol.type).toBe('boolean')
  })

  test('text validator → string or text', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const postsTable = plan.tables.find((t: any) => t.table === 'posts')!
    const bodyCol = postsTable.columns.find((c: any) => c.name === 'body')!
    expect(['string', 'text']).toContain(bodyCol.type)
  })

  test('date validator → date or datetime', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const createdAtCol = usersTable.columns.find((c: any) => c.name === 'created_at')!
    expect(['date', 'datetime']).toContain(createdAtCol.type)
  })

  test('default value preserved in migration plan', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const ageCol = usersTable.columns.find((c: any) => c.name === 'age')!
    expect(ageCol.hasDefault).toBe(true)
    expect(ageCol.defaultValue).toBe(0)
  })
})

describe('Migration Plan: Dialect Differences', () => {
  test('postgres uses SERIAL/BIGSERIAL', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const allSql = generateSql(plan).join('\n')
    expect(allSql.includes('SERIAL') || allSql.includes('GENERATED')).toBe(true)
  })

  test('sqlite uses INTEGER PRIMARY KEY', () => {
    const plan = buildMigrationPlan(models, { dialect: 'sqlite' })
    const allSql = generateSql(plan).join('\n')
    expect(allSql).toContain('INTEGER')
  })

  test('mysql uses auto_increment', () => {
    const plan = buildMigrationPlan(models, { dialect: 'mysql' })
    const allSql = generateSql(plan).join('\n')
    expect(allSql.toLowerCase()).toContain('auto_increment')
  })

  test('postgres generates FK constraints from belongsTo', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const allSql = generateSql(plan).join('\n')
    // Should have ALTER TABLE for FK references
    expect(allSql).toContain('FOREIGN KEY')
    expect(allSql).toContain('REFERENCES')
  })
})

describe('Migration Plan: Diff', () => {
  test('generateDiffSql detects added columns', () => {
    const before = buildMigrationPlan(
      defineModels({
        User: defineModel({
          name: 'User', table: 'users', primaryKey: 'id',
          attributes: { id: { validation: { rule: v.integer() } }, name: { validation: { rule: v.string() } } },
        } as const),
      }),
      { dialect: 'postgres' },
    )

    const after = buildMigrationPlan(
      defineModels({
        User: defineModel({
          name: 'User', table: 'users', primaryKey: 'id',
          attributes: {
            id: { validation: { rule: v.integer() } },
            name: { validation: { rule: v.string() } },
            email: { validation: { rule: v.string() } },
          },
        } as const),
      }),
      { dialect: 'postgres' },
    )

    const diff = generateDiffSql(before, after)
    expect(diff.length).toBeGreaterThan(0)
    const allSql = diff.join('\n')
    expect(allSql).toContain('email')
  })
})

describe('defineModel / defineModels', () => {
  test('preserves model name', () => {
    expect(User.name).toBe('User')
    expect(Post.name).toBe('Post')
    expect(Comment.name).toBe('Comment')
    expect(Session.name).toBe('Session')
  })

  test('preserves table name', () => {
    expect(User.table).toBe('users')
    expect(Post.table).toBe('posts')
    expect(Session.table).toBe('sessions')
  })

  test('preserves primary key', () => {
    expect(User.primaryKey).toBe('id')
    expect(Session.primaryKey).toBe('token')
  })

  test('preserves attributes', () => {
    expect(User.attributes.email.unique).toBe(true)
    expect(User.attributes.age.default).toBe(0)
    expect(User.attributes.name.unique).toBeUndefined()
  })

  test('preserves relations', () => {
    expect(User.hasMany).toEqual({ posts: 'Post' })
    expect(User.hasOne).toEqual({ profile: 'Profile' })
    expect(Post.belongsTo).toEqual({ user: 'User' })
    expect(Post.hasMany).toEqual({ comments: 'Comment', tags: 'Tag' })
    expect(Comment.belongsTo).toEqual({ post: 'Post', user: 'User' })
  })

  test('defineModels preserves all keys', () => {
    expect(models.User).toBe(User)
    expect(models.Post).toBe(Post)
    expect(models.Comment).toBe(Comment)
    expect(models.Session).toBe(Session)
  })
})

describe('Query Builder: top-level methods', () => {
  test('all CRUD helper methods exist', () => {
    const methods = [
      'create', 'createMany', 'insertMany', 'updateMany', 'deleteMany',
      'firstOrCreate', 'updateOrCreate', 'save', 'remove',
      'find', 'findOrFail', 'findMany', 'latest', 'oldest', 'skip',
      'upsert', 'insertOrIgnore', 'insertGetId', 'updateOrInsert',
      'transaction', 'savepoint', 'configure', 'rawQuery',
      'count', 'sum', 'avg', 'min', 'max',
    ]
    for (const m of methods) {
      expect(typeof (db as any)[m]).toBe('function')
    }
  })
})

describe('Mock-based SQL text validation', () => {
  test('mock query builder produces correct SQL text for selectFrom', () => {
    const mdb = mockDb()
    const s = String(mdb.selectFrom('users').toSQL())
    expect(s).toContain('SELECT')
    expect(s).toContain('users')
  })

  test('mock query builder produces WHERE clause', () => {
    const mdb = mockDb()
    const s = String(mdb.selectFrom('users').where({ id: 1 }).toSQL())
    expect(s).toContain('WHERE')
    expect(s).toContain('id')
  })

  test('mock query builder produces ORDER BY', () => {
    const mdb = mockDb()
    const s = String(mdb.selectFrom('users').orderBy('created_at', 'desc').toSQL())
    expect(s).toContain('ORDER BY')
  })

  test('mock query builder produces JOIN', () => {
    const mdb = mockDb()
    const s = String(mdb.selectFrom('posts').join('users', 'posts.user_id', '=', 'users.id').toSQL())
    expect(s).toContain('JOIN')
  })

  test('mock query builder produces INSERT', () => {
    const mdb = mockDb()
    const s = String(mdb.insertInto('users').values({ email: 'a@b.com' }).toSQL())
    expect(s).toContain('INSERT')
  })

  test('mock query builder produces UPDATE', () => {
    const mdb = mockDb()
    const s = String(mdb.updateTable('users').set({ name: 'X' }).where({ id: 1 }).toSQL())
    expect(s).toContain('UPDATE')
  })
})

describe('Edge Cases', () => {
  test('empty where object produces valid SQL', () => {
    const s = toSql(db.selectFrom('users').where({}))
    expect(s).toContain('SELECT')
  })

  test('multiple orderBy calls chain', () => {
    const s = toSql(db.selectFrom('users').orderBy('name', 'asc').orderBy('created_at', 'desc'))
    expect(s).toContain('ORDER BY')
  })

  test('multiple where + multiple orderBy + limit + offset', () => {
    const s = toSql(db.selectFrom('posts')
      .where({ published: true })
      .andWhere({ user_id: 1 })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .limit(10)
      .offset(0))
    expect(s).toContain('WHERE')
    expect(s).toContain('AND')
    expect(s).toContain('LIMIT')
  })

  test('insert into different tables', () => {
    for (const table of ['users', 'posts', 'comments', 'tags', 'sessions'] as const) {
      const qb = db.insertInto(table)
      expect(typeof qb.values).toBe('function')
    }
  })

  test('selectFrom different tables', () => {
    for (const table of ['users', 'posts', 'comments', 'profiles', 'tags', 'sessions'] as const) {
      const qb = db.selectFrom(table)
      expect(typeof qb.where).toBe('function')
      expect(typeof qb.toSQL).toBe('function')
    }
  })

  test('updateTable different tables', () => {
    for (const table of ['users', 'posts', 'comments'] as const) {
      const qb = db.updateTable(table)
      expect(typeof qb.set).toBe('function')
    }
  })

  test('deleteFrom different tables', () => {
    for (const table of ['users', 'posts', 'comments'] as const) {
      const qb = db.deleteFrom(table)
      expect(typeof qb.where).toBe('function')
    }
  })

  test('table API works for all tables', () => {
    for (const table of ['users', 'posts', 'comments'] as const) {
      const qb = db.table(table)
      expect(typeof qb.insert).toBe('function')
      expect(typeof qb.update).toBe('function')
      expect(typeof qb.delete).toBe('function')
      expect(typeof qb.select).toBe('function')
    }
  })
})

describe('Schema: InferTableName edge cases', () => {
  test('explicit table name is used when provided', () => {
    expect('users' in schema).toBe(true)
    expect('posts' in schema).toBe(true)
    expect('sessions' in schema).toBe(true)
  })

  test('tags table columns', () => {
    const tagCols = Object.keys(schema.tags.columns)
    expect(tagCols).toContain('id')
    expect(tagCols).toContain('label')
    expect(tagCols).toContain('slug')
    expect(tagCols).toContain('created_at')
    expect(tagCols).toHaveLength(4)
  })

  test('profiles table columns', () => {
    const profileCols = Object.keys(schema.profiles.columns)
    expect(profileCols).toContain('id')
    expect(profileCols).toContain('user_id')
    expect(profileCols).toContain('bio')
    expect(profileCols).toContain('avatar_url')
  })
})

describe('Multiple schema builds are independent', () => {
  test('building two schemas does not interfere', () => {
    const models1 = defineModels({
      A: defineModel({ name: 'A', table: 'alphas', primaryKey: 'id', attributes: { id: { validation: { rule: v.integer() } } } } as const),
    })
    const models2 = defineModels({
      B: defineModel({ name: 'B', table: 'betas', primaryKey: 'id', attributes: { id: { validation: { rule: v.integer() } }, val: { validation: { rule: v.string() } } } } as const),
    })

    const schema1 = buildDatabaseSchema(models1)
    const schema2 = buildDatabaseSchema(models2)

    expect('alphas' in schema1).toBe(true)
    expect('betas' in schema1).toBe(false)
    expect('betas' in schema2).toBe(true)
    expect('alphas' in schema2).toBe(false)
  })
})

// =============================================================================
// REGRESSION TESTS — verify fixes for methods that previously didn't update
// toSQL() output (only updated the internal `built` query, not the `text`).
// =============================================================================

describe('Regression: toSQL() output for previously broken methods', () => {
  test('orderByDesc includes ORDER BY ... DESC in toSQL()', () => {
    const s = toSql(db.selectFrom('users').orderByDesc('id'))
    expect(s).toContain('ORDER BY')
    expect(s.toLowerCase()).toContain('desc')
    expect(s).toContain('id')
  })

  test('distinct includes DISTINCT in toSQL()', () => {
    const s = toSql(db.selectFrom('users').distinct())
    expect(s).toContain('DISTINCT')
  })

  test('lockForUpdate includes FOR UPDATE in toSQL()', () => {
    const s = toSql(db.selectFrom('users').lockForUpdate())
    expect(s).toContain('FOR UPDATE')
  })

  test('sharedLock includes FOR SHARE or LOCK IN SHARE MODE in toSQL()', () => {
    const s = toSql(db.selectFrom('users').sharedLock())
    expect(s.includes('FOR SHARE') || s.includes('LOCK IN SHARE MODE')).toBe(true)
  })

  test('whereIn includes IN clause in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereIn('id', [1, 2, 3]))
    expect(s).toContain('WHERE')
    expect(s).toContain('IN')
    expect(s).toContain('id')
  })

  test('whereNotIn includes NOT IN clause in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereNotIn('id', [4, 5]))
    expect(s).toContain('NOT IN')
    expect(s).toContain('id')
  })

  test('orWhereIn includes OR IN in toSQL()', () => {
    const s = toSql(db.selectFrom('users').where({ is_active: true }).orWhereIn('id', [1, 2]))
    expect(s).toContain('OR')
    expect(s).toContain('IN')
  })

  test('orWhereNotIn includes OR NOT IN in toSQL()', () => {
    const s = toSql(db.selectFrom('users').where({ is_active: true }).orWhereNotIn('role', ['banned']))
    expect(s).toContain('OR')
    expect(s).toContain('NOT IN')
  })

  test('whereColumn includes column comparison in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereColumn('created_at', '>=', 'updated_at'))
    expect(s).toContain('WHERE')
    expect(s).toContain('created_at')
    expect(s).toContain('>=')
    expect(s).toContain('updated_at')
  })

  test('orWhereColumn includes OR column comparison in toSQL()', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }).orWhereColumn('email', '=', 'name'))
    expect(s).toContain('OR')
    expect(s).toContain('email')
    expect(s).toContain('name')
  })

  test('whereNotBetween includes NOT BETWEEN in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereNotBetween('id', 1, 100))
    expect(s).toContain('NOT BETWEEN')
    expect(s).toContain('id')
  })

  test('forPage includes LIMIT and OFFSET in toSQL()', () => {
    const s = toSql(db.selectFrom('users').forPage(3, 10))
    expect(s).toContain('LIMIT')
    expect(s).toContain('10')
    expect(s).toContain('OFFSET')
    expect(s).toContain('20')
  })

  test('forPage page 1 has OFFSET 0', () => {
    const s = toSql(db.selectFrom('users').forPage(1, 25))
    expect(s).toContain('LIMIT')
    expect(s).toContain('25')
    expect(s).toContain('OFFSET')
    expect(s).toContain('0')
  })

  test('inRandomOrder includes ORDER BY RANDOM() or RAND() in toSQL()', () => {
    const s = toSql(db.selectFrom('users').inRandomOrder())
    expect(s).toContain('ORDER BY')
    expect(s.includes('RANDOM()') || s.includes('RAND()')).toBe(true)
  })

  test('latest includes ORDER BY ... DESC in toSQL()', () => {
    const s = toSql(db.selectFrom('users').latest())
    expect(s).toContain('ORDER BY')
    expect(s.toLowerCase()).toContain('desc')
  })

  test('latest with custom column in toSQL()', () => {
    const s = toSql(db.selectFrom('users').latest('updated_at'))
    expect(s).toContain('updated_at')
    expect(s.toLowerCase()).toContain('desc')
  })

  test('oldest includes ORDER BY ... ASC in toSQL()', () => {
    const s = toSql(db.selectFrom('users').oldest())
    expect(s).toContain('ORDER BY')
    expect(s.toLowerCase()).toContain('asc')
  })

  test('oldest with custom column in toSQL()', () => {
    const s = toSql(db.selectFrom('users').oldest('updated_at'))
    expect(s).toContain('updated_at')
    expect(s.toLowerCase()).toContain('asc')
  })

  test('chaining fixed methods: where + whereIn + orderByDesc', () => {
    const s = toSql(db.selectFrom('users').where({ is_active: true }).whereIn('role', ['admin', 'mod']).orderByDesc('created_at'))
    expect(s).toContain('WHERE')
    expect(s).toContain('IN')
    expect(s).toContain('ORDER BY')
    expect(s.toLowerCase()).toContain('desc')
  })

  test('chaining fixed methods: distinct + where + lockForUpdate', () => {
    const s = toSql(db.selectFrom('users').distinct().where({ is_active: true }).lockForUpdate())
    expect(s).toContain('DISTINCT')
    expect(s).toContain('WHERE')
    expect(s).toContain('FOR UPDATE')
  })

  test('chaining fixed methods: where + whereNotIn + forPage', () => {
    const s = toSql(db.selectFrom('posts').where({ published: true }).whereNotIn('user_id', [1, 2]).forPage(2, 20))
    expect(s).toContain('WHERE')
    expect(s).toContain('NOT IN')
    expect(s).toContain('LIMIT')
    expect(s).toContain('OFFSET')
  })

  test('whereIn with where already present uses AND', () => {
    const s = toSql(db.selectFrom('users').where({ is_active: true }).whereIn('id', [1, 2, 3]))
    expect(s).toContain('WHERE')
    expect(s).toContain('AND')
    expect(s).toContain('IN')
  })

  test('whereNotBetween with where already present uses AND', () => {
    const s = toSql(db.selectFrom('users').where({ is_active: true }).whereNotBetween('age', 18, 65))
    expect(s).toContain('WHERE')
    expect(s).toContain('AND')
    expect(s).toContain('NOT BETWEEN')
  })

  test('whereColumn with where already present uses AND', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }).whereColumn('created_at', '<', 'updated_at'))
    expect(s).toContain('WHERE')
    expect(s).toContain('AND')
    expect(s).toContain('created_at')
  })
})

describe('Regression: batch 2 — whereAny/All/None, Raw methods, union, CTE', () => {
  test('whereAny includes OR conditions in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereAny(['name', 'email'], 'like', '%test%'))
    expect(s).toContain('WHERE')
    expect(s).toContain('name')
    expect(s).toContain('email')
    expect(s).toContain('OR')
  })

  test('whereAll includes AND conditions in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereAll(['name', 'role'], '=', 'admin'))
    expect(s).toContain('WHERE')
    expect(s).toContain('name')
    expect(s).toContain('role')
    expect(s).toContain('AND')
  })

  test('whereNone includes NOT in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereNone(['name', 'email'], '=', 'banned'))
    expect(s).toContain('NOT')
    expect(s).toContain('name')
    expect(s).toContain('email')
  })

  test('whereDate includes column and operator in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereDate('created_at', '>=', '2024-01-01'))
    expect(s).toContain('WHERE')
    expect(s).toContain('created_at')
    expect(s).toContain('>=')
  })

  test('whereRaw includes raw SQL in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereRaw('age > 18'))
    expect(s).toContain('WHERE')
    expect(s).toContain('age > 18')
  })

  test('whereNested includes nested condition in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereNested({ toSQL: () => 'id = 1' }))
    expect(s).toContain('WHERE')
    expect(s).toContain('(')
  })

  test('orWhereNested includes OR nested condition in toSQL()', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }).orWhereNested({ toSQL: () => 'name = \'test\'' }))
    expect(s).toContain('OR')
    expect(s).toContain('(')
  })

  test('groupByRaw includes GROUP BY in toSQL()', () => {
    const s = toSql(db.selectFrom('users').groupByRaw('LOWER(name)'))
    expect(s).toContain('GROUP BY')
    expect(s).toContain('LOWER(name)')
  })

  test('havingRaw includes HAVING in toSQL()', () => {
    const s = toSql(db.selectFrom('users').groupBy('role').havingRaw('COUNT(*) > 1'))
    expect(s).toContain('HAVING')
    expect(s).toContain('COUNT(*) > 1')
  })

  test('orderByRaw includes ORDER BY in toSQL()', () => {
    const s = toSql(db.selectFrom('users').orderByRaw('RANDOM()'))
    expect(s).toContain('ORDER BY')
    expect(s).toContain('RANDOM()')
  })

  test('union includes UNION in toSQL()', () => {
    const q1 = db.selectFrom('users').where({ is_active: true })
    const q2 = db.selectFrom('users').where({ role: 'admin' })
    const s = toSql(q1.union(q2))
    expect(s).toContain('UNION')
    expect(s).not.toContain('UNION ALL')
  })

  test('unionAll includes UNION ALL in toSQL()', () => {
    const q1 = db.selectFrom('users').where({ is_active: true })
    const q2 = db.selectFrom('users').where({ role: 'admin' })
    const s = toSql(q1.unionAll(q2))
    expect(s).toContain('UNION ALL')
  })

  test('withCTE includes WITH ... AS in toSQL()', () => {
    const sub = db.selectFrom('users').where({ is_active: true })
    const s = toSql(db.selectFrom('users').withCTE('active_users', sub))
    expect(s).toContain('WITH')
    expect(s).toContain('active_users')
    expect(s).toContain('AS')
  })

  test('withRecursive includes WITH RECURSIVE in toSQL()', () => {
    const sub = db.selectFrom('users').where({ id: 1 })
    const s = toSql(db.selectFrom('users').withRecursive('tree', sub))
    expect(s).toContain('WITH RECURSIVE')
    expect(s).toContain('tree')
  })

  test('joinSub includes subquery JOIN in toSQL()', () => {
    const sub = db.selectFrom('posts').where({ published: true })
    const s = toSql(db.selectFrom('users').joinSub(sub, 'p', 'users.id', '=', 'p.user_id'))
    expect(s).toContain('JOIN')
    expect(s).toContain('AS p')
    expect(s).toContain('users.id')
  })

  test('leftJoinSub includes LEFT JOIN subquery in toSQL()', () => {
    const sub = db.selectFrom('posts')
    const s = toSql(db.selectFrom('users').leftJoinSub(sub, 'p', 'users.id', '=', 'p.user_id'))
    expect(s).toContain('LEFT JOIN')
    expect(s).toContain('AS p')
  })

  test('crossJoinSub includes CROSS JOIN subquery in toSQL()', () => {
    const sub = db.selectFrom('tags')
    const s = toSql(db.selectFrom('users').crossJoinSub(sub, 't'))
    expect(s).toContain('CROSS JOIN')
    expect(s).toContain('AS t')
  })

  test('chaining: whereAny + orderByRaw + forPage', () => {
    const s = toSql(db.selectFrom('users')
      .whereAny(['name', 'email'], 'like', '%x%')
      .orderByRaw('created_at DESC')
      .forPage(2, 10))
    expect(s).toContain('WHERE')
    expect(s).toContain('OR')
    expect(s).toContain('ORDER BY')
    expect(s).toContain('LIMIT')
    expect(s).toContain('OFFSET')
  })

  test('chaining: groupBy + havingRaw + orderByDesc', () => {
    const s = toSql(db.selectFrom('users')
      .groupBy('role')
      .havingRaw('COUNT(*) > 5')
      .orderByDesc('role'))
    expect(s).toContain('GROUP BY')
    expect(s).toContain('HAVING')
    expect(s).toContain('ORDER BY')
    expect(s.toLowerCase()).toContain('desc')
  })

  test('chaining: withCTE + where + limit', () => {
    const sub = db.selectFrom('users').where({ is_active: true })
    const s = toSql(db.selectFrom('users').withCTE('active', sub).where({ role: 'admin' }).limit(10))
    expect(s).toContain('WITH')
    expect(s).toContain('active')
    expect(s).toContain('WHERE')
    expect(s).toContain('LIMIT')
  })
})

describe('Regression: batch 3 — SELECT modifiers, window functions, delete/update builders', () => {
  test('distinctOn includes DISTINCT ON in toSQL()', () => {
    const s = toSql(db.selectFrom('users').distinctOn('email'))
    expect(s).toContain('DISTINCT ON')
    expect(s).toContain('email')
  })

  test('selectRaw appends raw fragment to SELECT list', () => {
    const s = toSql(db.selectFrom('users').selectRaw('COUNT(*) as total'))
    expect(s).toContain('COUNT(*) as total')
    expect(s).toContain('FROM users')
  })

  test('addSelect appends columns to SELECT list', () => {
    const s = toSql(db.selectFrom('users').addSelect('email', 'name'))
    expect(s).toContain('email')
    expect(s).toContain('name')
    expect(s).toContain('FROM users')
  })

  test('rowNumber includes ROW_NUMBER() OVER in toSQL()', () => {
    const s = toSql(db.selectFrom('users').rowNumber('rn', 'role', [['id', 'asc']]))
    expect(s).toContain('ROW_NUMBER()')
    expect(s).toContain('OVER')
    expect(s).toContain('PARTITION BY role')
    expect(s).toContain('ORDER BY id ASC')
    expect(s).toContain('AS rn')
  })

  test('rowNumber without partition or order uses OVER ()', () => {
    const s = toSql(db.selectFrom('users').rowNumber('rn'))
    expect(s).toContain('ROW_NUMBER()')
    expect(s).toContain('OVER ()')
  })

  test('denseRank includes DENSE_RANK() OVER in toSQL()', () => {
    const s = toSql(db.selectFrom('users').denseRank('dr', 'role', [['id', 'desc']]))
    expect(s).toContain('DENSE_RANK()')
    expect(s).toContain('PARTITION BY role')
    expect(s).toContain('ORDER BY id DESC')
    expect(s).toContain('AS dr')
  })

  test('rank includes RANK() OVER in toSQL()', () => {
    const s = toSql(db.selectFrom('users').rank('r'))
    expect(s).toContain('RANK()')
    expect(s).toContain('OVER ()')
    expect(s).toContain('AS r')
  })

  test('whereJsonContains includes @> in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereJsonContains('name', { key: 'val' }))
    expect(s).toContain('WHERE')
    expect(s).toContain('name')
    expect(s).toContain('@>')
  })

  test('whereJsonPath includes path expression in toSQL()', () => {
    const s = toSql(db.selectFrom('users').whereJsonPath('data->key', '=', 'val'))
    expect(s).toContain('WHERE')
    expect(s).toContain('data->key')
  })

  test('deleteFrom.toSQL() returns proper SQL string', () => {
    const s = toSql(db.deleteFrom('users'))
    expect(s).toContain('DELETE FROM')
    expect(s).toContain('users')
  })

  test('deleteFrom.where().toSQL() includes WHERE', () => {
    const s = toSql(db.deleteFrom('users').where({ id: 1 }))
    expect(s).toContain('DELETE FROM')
    expect(s).toContain('WHERE')
    expect(s).toContain('id')
  })

  test('deleteFrom.where().returning().toSQL() includes RETURNING', () => {
    const s = toSql(db.deleteFrom('users').where({ id: 1 }).returning('id'))
    expect(s).toContain('DELETE FROM')
    expect(s).toContain('WHERE')
    expect(s).toContain('RETURNING')
    expect(s).toContain('id')
  })

  test('updateTable.set().where().returning().toSQL() includes RETURNING', () => {
    const s = toSql(db.updateTable('users').set({ name: 'X' }).where({ id: 1 }).returning('id', 'name'))
    expect(s).toContain('UPDATE')
    expect(s).toContain('SET')
    expect(s).toContain('WHERE')
    expect(s).toContain('RETURNING')
    expect(s).toContain('id')
    expect(s).toContain('name')
  })

  test('chaining: selectRaw + where + orderByDesc', () => {
    const s = toSql(db.selectFrom('users').selectRaw('COUNT(*) as total').where({ is_active: true }).orderByDesc('created_at'))
    expect(s).toContain('COUNT(*) as total')
    expect(s).toContain('WHERE')
    expect(s).toContain('ORDER BY')
    expect(s.toLowerCase()).toContain('desc')
  })

  test('chaining: addSelect + groupBy + havingRaw', () => {
    const s = toSql(db.selectFrom('users').addSelect('role').groupBy('role').havingRaw('COUNT(*) > 3'))
    expect(s).toContain('role')
    expect(s).toContain('GROUP BY')
    expect(s).toContain('HAVING')
  })

  test('chaining: rowNumber + where + limit', () => {
    const s = toSql(db.selectFrom('users').rowNumber('rn', undefined, [['id', 'asc']]).where({ is_active: true }).limit(10))
    expect(s).toContain('ROW_NUMBER()')
    expect(s).toContain('WHERE')
    expect(s).toContain('LIMIT')
  })

  test('deleteFrom with 3-arg where format', () => {
    const s = toSql(db.deleteFrom('users').where('id', '=', 1))
    expect(s).toContain('DELETE FROM')
    expect(s).toContain('WHERE')
  })

  test('deleteFrom with array where format', () => {
    const s = toSql(db.deleteFrom('users').where(['id', '>', 100]))
    expect(s).toContain('DELETE FROM')
    expect(s).toContain('WHERE')
    expect(s).toContain('>')
  })
})

describe('Query builder isolation', () => {
  test('two query builders from same schema are independent', () => {
    const db1 = createQueryBuilder<DB>({ schema, meta })
    const db2 = createQueryBuilder<DB>({ schema, meta })

    const s1 = toSql(db1.selectFrom('users').where({ id: 1 }))
    const s2 = toSql(db2.selectFrom('posts').where({ published: true }))

    expect(s1).toContain('users')
    expect(s1).toContain('id')
    expect(s2).toContain('posts')
    expect(s2).toContain('published')
  })
})
