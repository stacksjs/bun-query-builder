/* eslint-disable unused-imports/no-unused-vars */
// Dummy typed showcase for bun-query-builder
// This file is not meant to run database operations. It demonstrates types.

import type { QueryBuilder, SelectQueryBuilder } from './src'
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
const db: QueryBuilder<DB> = createQueryBuilder<typeof schema>({ schema, meta })

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
type UsersSelected = SelectedOf<typeof usersQ>
const usersSelectedExample: UsersSelected | undefined = undefined
const usersRowsPromise = usersQ.execute()

// Join across typed tables
const postsWithUsersQ = db
  .selectFrom('posts')
  .join('users', 'posts.id', '=', 'users.id')
  .where({ id: 1 })
  .orderBy('created_at', 'desc')
type PostsWithUsersSelected = SelectedOf<typeof postsWithUsersQ>
const postsWithUsersSelectedExample: PostsWithUsersSelected | undefined = undefined
const postsWithUsersRowsPromise = postsWithUsersQ.execute()

// Aggregates are typed by table
async function typedAggregates() {
  await db.count('users', 'id')
  await db.sum('posts', 'id')
  await db.max('comments', 'id')
}
void typedAggregates

// Example typed variables for other tables
const newPost: Partial<Posts> = { title: 'Hello', body: 'World', user_id: 1, published: true }
db.insertInto('posts').values(newPost).toSQL()

const newComment: Partial<Comments> = { post_id: 1, author: 'Bob', body: 'Nice post!' }
const sql = db.insertInto('comments').values(newComment).toSQL()

// Returning examples to hover precise row shapes
const insertUserQ = db.insertInto('users').values(newUser).returning('id', 'email')
type InsertUserRow = SelectedOf<typeof insertUserQ>
const insertUserRowExample: InsertUserRow | undefined = undefined
const insertedUsersPromise = insertUserQ.execute()

const updateUserQ = db.updateTable('users').set({ role: 'member' }).where({ id: 1 }).returning('id', 'created_at')
type UpdateUserRow = SelectedOf<typeof updateUserQ>
const updateUserRowExample: UpdateUserRow | undefined = undefined
const updatedUsersPromise = updateUserQ.execute()

// No explicit types needed: hover these locals to see fully inferred row shapes
async function typedRows() {
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
const usersByName = usersByNameQ.get()

const usersByEmailQ = db.selectFrom('users').whereEmail('alice@example.com').orWhereEmail('bob@example.com')
type UsersByEmail = SelectedOf<typeof usersByEmailQ>
const usersByEmailHover = usersByEmailQ.rows
const usersByEmail = usersByEmailQ.first()

// Snake_case columns via camelCase method name
const usersRecentQ = db.selectFrom('users').whereCreatedAt(new Date('2024-01-01')).orderBy('created_at', 'desc')
const usersRecentHover = usersRecentQ.rows
// db.selectFrom('users').where
// Note: Uncommenting the following lines would produce TypeScript errors as intended
// db.select('users', 'does_not_exist')
// db.updateTable('users').set({ nope: 123 })
// db.insertInto('posts').values({ not_a_column: true })
