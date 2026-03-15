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
import type { SelectQueryBuilder } from './packages/bun-query-builder/src'
import { describe, expect, test } from 'bun:test'
import { v } from '@stacksjs/ts-validation'
import {
  buildDatabaseSchema,
  buildSchemaMeta,
  createQueryBuilder,
} from './packages/bun-query-builder/src'
// Import defineModel/defineModels from schema.ts directly (model.ts wraps in a server model)
import { defineModel, defineModels } from './packages/bun-query-builder/src/schema'
import {
  buildMigrationPlan,
  generateSql,
  generateSqlString,
} from './packages/bun-query-builder/src/migrations'

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
  hasMany: { comments: 'Comment' },
  attributes: {
    id: { validation: { rule: v.integer() } },
    user_id: { validation: { rule: v.integer() } },
    title: { validation: { rule: v.string() } },
    body: { validation: { rule: v.text() } },
    published: { validation: { rule: v.boolean() } },
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

// ─── Schema & Query Builder Setup ───────────────────────────────────────────

const models = defineModels({ User, Post, Comment, Profile, Tag })
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)
type DB = typeof schema

const db = createQueryBuilder<DB>({ schema, meta })

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
// These helpers cause compile errors if types are wrong.
type Expect<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false

// ─── Type-level Tests: Schema Shape ──────────────────────────────────────────

// Schema should have exactly these table keys
type _AssertTablesExist = Expect<Equal<keyof DB, 'users' | 'posts' | 'comments' | 'profiles' | 'tags'>>

// users table should have correct column types
type UsersColumns = DB['users']['columns']
type _AssertUserId = Expect<Equal<UsersColumns['id'], number>>
type _AssertUserEmail = Expect<Equal<UsersColumns['email'], string>>
type _AssertUserName = Expect<Equal<UsersColumns['name'], string>>
type _AssertUserAge = Expect<Equal<UsersColumns['age'], number>>
type _AssertUserRole = Expect<Equal<UsersColumns['role'], string>>
type _AssertUserIsActive = Expect<Equal<UsersColumns['is_active'], boolean>>
// Date validators produce `string | Date` because test(value: string | Date)
type _AssertUserCreatedAt = Expect<Equal<UsersColumns['created_at'], string | Date>>
type _AssertUserUpdatedAt = Expect<Equal<UsersColumns['updated_at'], string | Date>>

// posts table should have correct column types
type PostsColumns = DB['posts']['columns']
type _AssertPostId = Expect<Equal<PostsColumns['id'], number>>
type _AssertPostUserId = Expect<Equal<PostsColumns['user_id'], number>>
type _AssertPostTitle = Expect<Equal<PostsColumns['title'], string>>
type _AssertPostBody = Expect<Equal<PostsColumns['body'], string>>
type _AssertPostPublished = Expect<Equal<PostsColumns['published'], boolean>>

// comments table column types
type CommentsColumns = DB['comments']['columns']
type _AssertCommentId = Expect<Equal<CommentsColumns['id'], number>>
type _AssertCommentPostId = Expect<Equal<CommentsColumns['post_id'], number>>
type _AssertCommentUserId = Expect<Equal<CommentsColumns['user_id'], number>>
type _AssertCommentContent = Expect<Equal<CommentsColumns['content'], string>>

// Primary keys
type _AssertUsersPK = Expect<Equal<DB['users']['primaryKey'], 'id'>>
type _AssertPostsPK = Expect<Equal<DB['posts']['primaryKey'], 'id'>>
type _AssertCommentsPK = Expect<Equal<DB['comments']['primaryKey'], 'id'>>

// ─── Type-level Tests: selectFrom Returns Full Row ──────────────────────────

type SelectFromUsersType = SelectedOf<ReturnType<typeof db.selectFrom<'users'>>>
type _AssertSelectFromUsersHasAllColumns = Expect<Equal<SelectFromUsersType, UsersColumns>>

type SelectFromPostsType = SelectedOf<ReturnType<typeof db.selectFrom<'posts'>>>
type _AssertSelectFromPostsHasAllColumns = Expect<Equal<SelectFromPostsType, PostsColumns>>

// ─── Type-level Tests: Where Clause Typing ───────────────────────────────────

// where({}) should accept valid columns with correct types
const _whereObjValid = db.selectFrom('users').where({ id: 1 })
const _whereObjMulti = db.selectFrom('users').where({ id: 1, email: 'test@test.com' })

// Dynamic where methods should be narrowly typed
const _whereId = db.selectFrom('users').whereId(42)
const _whereEmail = db.selectFrom('users').whereEmail('test@example.com')
const _whereName = db.selectFrom('users').whereName('Alice')
const _whereIsActive = db.selectFrom('users').whereIsActive(true)
const _whereAge = db.selectFrom('users').whereAge(25)

// orWhere dynamic
const _orWhereEmail = db.selectFrom('users').orWhereEmail('bob@example.com')

// andWhere dynamic
const _andWhereName = db.selectFrom('users').andWhereName('Bob')

// Dynamic where on posts
const _whereTitle = db.selectFrom('posts').whereTitle('Hello World')
const _wherePublished = db.selectFrom('posts').wherePublished(true)
const _whereUserId = db.selectFrom('posts').whereUserId(1)

