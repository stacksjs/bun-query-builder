---
title: Aggregations
description: Perform aggregate calculations with the query builder.
---

# Aggregations

Perform aggregate calculations like COUNT, SUM, AVG, MIN, and MAX with full type safety.

## Count

Count records in a table:

```typescript
import { createQueryBuilder } from 'bun-query-builder'

const db = createQueryBuilder<typeof schema>({ schema, meta })

// Count all records
const totalUsers = await db.selectFrom('users').count()
console.log(totalUsers) // 150

// Count with conditions
const activeUsers = await db
  .selectFrom('users')
  .where({ active: true })
  .count()

// Count specific column (excludes NULL)
const usersWithEmail = await db.selectFrom('users').count('email')

// Count distinct values
const uniqueCountries = await db.selectFrom('users').countDistinct('country')
```

## Sum

Calculate the sum of a column:

```typescript
// Sum of all order amounts
const totalRevenue = await db.selectFrom('orders').sum('amount')
console.log(totalRevenue) // 125000.50

// Sum with conditions
const yearlyRevenue = await db
  .selectFrom('orders')
  .where('created_at', '>=', '2024-01-01')
  .sum('amount')
```

## Average

Calculate the average of a column:

```typescript
// Average age of users
const avgAge = await db.selectFrom('users').avg('age')
console.log(avgAge) // 32.5

// Average with conditions
const avgActiveUserAge = await db
  .selectFrom('users')
  .where({ active: true })
  .avg('age')
```

## Max

Get the maximum value:

```typescript
// Maximum score
const maxScore = await db.selectFrom('users').max('score')
console.log(maxScore) // 9999

// Latest timestamp
const latestOrder = await db.selectFrom('orders').max('created_at')
```

## Min

Get the minimum value:

```typescript
// Minimum price
const minPrice = await db.selectFrom('products').min('price')
console.log(minPrice) // 9.99

// Earliest record
const firstOrder = await db.selectFrom('orders').min('created_at')
```

## Group By

Group results for aggregate calculations:

```typescript
// Count users by country
const usersByCountry = await db
  .selectFrom('users')
  .select(['country', 'COUNT(*) AS count'])
  .groupBy('country')
  .get()
// [{ country: 'US', count: 50 }, { country: 'UK', count: 30 }, ...]

// Sum sales by category
const salesByCategory = await db
  .selectFrom('orders')
  .select(['category', 'SUM(amount) AS total'])
  .groupBy('category')
  .orderByDesc('total')
  .get()

// Group by multiple columns
const salesByMonthAndCategory = await db
  .selectFrom('orders')
  .select([
    'STRFTIME("%Y-%m", created_at) AS month',
    'category',
    'SUM(amount) AS total',
  ])
  .groupBy(['month', 'category'])
  .get()
```

## Having Clause

Filter grouped results:

```typescript
// Find categories with more than 100 orders
const popularCategories = await db
  .selectFrom('orders')
  .select(['category', 'COUNT(*) AS order_count'])
  .groupBy('category')
  .having('COUNT(*)', '>', 100)
  .get()

// Find users with high average order value
const highValueCustomers = await db
  .selectFrom('orders')
  .select(['user_id', 'AVG(amount) AS avg_order'])
  .groupBy('user_id')
  .having('AVG(amount)', '>', 500)
  .get()
```

## Raw Aggregations

Use raw SQL for complex aggregations:

```typescript
// Custom aggregation
const results = await db
  .selectFrom('orders')
  .select([
    'ROUND(AVG(amount), 2) AS avg_amount',
    'ROUND(SUM(amount), 2) AS total',
    'COUNT(*) AS count',
  ])
  .first()

// Group by with raw expressions
const weeklyStats = await db
  .selectFrom('orders')
  .selectRaw(`
    strftime('%Y-%W', created_at) AS week,
    COUNT(*) AS orders,
    SUM(amount) AS revenue
  `)
  .groupByRaw("strftime('%Y-%W', created_at)")
  .get()
```

## Combined Aggregates

Get multiple aggregates in one query:

```typescript
// Multiple aggregates
const stats = await db
  .selectFrom('products')
  .select([
    'COUNT(*) AS total',
    'AVG(price) AS avg_price',
    'MIN(price) AS min_price',
    'MAX(price) AS max_price',
    'SUM(stock) AS total_stock',
  ])
  .first()

console.log(stats)
// {
//   total: 100,
//   avg_price: 49.99,
//   min_price: 5.00,
//   max_price: 999.99,
//   total_stock: 5000
// }
```

## Aggregates with Joins

Combine aggregations with joins:

```typescript
// Get authors with post counts
const authorStats = await db
  .selectFrom('users')
  .select([
    'users.name',
    'COUNT(posts.id) AS post_count',
    'AVG(posts.views) AS avg_views',
  ])
  .leftJoin('posts', 'users.id', 'posts.user_id')
  .groupBy('users.id')
  .orderByDesc('post_count')
  .get()
```

## Complete Example

```typescript
import { createQueryBuilder, buildDatabaseSchema, buildSchemaMeta } from 'bun-query-builder'

// Setup
const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      country: { validation: { rule: {} } },
      age: { validation: { rule: {} } },
      active: { validation: { rule: {} } },
    },
  },
  Order: {
    name: 'Order',
    table: 'orders',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      user_id: { validation: { rule: {} } },
      amount: { validation: { rule: {} } },
      category: { validation: { rule: {} } },
      created_at: { validation: { rule: {} } },
    },
  },
}

const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)
const db = createQueryBuilder<typeof schema>({ schema, meta })

// Comprehensive analytics
async function getAnalytics() {
  // Basic counts
  const totalUsers = await db.selectFrom('users').count()
  const activeUsers = await db.selectFrom('users').where({ active: true }).count()

  // Order statistics
  const orderStats = await db
    .selectFrom('orders')
    .select([
      'COUNT(*) AS total_orders',
      'SUM(amount) AS total_revenue',
      'AVG(amount) AS avg_order_value',
      'MIN(amount) AS min_order',
      'MAX(amount) AS max_order',
    ])
    .first()

  // Users by country
  const usersByCountry = await db
    .selectFrom('users')
    .select(['country', 'COUNT(*) AS count'])
    .groupBy('country')
    .orderByDesc('count')
    .limit(10)
    .get()

  // Top categories by revenue
  const topCategories = await db
    .selectFrom('orders')
    .select([
      'category',
      'COUNT(*) AS order_count',
      'SUM(amount) AS revenue',
    ])
    .groupBy('category')
    .having('SUM(amount)', '>', 1000)
    .orderByDesc('revenue')
    .limit(5)
    .get()

  // Monthly revenue trend
  const monthlyRevenue = await db
    .selectFrom('orders')
    .selectRaw(`
      strftime('%Y-%m', created_at) AS month,
      COUNT(*) AS orders,
      SUM(amount) AS revenue
    `)
    .groupByRaw("strftime('%Y-%m', created_at)")
    .orderBy('month')
    .get()

  return {
    totalUsers,
    activeUsers,
    orderStats,
    usersByCountry,
    topCategories,
    monthlyRevenue,
  }
}

getAnalytics().then(console.log)
```
