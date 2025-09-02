/* eslint-disable unused-imports/no-unused-vars */
// Dummy typed showcase for bun-query-builder
// This file is not meant to run database operations. It demonstrates types.

import type { SelectQueryBuilder } from './src'
// Import example models
import Comment from './examples/models/Comment'
import Post from './examples/models/Post'
import User from './examples/models/User'
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder, defineModels } from './src'

// Define models as a typed record
const models = defineModels({ User, Post, Comment })

// Infer a typed database schema from the models
const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)

// Shorthand alias to make hovers concise
type DB = typeof schema

// Create a typed query builder instance
const db = createQueryBuilder<typeof schema>({ schema, meta })

// Typed columns for convenience in examples below
type Users = typeof schema['users']['columns']
type Posts = typeof schema['posts']['columns']
type Comments = typeof schema['comments']['columns']

// Helper to extract selected type from a SelectQueryBuilder
type SelectedOf<T> = T extends SelectQueryBuilder<any, any, infer S, any> ? S : never

// Insert with typed columns
const newUser: Partial<Users> = {
  email: 'alice@example.com',
  name: 'Alice',
  role: 'admin',
}
const sql1 = db.insertInto('users').values(newUser).toSQL()
// Update with typed where
db.updateTable('users').set({ role: 'member' }).where({ id: 1 }).toSQL()

// Simple typed select (limit to primary key and created_at to match stricter select signature)
db.select('users', 'id', 'created_at').toSQL()

// SelectFrom with where/ordering (use valid where columns for each table)
// Annotate usersQ to surface only the selected row type in hovers
const usersQ = db
  .selectFrom('users')
  .where({ id: 1 })
  .orderBy('id', 'desc')
  .limit(10)
  // .toSQL()

const usersQHover = usersQ.rows
// const usersRowsPromise = usersQ.execute() // Commented out to prevent DB operations

// Join across typed tables
const postsWithUsersQ = db
  .selectFrom('posts')
  .join('users', 'posts.id', '=', 'users.id')
  .where({ id: 1 })
  .orderBy('created_at', 'desc')
type PostsWithUsersSelected = SelectedOf<typeof postsWithUsersQ>
const postsWithUsersSelectedExample: PostsWithUsersSelected | undefined = undefined
// const postsWithUsersRowsPromise = postsWithUsersQ.execute() // Commented out to prevent DB operations

// Aggregates are typed by table
async function typedAggregates() {
  // Commented out actual database operations to prevent test failures
  // await db.count('users', 'id')
  // await db.sum('posts', 'id')
  // await db.max('comments', 'id')
}
void typedAggregates

// Example typed variables for other tables
const newPost: Partial<Posts> = { title: 'Hello', body: 'World', user_id: 1, published: true }
db.insertInto('posts').values(newPost).toSQL()

const newComment: Partial<Comments> = { post_id: 1, author: 'Bob', body: 'Nice post!' }
const sql = db.insertInto('comments').values(newComment).toSQL()

// Returning examples to hover precise row shapes
const insertUserQ = db.insertInto('users').values(newUser).returning('id', 'email')
const insertUserHover = insertUserQ.rows
// const insertedUsersPromise = insertUserQ.execute() // Commented out to prevent DB operations

const updateUserQ = db.updateTable('users').set({ role: 'member' }).where({ id: 1 }).returning('id', 'created_at')
const updateUserHover = updateUserQ.rows
// const updatedUsersPromise = updateUserQ.execute() // Commented out to prevent DB operations

// No explicit types needed: hover these locals to see fully inferred row shapes
async function typedRows() {
  // Commented out actual database operations to prevent test failures
  const usersRows = await db.selectFrom('users').where({ id: 1 }).limit(10).execute()
  const postsJoinRows = await db
    .selectFrom('posts')
    .join('users', 'posts.id', '=', 'users.id')
    .where({ id: 1 })
    .orderBy('created_at', 'desc')
    .execute()
  const insertedUsers = await db.insertInto('users').values(newUser).returning('id', 'email').execute()
  const updatedUsers = await db.updateTable('users').set({ role: 'member' }).where({ id: 1 }).returning('id', 'created_at').execute()
  void usersRows
  void postsJoinRows
  void insertedUsers
  void updatedUsers
}
void typedRows