// ─── Type-level Tests: Insert Typing ─────────────────────────────────────────

// Insert should accept Partial<columns> and reject invalid columns
const _insertUser = db.insertInto('users').values({ email: 'a@b.com', name: 'A' })
const _insertPost = db.insertInto('posts').values({ title: 'Hello', body: 'World', user_id: 1, published: true })
const _insertComment = db.insertInto('comments').values({ post_id: 1, user_id: 2, content: 'Nice!' })

// Insert returning should narrow to requested columns
const _insertReturning = db.insertInto('users').values({ email: 'a@b.com' }).returning('id', 'email')
type InsertReturningType = SelectedOf<typeof _insertReturning>
type _AssertInsertReturning = Expect<Equal<InsertReturningType, Pick<UsersColumns, 'id' | 'email'>>>

// returningAll should return all columns
const _insertReturningAll = db.insertInto('users').values({ email: 'a@b.com' }).returningAll()
type InsertReturningAllType = SelectedOf<typeof _insertReturningAll>
type _AssertInsertReturningAll = Expect<Equal<InsertReturningAllType, UsersColumns>>

// ─── Type-level Tests: Update Typing ─────────────────────────────────────────

// set() should accept Partial<columns>
const _updateUser = db.updateTable('users').set({ name: 'Updated' }).where({ id: 1 })

// returning should narrow
const _updateReturning = db.updateTable('users').set({ name: 'Updated' }).where({ id: 1 }).returning('id', 'name')
type UpdateReturningType = SelectedOf<typeof _updateReturning>
type _AssertUpdateReturning = Expect<Equal<UpdateReturningType, Pick<UsersColumns, 'id' | 'name'>>>

// ─── Type-level Tests: Delete Typing ─────────────────────────────────────────

const _deleteUser = db.deleteFrom('users').where({ id: 1 })
const _deleteReturning = db.deleteFrom('users').where({ id: 1 }).returning('id', 'email')
type DeleteReturningType = SelectedOf<typeof _deleteReturning>
type _AssertDeleteReturning = Expect<Equal<DeleteReturningType, Pick<UsersColumns, 'id' | 'email'>>>

// ─── Type-level Tests: OrderBy Typing ────────────────────────────────────────

// orderBy should only accept valid column names
const _orderById = db.selectFrom('users').orderBy('id', 'desc')
const _orderByEmail = db.selectFrom('users').orderBy('email')
const _orderByCreatedAt = db.selectFrom('users').orderBy('created_at', 'asc')

// orderByDesc should accept valid column names
const _orderByDescId = db.selectFrom('users').orderByDesc('id')

// ─── Type-level Tests: Join Typing ──────────────────────────────────────────

// join should infer joined columns for onLeft/onRight
const _joinQuery = db
  .selectFrom('posts')
  .join('users', 'posts.user_id', '=', 'users.id')

// Multiple joins
const _multiJoinQuery = db
  .selectFrom('posts')
  .join('users', 'posts.user_id', '=', 'users.id')
  .join('comments', 'comments.post_id', '=', 'posts.id')

// leftJoin
const _leftJoinQuery = db
  .selectFrom('users')
  .leftJoin('posts', 'users.id', '=', 'posts.user_id')

// rightJoin
const _rightJoinQuery = db
  .selectFrom('users')
  .rightJoin('posts', 'users.id', '=', 'posts.user_id')

// crossJoin
const _crossJoinQuery = db.selectFrom('users').crossJoin('tags')

// ─── Type-level Tests: Aggregate Typing ──────────────────────────────────────

async function _aggregateTypingTests() {
  const _count: number = await db.selectFrom('users').count()
  const _sum: number = await db.selectFrom('posts').sum('id')
  const _avg: number = await db.selectFrom('users').avg('age')
  const _max = await db.selectFrom('users').max('age')
  const _min = await db.selectFrom('users').min('id')
}

// Top-level aggregates
async function _topLevelAggregates() {
  const _count: number = await db.count('users')
  const _sum: number = await db.sum('posts', 'id')
  const _avg: number = await db.avg('users', 'age')
  const _max = await db.max('users', 'age')
  const _min = await db.min('users', 'id')
}

// ─── Type-level Tests: Table API Typing ──────────────────────────────────────

const _tableInsert = db.table('users').insert({ email: 'x@y.z', name: 'X' })
const _tableUpdate = db.table('users').update({ name: 'Updated' })
const _tableDelete = db.table('users').delete()
const _tableSelect = db.table('users').select('id', 'email')

// ─── Type-level Tests: CRUD Helpers ──────────────────────────────────────────

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

// ─── Type-level Tests: Chaining Preserves Types ──────────────────────────────

const _chainedQuery = db
  .selectFrom('users')
  .where({ id: 1 })
  .orderBy('created_at', 'desc')
  .limit(10)

type ChainedType = SelectedOf<typeof _chainedQuery>
type _AssertChainedType = Expect<Equal<ChainedType, UsersColumns>>

// ─── Type-level Tests: whereIn / whereNotIn Typing ───────────────────────────

