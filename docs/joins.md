---
title: Joins
description: Build type-safe JOIN queries with the query builder.
---
  .crossJoin('sizes')
  .get()

```

## Multiple Joins

Chain multiple joins together:

```typescript

// Join multiple tables
const postsWithDetails = await db
  .selectFrom('posts')
  .select([
    'posts.title',
    'users.name AS author',
    'categories.name AS category',
  ])
  .join('users', 'posts.user_id', 'users.id')
  .join('categories', 'posts.category_id', 'categories.id')
  .get()

```

## Join with Conditions

Add additional conditions to joins:

```typescript

// Join with additional where conditions
const activePostsByActiveUsers = await db
  .selectFrom('posts')
  .join('users', 'posts.user_id', 'users.id')
  .where({ 'posts.published': true })
  .andWhere({ 'users.active': true })
  .get()

```

## Self Join

Join a table to itself:

```typescript

// Self join - find employees and their managers
const employeesWithManagers = await db
  .selectFrom('employees AS e')
  .select(['e.name AS employee', 'm.name AS manager'])
  .leftJoin('employees AS m', 'e.manager_id', 'm.id')
  .get()

```

## Join with Subquery

Use subqueries in joins:

```typescript

// Join with aggregated subquery
const usersWithPostCounts = await db
  .selectFrom('users')
  .select(['users.name', 'post_counts.count AS total_posts'])
  .leftJoin(
    db.selectFrom('posts')
      .select(['user_id', 'COUNT(*) AS count'])
      .groupBy('user_id')
      .as('post_counts'),
    'users.id',
    'post_counts.user_id'
  )
  .get()

```

## Eager Loading Relations

Use the `with` method for eager loading related records:

```typescript

// Eager load posts for users
const usersWithPosts = await db
  .selectFrom('users')
  .with('posts')
  .get()

// Result: [{ id: 1, name: 'John', posts: [...] }, ...]

// Eager load with constraints
const usersWithPublishedPosts = await db
  .selectFrom('users')
  .with({
    posts: (qb) => qb.where('published', '=', true).orderByDesc('created_at'),
  })
  .get()

// Eager load multiple relations
const usersWithRelations = await db
  .selectFrom('users')
  .with(['posts', 'comments', 'profile'])
  .get()

```

## Count Relations

Get count of related records:

```typescript

// Get users with post count
const usersWithPostCount = await db
  .selectFrom('users')
  .withCount('posts')
  .get()

// Result: [{ id: 1, name: 'John', posts_count: 5 }, ...]

// Multiple relation counts
const usersWithCounts = await db
  .selectFrom('users')
  .withCount(['posts', 'comments'])
  .get()

```

## Has Relation

Filter by existence of relations:

```typescript

// Get users who have posts
const usersWithPosts = await db
  .selectFrom('users')
  .has('posts')
  .get()

// Get users who don't have posts
const usersWithoutPosts = await db
  .selectFrom('users')
  .doesntHave('posts')
  .get()

// Filter by related conditions
const usersWithPublishedPosts = await db
  .selectFrom('users')
  .whereHas('posts', (qb) => qb.where('published', '=', true))
  .get()

```

## Join with Alias

Use table aliases for complex queries:

```typescript

const results = await db
  .selectFrom('orders AS o')
  .select([
    'o.id AS order_id',
    'c.name AS customer_name',
    'p.name AS product_name',
  ])
  .join('customers AS c', 'o.customer_id', 'c.id')
  .join('order_items AS oi', 'o.id', 'oi.order_id')
  .join('products AS p', 'oi.product_id', 'p.id')
  .get()

```

## Complete Example

```typescript

import { createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from 'bun-query-builder'

// Models with relations
const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    relations: {
      posts: { type: 'hasMany', model: 'Post', foreignKey: 'user_id' },
      profile: { type: 'hasOne', model: 'Profile', foreignKey: 'user_id' },
    },
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
    },
  },
  Post: {
    name: 'Post',
    table: 'posts',
    primaryKey: 'id',
    relations: {
      author: { type: 'belongsTo', model: 'User', foreignKey: 'user_id' },
      category: { type: 'belongsTo', model: 'Category', foreignKey: 'category_id' },
    },
    attributes: {
      id: { validation: { rule: {} } },
      user_id: { validation: { rule: {} } },
      category_id: { validation: { rule: {} } },
      title: { validation: { rule: {} } },
      published: { validation: { rule: {} } },
    },
  },
  Category: {
    name: 'Category',
    table: 'categories',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
    },
  },
}

const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)
const db = createQueryBuilder<typeof schema>({ schema, meta })

// Complex join queries
async function getPostsWithDetails() {
  // Get posts with author and category
  const posts = await db
    .selectFrom('posts')
    .select([
      'posts.id',
      'posts.title',
      'users.name AS author',
      'categories.name AS category',
    ])
    .join('users', 'posts.user_id', 'users.id')
    .join('categories', 'posts.category_id', 'categories.id')
    .where({ 'posts.published': true })
    .orderByDesc('posts.created_at')
    .get()

  // Using eager loading
  const usersWithRelations = await db
    .selectFrom('users')
    .with({
      posts: (qb) => qb.where('published', '=', true),
    })
    .withCount('posts')
    .has('posts')
    .get()

  return { posts, usersWithRelations }
}

getPostsWithDetails()

```