// Dynamic whereX/orWhereX examples based on model attributes
const usersByNameQ = db.selectFrom('users').whereName('Alice').limit(5)
type UsersByName = SelectedOf<typeof usersByNameQ>
const usersByNameHover = usersByNameQ.rows
// const usersByName = usersByNameQ.get() // Commented out to prevent DB operations

const usersByEmailQ = db.selectFrom('users').whereEmail('alice@example.com').orWhereEmail('bob@example.com')
type UsersByEmail = SelectedOf<typeof usersByEmailQ>
const usersByEmailHover = usersByEmailQ.rows
// const usersByEmail = usersByEmailQ.first() // Commented out to prevent DB operations

// Snake_case columns via camelCase method name
const usersRecentQ = db.selectFrom('users').whereCreatedAt(new Date('2024-01-01')).orderBy('created_at', 'desc')
const usersRecentHover = usersRecentQ.rows
// db.selectFrom('users').where

// Note: Uncommenting the following lines would produce TypeScript errors as intended
// db.select('users', 'does_not_exist')
// db.updateTable('users').set({ nope: 123 })
// db.insertInto('posts').values({ not_a_column: true })

// CRUD helper examples
async function typedCrudHelpers() {
  // Commented out actual database operations to prevent test failures
  // const created = await db.create('users', { email: 'bob@example.com', name: 'Bob', role: 'member' })
  // const fetched = await db.find('users', 1)
  // const upserted = await db.save('users', { id: 1, role: 'admin' })
  // await db.createMany('users', [{ email: 'c1@example.com', name: 'C1', role: 'guest' }])
  // const firstOrCreated = await db.firstOrCreate('users', { email: 'alice@example.com' }, { name: 'Alice', role: 'member' })
  // const updatedOrCreated = await db.updateOrCreate('users', { email: 'd@example.com' }, { name: 'D', role: 'guest' })
  // const deleted = await db.remove('users', 123)
  // const rawRes = await db.rawQuery('SELECT 1')
  // const totalUsers = await db.count('users', 'id')
  // void created
  // void fetched
  // void upserted
  // void firstOrCreated
  // void updatedOrCreated
  // void deleted
  // void rawRes
  // void totalUsers
}
void typedCrudHelpers

// Model-like facade using db helpers
const UserModel = {
  create(values: Partial<Users>) {
    return db.create('users', values)
  },
  createMany(rows: Partial<Users>[]) {
    return db.createMany('users', rows)
  },
  firstOrCreate(match: Partial<Users>, defaults?: Partial<Users>) {
    return db.firstOrCreate('users', match, defaults)
  },
  updateOrCreate(match: Partial<Users>, values: Partial<Users>) {
    return db.updateOrCreate('users', match, values)
  },
  save(values: Partial<Users>) {
    return db.save('users', values)
  },
  find(id: number) {
    return db.find('users', id)
  },
  remove(id: number) {
    return db.remove('users', id)
  },
}

async function modelLikeExamples() {
  // Commented out actual database operations to prevent test failures
  // const created = await UserModel.create({ email: 'bob@example.com', name: 'Bob', role: 'member' })
  // const found = await UserModel.find(1)
  // const saved = await UserModel.save({ id: 1, role: 'admin' })
  // await UserModel.createMany([{ email: 'x@y.z', name: 'X', role: 'guest' }])
  // const foc = await UserModel.firstOrCreate({ email: 'z@y.z' }, { name: 'Z', role: 'member' })
  // const uoc = await UserModel.updateOrCreate({ email: 'w@y.z' }, { name: 'W', role: 'guest' })
  // await UserModel.remove(123)
  // void created
  // void found
  // void saved
  // void foc
  // void uoc
}
void modelLikeExamples