const _whereIn = db.selectFrom('users').whereIn('id', [1, 2, 3])
const _whereNotIn = db.selectFrom('users').whereNotIn('role', ['admin', 'superadmin'])
const _orWhereIn = db.selectFrom('users').orWhereIn('id', [4, 5])
const _orWhereNotIn = db.selectFrom('users').orWhereNotIn('name', ['test'])

// ─── Type-level Tests: whereLike Typing ──────────────────────────────────────

const _whereLike = db.selectFrom('users').whereLike('name', '%Ali%')
const _whereLikeCs = db.selectFrom('users').whereLike('email', '%@example.com', true)
const _orWhereLike = db.selectFrom('users').orWhereLike('name', 'B%')
const _whereNotLike = db.selectFrom('users').whereNotLike('email', '%spam%')

// ─── Type-level Tests: whereAny / whereAll / whereNone Typing ────────────────

const _whereAny = db.selectFrom('users').whereAny(['name', 'email'], 'like', '%test%')
const _whereAll = db.selectFrom('users').whereAll(['name', 'role'], '=', 'admin')
const _whereNone = db.selectFrom('users').whereNone(['name', 'email'], '=', 'banned')

// ─── Type-level Tests: Relational with() ────────────────────────────────────

const _withPosts = db.selectFrom('users').with?.('posts')
const _withProfile = db.selectFrom('users').with?.('profile')
const _withMultiple = db.selectFrom('users').with?.('posts', 'profile')
const _withComments = db.selectFrom('posts').with?.('comments')

// ─── Type-level Tests: Transaction Typing ────────────────────────────────────

async function _transactionTypes() {
  const result: string = await db.transaction(async (tx) => {
    await tx.insertInto('users').values({ email: 'tx@test.com', name: 'TxUser' }).execute()
    return 'done'
  })
  void result
}

// ─── Type-level Tests: Pagination Return Types ──────────────────────────────

async function _paginationTypes() {
  const paginated = await db.selectFrom('users').paginate(10, 1)
  const _data: readonly UsersColumns[] = paginated.data
  const _meta: { perPage: number, page: number, total: number, lastPage: number } = paginated.meta
  const simple = await db.selectFrom('users').simplePaginate(10)
  const _simpleData: readonly UsersColumns[] = simple.data
  const _simpleMeta: { perPage: number, page: number, hasMore: boolean } = simple.meta
  void _data; void _meta; void _simpleData; void _simpleMeta
}

// ─── Type-level Tests: Execution Return Types ───────────────────────────────

async function _executionReturnTypes() {
  const rows: readonly UsersColumns[] = await db.selectFrom('users').execute()
  const row: Readonly<UsersColumns> | undefined = await db.selectFrom('users').executeTakeFirst()
  const rowOrThrow: Readonly<UsersColumns> = await db.selectFrom('users').executeTakeFirstOrThrow()
  const getRows: readonly UsersColumns[] = await db.selectFrom('users').get()
  const firstRow: Readonly<UsersColumns> | undefined = await db.selectFrom('users').first()
  const firstOrFail: Readonly<UsersColumns> = await db.selectFrom('users').firstOrFail()
  void rows; void row; void rowOrThrow; void getRows; void firstRow; void firstOrFail
}

// ─── Type-level Tests: "rows" and "row" phantom properties ───────────────────

const _usersRows: UsersColumns[] = db.selectFrom('users').rows
const _usersRow: UsersColumns = db.selectFrom('users').row
const _postsRows: PostsColumns[] = db.selectFrom('posts').rows
const _postsRow: PostsColumns = db.selectFrom('posts').row

// ─── Type-level Tests: select() narrows QueryBuilder columns ────────────────

const _selectIdEmail = db.select('users', 'id', 'email')
const _selectPostTitle = db.select('posts', 'title', 'body')

// ─── Type-level Tests: Insert with bulk values ──────────────────────────────

const _bulkInsert = db.insertInto('users').values([
  { email: 'a@b.com', name: 'A' },
  { email: 'b@c.com', name: 'B' },
])

// ─── Type-level Tests: Mixed Operations on Comments (cross-relation) ────────

const _commentWithPostAndUser = db
  .selectFrom('comments')
  .join('posts', 'comments.post_id', '=', 'posts.id')
  .join('users', 'comments.user_id', '=', 'users.id')

// ─── Type-level Tests: Soft Delete Methods ──────────────────────────────────

const _withTrashed = db.selectFrom('users').withTrashed?.()
const _onlyTrashed = db.selectFrom('users').onlyTrashed?.()

// ─── Type-level Tests: Cache Method ─────────────────────────────────────────

const _cached = db.selectFrom('users').cache?.(5000)

// ─── Type-level Tests: Lock Methods ─────────────────────────────────────────

const _forUpdate = db.selectFrom('users').lockForUpdate()
const _sharedLock = db.selectFrom('users').sharedLock()

// ─── Type-level Tests: Clone ────────────────────────────────────────────────

const _cloned = db.selectFrom('users').clone?.()

// =============================================================================
// Runtime Tests (bun:test)
// =============================================================================

describe('Schema Inference', () => {
  test('buildDatabaseSchema creates correct table keys', () => {
    const tableNames = Object.keys(schema)
    expect(tableNames).toContain('users')
    expect(tableNames).toContain('posts')
    expect(tableNames).toContain('comments')
    expect(tableNames).toContain('profiles')
    expect(tableNames).toContain('tags')
    expect(tableNames).toHaveLength(5)
  })

  test('users columns exist in schema', () => {
    const usersCols = Object.keys(schema.users.columns)
    expect(usersCols).toContain('id')
    expect(usersCols).toContain('email')
    expect(usersCols).toContain('name')
    expect(usersCols).toContain('age')
    expect(usersCols).toContain('role')
    expect(usersCols).toContain('is_active')
    expect(usersCols).toContain('created_at')
    expect(usersCols).toContain('updated_at')
  })

  test('posts columns exist in schema', () => {
    const postsCols = Object.keys(schema.posts.columns)
    expect(postsCols).toContain('id')
    expect(postsCols).toContain('user_id')
    expect(postsCols).toContain('title')
    expect(postsCols).toContain('body')
    expect(postsCols).toContain('published')
  })

  test('comments columns exist in schema', () => {
    const commentsCols = Object.keys(schema.comments.columns)
    expect(commentsCols).toContain('id')
    expect(commentsCols).toContain('post_id')
    expect(commentsCols).toContain('user_id')
    expect(commentsCols).toContain('content')
  })

  test('primary keys are inferred correctly', () => {
    expect(schema.users.primaryKey).toBe('id')
    expect(schema.posts.primaryKey).toBe('id')
    expect(schema.comments.primaryKey).toBe('id')
    expect(schema.profiles.primaryKey).toBe('id')
    expect(schema.tags.primaryKey).toBe('id')
  })
})

describe('Schema Meta', () => {
  test('modelToTable mapping is correct', () => {
    expect(meta.modelToTable.User).toBe('users')
    expect(meta.modelToTable.Post).toBe('posts')
    expect(meta.modelToTable.Comment).toBe('comments')
    expect(meta.modelToTable.Profile).toBe('profiles')
    expect(meta.modelToTable.Tag).toBe('tags')
  })

  test('tableToModel mapping is correct', () => {
    expect(meta.tableToModel.users).toBe('User')
    expect(meta.tableToModel.posts).toBe('Post')
    expect(meta.tableToModel.comments).toBe('Comment')
    expect(meta.tableToModel.profiles).toBe('Profile')
    expect(meta.tableToModel.tags).toBe('Tag')
  })

  test('primaryKeys mapping is correct', () => {
    expect(meta.primaryKeys.users).toBe('id')
    expect(meta.primaryKeys.posts).toBe('id')
    expect(meta.primaryKeys.comments).toBe('id')
  })

  test('relations are populated for models with relations', () => {
    expect(meta.relations).toBeDefined()
    expect(meta.relations!.users).toBeDefined()
    expect(meta.relations!.users.hasMany).toBeDefined()
    expect(meta.relations!.users.hasMany!.posts).toBe('Post')
    expect(meta.relations!.users.hasOne).toBeDefined()
    expect(meta.relations!.users.hasOne!.profile).toBe('Profile')
  })

  test('belongsTo relations are populated', () => {
    expect(meta.relations!.posts).toBeDefined()
    expect(meta.relations!.posts.belongsTo).toBeDefined()
    expect(meta.relations!.posts.belongsTo!.user).toBe('User')
    expect(meta.relations!.comments).toBeDefined()
    expect(meta.relations!.comments.belongsTo).toBeDefined()
    expect(meta.relations!.comments.belongsTo!.post).toBe('Post')
    expect(meta.relations!.comments.belongsTo!.user).toBe('User')
  })

  test('hasMany relations are populated on posts', () => {
    expect(meta.relations!.posts.hasMany).toBeDefined()
    expect(meta.relations!.posts.hasMany!.comments).toBe('Comment')
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
    expect(s).toContain('users')
  })

  test('where with object generates WHERE clause', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }))
    expect(s).toContain('WHERE')
    expect(s).toContain('id')
  })

  test('where with tuple generates correct operator', () => {
    const s = toSql(db.selectFrom('users').where(['age', '>', 18]))
    expect(s).toContain('WHERE')
    expect(s).toContain('age')
    expect(s).toContain('>')
  })

  test('andWhere chains AND condition', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }).andWhere({ role: 'admin' }))
    expect(s).toContain('AND')
    expect(s).toContain('role')
  })

  test('orWhere chains OR condition', () => {
    const s = toSql(db.selectFrom('users').where({ id: 1 }).orWhere({ id: 2 }))
    expect(s).toContain('OR')
  })

  test('orderBy generates ORDER BY clause', () => {
    const s = toSql(db.selectFrom('users').orderBy('created_at', 'desc'))
    expect(s).toContain('ORDER BY')
    expect(s.toLowerCase()).toContain('desc')
  })

  test('limit generates LIMIT clause', () => {
    const s = toSql(db.selectFrom('users').limit(10))
    expect(s).toContain('LIMIT')
    expect(s).toContain('10')
  })

  test('offset generates OFFSET clause', () => {
    const s = toSql(db.selectFrom('users').offset(20))
    expect(s).toContain('OFFSET')
    expect(s).toContain('20')
  })

  test('chained where + orderBy + limit', () => {
    const s = toSql(db.selectFrom('users')
      .where({ is_active: true })
      .orderBy('created_at', 'desc')
      .limit(5))
    expect(s).toContain('WHERE')
    expect(s).toContain('ORDER BY')
    expect(s).toContain('LIMIT')
  })

  test('groupBy generates GROUP BY', () => {
    const s = toSql(db.selectFrom('users').groupBy('role'))
    expect(s).toContain('GROUP BY')
    expect(s).toContain('role')
  })

  test('groupBy with multiple columns', () => {
    const s = toSql(db.selectFrom('users').groupBy('role', 'is_active'))
    expect(s).toContain('GROUP BY')
    expect(s).toContain('role')
    expect(s).toContain('is_active')
  })

  test('whereBetween generates BETWEEN', () => {
    const s = toSql(db.selectFrom('users').whereBetween('id', 1, 100))
    expect(s).toContain('BETWEEN')
  })
})

describe('SQL Generation: JOIN', () => {
  test('join generates JOIN clause', () => {
    const s = toSql(db.selectFrom('posts').join('users', 'posts.user_id', '=', 'users.id'))
    expect(s).toContain('JOIN')
    expect(s).toContain('users')
    expect(s).toContain('posts.user_id')
    expect(s).toContain('users.id')
  })

  test('innerJoin generates INNER JOIN', () => {
    const s = toSql(db.selectFrom('posts').innerJoin('users', 'posts.user_id', '=', 'users.id'))
    expect(s).toContain('INNER JOIN')
  })

  test('leftJoin generates LEFT JOIN', () => {
    const s = toSql(db.selectFrom('users').leftJoin('posts', 'users.id', '=', 'posts.user_id'))
    expect(s.toUpperCase()).toContain('LEFT')
    expect(s).toContain('JOIN')
  })

  test('rightJoin generates RIGHT JOIN', () => {
    const s = toSql(db.selectFrom('users').rightJoin('posts', 'users.id', '=', 'posts.user_id'))
    expect(s.toUpperCase()).toContain('RIGHT')
    expect(s).toContain('JOIN')
  })

  test('crossJoin generates CROSS JOIN', () => {
    const s = toSql(db.selectFrom('users').crossJoin('tags'))
    expect(s).toContain('CROSS JOIN')
    expect(s).toContain('tags')
  })

  test('multiple joins', () => {
    const s = toSql(db.selectFrom('comments')
      .join('posts', 'comments.post_id', '=', 'posts.id')
      .join('users', 'comments.user_id', '=', 'users.id'))
    expect(s).toContain('posts')
    expect(s).toContain('users')
    const joinCount = (s.match(/JOIN/gi) || []).length
    expect(joinCount).toBeGreaterThanOrEqual(2)
  })
})

describe('SQL Generation: INSERT', () => {
  test('insertInto generates INSERT INTO', () => {
    const s = toSql(db.insertInto('users').values({ email: 'a@b.com', name: 'A' }))
    expect(s).toContain('INSERT INTO')
    expect(s).toContain('users')
  })

  test('insert with multiple rows', () => {
    const s = toSql(db.insertInto('users').values([
      { email: 'a@b.com', name: 'A' },
      { email: 'b@c.com', name: 'B' },
    ]))
    expect(s).toContain('INSERT INTO')
    expect(s).toContain('users')
  })

  test('insert with returning', () => {
    const s = toSql(db.insertInto('users').values({ email: 'a@b.com' }).returning('id', 'email'))
    expect(s).toContain('RETURNING')
    expect(s).toContain('id')
    expect(s).toContain('email')
  })
})

describe('SQL Generation: UPDATE', () => {
  test('updateTable generates UPDATE SET', () => {
    const s = toSql(db.updateTable('users').set({ name: 'Updated' }).where({ id: 1 }))
    expect(s).toContain('UPDATE')
    expect(s).toContain('users')
    expect(s).toContain('SET')
  })
})

describe('SQL Generation: dump/dd', () => {
  test('dump returns the query builder for chaining', () => {
    const qb = db.selectFrom('users').whereId(1).dump()
    expect(qb).toBeDefined()
    expect(typeof qb.toSQL).toBe('function')
  })

  test('dd throws after dumping', () => {
    expect(() => {
      db.selectFrom('users').whereId(1).dd()
    }).toThrow()
  })
})

describe('Query Builder Instance', () => {
  test('selectFrom returns builder with all core methods', () => {
    const qb = db.selectFrom('users')
    expect(typeof qb.where).toBe('function')
    expect(typeof qb.orderBy).toBe('function')
    expect(typeof qb.limit).toBe('function')
    expect(typeof qb.offset).toBe('function')
    expect(typeof qb.toSQL).toBe('function')
    expect(typeof qb.distinct).toBe('function')
    expect(typeof qb.lockForUpdate).toBe('function')
    expect(typeof qb.sharedLock).toBe('function')
    expect(typeof qb.join).toBe('function')
    expect(typeof qb.leftJoin).toBe('function')
    expect(typeof qb.rightJoin).toBe('function')
    expect(typeof qb.crossJoin).toBe('function')
    expect(typeof qb.groupBy).toBe('function')
    expect(typeof qb.union).toBe('function')
    expect(typeof qb.unionAll).toBe('function')
    expect(typeof qb.count).toBe('function')
    expect(typeof qb.sum).toBe('function')
    expect(typeof qb.avg).toBe('function')
    expect(typeof qb.max).toBe('function')
    expect(typeof qb.min).toBe('function')
    expect(typeof qb.forPage).toBe('function')
    expect(typeof qb.dump).toBe('function')
    expect(typeof qb.dd).toBe('function')
    expect(typeof qb.whereLike).toBe('function')
    expect(typeof qb.whereNotLike).toBe('function')
    expect(typeof qb.whereAny).toBe('function')
    expect(typeof qb.whereAll).toBe('function')
    expect(typeof qb.whereNone).toBe('function')
    expect(typeof qb.whereBetween).toBe('function')
    expect(typeof qb.whereNotBetween).toBe('function')
    expect(typeof qb.addSelect).toBe('function')
    expect(typeof qb.latest).toBe('function')
    expect(typeof qb.oldest).toBe('function')
    expect(typeof qb.inRandomOrder).toBe('function')
  })

  test('insertInto returns builder with values and toSQL', () => {
    const qb = db.insertInto('users')
    expect(typeof qb.values).toBe('function')
    expect(typeof qb.toSQL).toBe('function')
  })

  test('updateTable returns builder with set, where, toSQL', () => {
    const qb = db.updateTable('users')
    expect(typeof qb.set).toBe('function')
    expect(typeof qb.where).toBe('function')
    expect(typeof qb.toSQL).toBe('function')
  })

  test('deleteFrom returns builder with where, toSQL', () => {
    const qb = db.deleteFrom('users')
    expect(typeof qb.where).toBe('function')
    expect(typeof qb.toSQL).toBe('function')
  })

  test('table returns builder with insert, update, delete, select', () => {
    const qb = db.table('users')
    expect(typeof qb.insert).toBe('function')
    expect(typeof qb.update).toBe('function')
    expect(typeof qb.delete).toBe('function')
    expect(typeof qb.select).toBe('function')
  })

  test('dynamic where methods exist on selectFrom result', () => {
    const qb = db.selectFrom('users')
    expect(typeof qb.whereId).toBe('function')
    expect(typeof qb.whereEmail).toBe('function')
    expect(typeof qb.whereName).toBe('function')
    expect(typeof qb.whereAge).toBe('function')
    expect(typeof qb.whereRole).toBe('function')
    expect(typeof qb.whereIsActive).toBe('function')
    expect(typeof qb.whereCreatedAt).toBe('function')
    expect(typeof qb.whereUpdatedAt).toBe('function')
    expect(typeof qb.orWhereId).toBe('function')
    expect(typeof qb.orWhereEmail).toBe('function')
    expect(typeof qb.andWhereId).toBe('function')
    expect(typeof qb.andWhereEmail).toBe('function')
  })

  test('dynamic where methods exist on posts selectFrom result', () => {
    const qb = db.selectFrom('posts')
    expect(typeof qb.whereId).toBe('function')
    expect(typeof qb.whereUserId).toBe('function')
    expect(typeof qb.whereTitle).toBe('function')
    expect(typeof qb.whereBody).toBe('function')
    expect(typeof qb.wherePublished).toBe('function')
  })

  test('dynamic where methods exist on comments selectFrom result', () => {
    const qb = db.selectFrom('comments')
    expect(typeof qb.whereId).toBe('function')
    expect(typeof qb.wherePostId).toBe('function')
    expect(typeof qb.whereUserId).toBe('function')
    expect(typeof qb.whereContent).toBe('function')
  })
})

describe('Query Builder: fluent chaining', () => {
  test('chaining methods produces cumulative SQL', () => {
    // The builder uses mutable state - chaining on same instance accumulates
    const sqlWhere = toSql(db.selectFrom('users').where({ id: 1 }))
    const sqlOrder = toSql(db.selectFrom('users').orderBy('id'))
    const sqlBoth = toSql(db.selectFrom('users').where({ id: 1 }).orderBy('id'))

    expect(sqlWhere).toContain('WHERE')
    expect(sqlOrder).toContain('ORDER BY')
    expect(sqlBoth).toContain('WHERE')
    expect(sqlBoth).toContain('ORDER BY')
  })
})

describe('Migration Plan', () => {
  test('buildMigrationPlan generates plans for all models', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    expect(plan.dialect).toBe('postgres')
    expect(plan.tables.length).toBeGreaterThanOrEqual(5)

    const tableNames = plan.tables.map((t: any) => t.table)
    expect(tableNames).toContain('users')
    expect(tableNames).toContain('posts')
    expect(tableNames).toContain('comments')
    expect(tableNames).toContain('profiles')
    expect(tableNames).toContain('tags')
  })

  test('users table plan has correct columns', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')
    expect(usersTable).toBeDefined()

    const colNames = usersTable!.columns.map((c: any) => c.name)
    expect(colNames).toContain('id')
    expect(colNames).toContain('email')
    expect(colNames).toContain('name')
    expect(colNames).toContain('age')
    expect(colNames).toContain('role')
    expect(colNames).toContain('is_active')
  })

  test('posts table has user_id column', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const postsTable = plan.tables.find((t: any) => t.table === 'posts')
    expect(postsTable).toBeDefined()
    const userIdCol = postsTable!.columns.find((c: any) => c.name === 'user_id')
    expect(userIdCol).toBeDefined()
  })

  test('email column is unique', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')
    const emailCol = usersTable!.columns.find((c: any) => c.name === 'email')
    expect(emailCol).toBeDefined()
    expect(emailCol!.isUnique).toBe(true)
  })

  test('id column is primary key', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')
    const idCol = usersTable!.columns.find((c: any) => c.name === 'id')
    expect(idCol).toBeDefined()
    expect(idCol!.isPrimaryKey).toBe(true)
  })

  test('generateSql produces CREATE TABLE statements', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const statements = generateSql(plan)
    expect(statements.length).toBeGreaterThan(0)
    const allSql = statements.join('\n')
    expect(allSql).toContain('CREATE TABLE')
  })

  test('generateSqlString produces a single SQL string', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const sqlString = generateSqlString(plan)
    expect(typeof sqlString).toBe('string')
    expect(sqlString).toContain('CREATE TABLE')
  })

  test('generateSql for SQLite dialect', () => {
    const plan = buildMigrationPlan(models, { dialect: 'sqlite' })
    const statements = generateSql(plan)
    expect(statements.length).toBeGreaterThan(0)
    const allSql = statements.join('\n')
    expect(allSql).toContain('CREATE TABLE')
  })

  test('generateSql for MySQL dialect', () => {
    const plan = buildMigrationPlan(models, { dialect: 'mysql' })
    const statements = generateSql(plan)
    expect(statements.length).toBeGreaterThan(0)
    const allSql = statements.join('\n')
    expect(allSql).toContain('CREATE TABLE')
  })
})

describe('Migration Plan: Column Type Inference', () => {
  test('integer validator produces integer or bigint type', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const idCol = usersTable.columns.find((c: any) => c.name === 'id')!
    expect(['integer', 'bigint']).toContain(idCol.type)
  })

  test('string validator produces string type', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const emailCol = usersTable.columns.find((c: any) => c.name === 'email')!
    expect(emailCol.type).toBe('string')
  })

  test('boolean validator produces boolean type', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const isActiveCol = usersTable.columns.find((c: any) => c.name === 'is_active')!
    expect(isActiveCol.type).toBe('boolean')
  })

  test('text validator produces string type (text maps to string in migration)', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const postsTable = plan.tables.find((t: any) => t.table === 'posts')!
    const bodyCol = postsTable.columns.find((c: any) => c.name === 'body')!
    expect(['string', 'text']).toContain(bodyCol.type)
  })

  test('date validator produces date or datetime type', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const usersTable = plan.tables.find((t: any) => t.table === 'users')!
    const createdAtCol = usersTable.columns.find((c: any) => c.name === 'created_at')!
    expect(['date', 'datetime']).toContain(createdAtCol.type)
  })
})

describe('Migration Plan: Dialect Differences', () => {
  test('postgres generates valid CREATE TABLE', () => {
    const plan = buildMigrationPlan(models, { dialect: 'postgres' })
    const statements = generateSql(plan)
    const allSql = statements.join('\n')
    expect(allSql).toContain('CREATE TABLE')
    // Should use SERIAL or BIGSERIAL for PK
    expect(allSql.includes('SERIAL') || allSql.includes('GENERATED')).toBe(true)
  })

  test('sqlite generates valid CREATE TABLE', () => {
    const plan = buildMigrationPlan(models, { dialect: 'sqlite' })
    const statements = generateSql(plan)
    const allSql = statements.join('\n')
    expect(allSql).toContain('CREATE TABLE')
    expect(allSql).toContain('INTEGER')
  })

  test('mysql generates valid CREATE TABLE with auto_increment', () => {
    const plan = buildMigrationPlan(models, { dialect: 'mysql' })
    const statements = generateSql(plan)
    const allSql = statements.join('\n')
    expect(allSql).toContain('CREATE TABLE')
    expect(allSql.toLowerCase()).toContain('auto_increment')
  })
})

describe('defineModel / defineModels', () => {
  test('defineModel preserves model name', () => {
    expect(User.name).toBe('User')
    expect(Post.name).toBe('Post')
    expect(Comment.name).toBe('Comment')
  })

  test('defineModel preserves table name', () => {
    expect(User.table).toBe('users')
    expect(Post.table).toBe('posts')
    expect(Comment.table).toBe('comments')
  })

  test('defineModel preserves primary key', () => {
    expect(User.primaryKey).toBe('id')
    expect(Post.primaryKey).toBe('id')
  })

  test('defineModel preserves attributes', () => {
    expect(User.attributes).toBeDefined()
    expect(User.attributes.email).toBeDefined()
    expect(User.attributes.email.unique).toBe(true)
    expect(User.attributes.age.default).toBe(0)
  })

  test('defineModel preserves relations', () => {
    expect(User.hasMany).toEqual({ posts: 'Post' })
    expect(User.hasOne).toEqual({ profile: 'Profile' })
    expect(Post.belongsTo).toEqual({ user: 'User' })
    expect(Post.hasMany).toEqual({ comments: 'Comment' })
  })

  test('defineModels preserves all model keys', () => {
    expect(models.User).toBe(User)
    expect(models.Post).toBe(Post)
    expect(models.Comment).toBe(Comment)
    expect(models.Profile).toBe(Profile)
    expect(models.Tag).toBe(Tag)
  })
})

describe('Schema: InferTableName', () => {
  test('explicit table name is used', () => {
    expect('users' in schema).toBe(true)
    expect('posts' in schema).toBe(true)
    expect('comments' in schema).toBe(true)
  })

  test('tags table is correctly inferred', () => {
    expect('tags' in schema).toBe(true)
    const tagCols = Object.keys(schema.tags.columns)
    expect(tagCols).toContain('id')
    expect(tagCols).toContain('label')
    expect(tagCols).toContain('slug')
  })
})

describe('Schema: Model with default primary key', () => {
  test('model without explicit primaryKey defaults to id', () => {
    const SimpleModel = defineModel({
      name: 'Simple',
      table: 'simples',
      attributes: {
        id: { validation: { rule: v.integer() } },
        value: { validation: { rule: v.string() } },
      },
    } as const)

    const simpleModels = defineModels({ Simple: SimpleModel })
    const simpleSchema = buildDatabaseSchema(simpleModels)
    expect(simpleSchema.simples.primaryKey).toBe('id')
  })
})

describe('defineModel attribute metadata', () => {
  test('unique flag preserved', () => {
    expect(User.attributes.email.unique).toBe(true)
  })

  test('default value preserved', () => {
    expect(User.attributes.age.default).toBe(0)
  })

  test('attributes without unique are not unique', () => {
    expect(User.attributes.name.unique).toBeUndefined()
  })
})

describe('Edge Cases', () => {
  test('empty where object produces valid SQL', () => {
    const s = toSql(db.selectFrom('users').where({}))
    expect(s).toContain('SELECT')
    expect(s).toContain('users')
  })

  test('multiple orderBy calls chain correctly', () => {
    const s = toSql(db.selectFrom('users')
      .orderBy('name', 'asc')
      .orderBy('created_at', 'desc'))
    expect(s).toContain('ORDER BY')
  })

  test('complex query with many clauses', () => {
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

  test('join then where then orderBy', () => {
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

  test('chaining where then orWhere then andWhere', () => {
    const s = toSql(db.selectFrom('users')
      .where({ id: 1 })
      .orWhere({ email: 'test@test.com' })
      .andWhere({ is_active: true }))
    expect(s).toContain('WHERE')
    expect(s).toContain('OR')
    expect(s).toContain('AND')
  })
})

describe('Cross-Table Relational Queries', () => {
  test('posts with user join includes both table columns', () => {
    const s = toSql(db.selectFrom('posts')
      .join('users', 'posts.user_id', '=', 'users.id')
      .where({ published: true }))
    expect(s).toContain('JOIN')
    expect(s).toContain('users')
    expect(s).toContain('published')
  })

  test('comments -> posts -> users multi-join', () => {
    const s = toSql(db.selectFrom('comments')
      .join('posts', 'comments.post_id', '=', 'posts.id')
      .join('users', 'posts.user_id', '=', 'users.id')
      .orderBy('created_at', 'desc')
      .limit(20))
    expect(s).toContain('comments')
    expect(s).toContain('posts')
    expect(s).toContain('users')
    expect(s).toContain('ORDER BY')
    expect(s).toContain('LIMIT')
  })

  test('users with profiles left join', () => {
    const s = toSql(db.selectFrom('users')
      .leftJoin('profiles', 'users.id', '=', 'profiles.user_id'))
    expect(s).toContain('profiles')
    expect(s.toUpperCase()).toContain('LEFT')
  })
})

describe('Query Builder: top-level methods', () => {
  test('transaction method exists', () => {
    expect(typeof db.transaction).toBe('function')
  })

  test('savepoint method exists', () => {
    expect(typeof db.savepoint).toBe('function')
  })

  test('configure method exists', () => {
    expect(typeof db.configure).toBe('function')
  })

  test('rawQuery method exists', () => {
    expect(typeof db.rawQuery).toBe('function')
  })

  test('CRUD helper methods exist', () => {
    expect(typeof db.create).toBe('function')
    expect(typeof db.createMany).toBe('function')
    expect(typeof db.insertMany).toBe('function')
    expect(typeof db.updateMany).toBe('function')
    expect(typeof db.deleteMany).toBe('function')
    expect(typeof db.firstOrCreate).toBe('function')
    expect(typeof db.updateOrCreate).toBe('function')
    expect(typeof db.save).toBe('function')
    expect(typeof db.remove).toBe('function')
    expect(typeof db.find).toBe('function')
    expect(typeof db.findOrFail).toBe('function')
    expect(typeof db.findMany).toBe('function')
    expect(typeof db.latest).toBe('function')
    expect(typeof db.oldest).toBe('function')
    expect(typeof db.skip).toBe('function')
    expect(typeof db.upsert).toBe('function')
    expect(typeof db.insertOrIgnore).toBe('function')
    expect(typeof db.insertGetId).toBe('function')
    expect(typeof db.updateOrInsert).toBe('function')
  })
})
