# Select Queries

Learn how to retrieve data from your database with bun-query-builder.

## Basic Select

```typescript
// Select all columns
const users = await db.selectFrom('users').get()

// Select specific columns
const userNames = await db
  .selectFrom('users')
  .select(['id', 'name', 'email'])
  .get()

// Select with alias
const result = await db
  .selectFrom('users')
  .select(['name as userName', 'email as userEmail'])
  .get()
```

## Distinct Queries

```typescript
// Get distinct values
const uniqueCities = await db
  .selectFrom('users')
  .distinct()
  .select(['city'])
  .get()

// Distinct on specific column
const result = await db
  .selectFrom('users')
  .distinctOn('department')
  .select(['department', 'name'])
  .get()
```

## Ordering Results

```typescript
// Order ascending
const users = await db
  .selectFrom('users')
  .orderBy('name', 'asc')
  .get()

// Order descending
const latestPosts = await db
  .selectFrom('posts')
  .orderByDesc('created_at')
  .get()

// Shorthand for latest/oldest
const newest = await db.selectFrom('posts').latest().get()
const oldest = await db.selectFrom('posts').oldest().get()

// Random order
const randomUsers = await db
  .selectFrom('users')
  .inRandomOrder()
  .limit(5)
  .get()

// Multiple order conditions
const sorted = await db
  .selectFrom('users')
  .orderBy('department', 'asc')
  .orderBy('name', 'asc')
  .get()
```

## Limiting Results

```typescript
// Limit results
const topTen = await db
  .selectFrom('users')
  .limit(10)
  .get()

// Offset and limit for pagination
const page2 = await db
  .selectFrom('users')
  .offset(10)
  .limit(10)
  .get()
```

## Aggregations

```typescript
// Count all records
const totalUsers = await db.selectFrom('users').count()

// Count with condition
const activeCount = await db
  .selectFrom('users')
  .where({ active: true })
  .count()

// Average
const avgAge = await db
  .selectFrom('users')
  .where({ active: true })
  .avg('age')

// Sum
const totalRevenue = await db
  .selectFrom('orders')
  .where({ status: 'completed' })
  .sum('total')

// Max and Min
const highestScore = await db.selectFrom('users').max('score')
const lowestScore = await db.selectFrom('users').min('score')
```

## Pagination

### Standard Pagination

```typescript
const page = await db
  .selectFrom('users')
  .paginate(20) // 20 per page

console.log(page.data)        // Array of users
console.log(page.total)       // Total records
console.log(page.perPage)     // 20
console.log(page.currentPage) // Current page number
console.log(page.lastPage)    // Last page number
```

### Simple Pagination

```typescript
// More efficient for large datasets (no total count)
const page = await db
  .selectFrom('users')
  .simplePaginate(20)

console.log(page.data)
console.log(page.hasMorePages)
```

### Cursor Pagination

```typescript
// Best for infinite scroll / real-time feeds
const page = await db
  .selectFrom('posts')
  .cursorPaginate(cursor, 20)

console.log(page.data)
console.log(page.nextCursor)
console.log(page.prevCursor)
```

## Chunking Large Datasets

```typescript
// Process large datasets in chunks
await db.selectFrom('users').chunk(100, async (users) => {
  for (const user of users) {
    await processUser(user)
  }
})

// Chunk by ID for better performance
await db.selectFrom('users').chunkById(100, async (users) => {
  await processBatch(users)
})

// Process each record individually
await db.selectFrom('users').eachById(async (user) => {
  await processUser(user)
})
```

## Relations

### Eager Loading

```typescript
// Load related data
const users = await db
  .selectFrom('users')
  .with('posts')
  .get()

// Load multiple relations
const users = await db
  .selectFrom('users')
  .with('posts', 'comments', 'profile')
  .get()

// Nested relations
const users = await db
  .selectFrom('users')
  .with('posts.comments')
  .get()
```

### Constrained Eager Loading

```typescript
// Eager load with constraints
const users = await db
  .selectFrom('users')
  .with({
    posts: (qb) => qb
      .where('published', '=', true)
      .orderBy('created_at', 'desc')
  })
  .get()
```

### Counting Relations

```typescript
// Get count of related records
const users = await db
  .selectFrom('users')
  .withCount('posts')
  .get()

// Access count
users.forEach(user => {
  console.log(`${user.name} has ${user.posts_count} posts`)
})
```

### Filtering by Relations

```typescript
// Users that have at least one post
const usersWithPosts = await db
  .selectFrom('users')
  .has('posts')
  .get()

// Users that don't have any posts
const usersWithoutPosts = await db
  .selectFrom('users')
  .doesntHave('posts')
  .get()

// Users with published posts
const activeAuthors = await db
  .selectFrom('users')
  .whereHas('posts', (qb) => qb.where('published', '=', true))
  .get()
```

## Query Scopes

```typescript
// Define scopes on your model
const User = {
  name: 'User',
  table: 'users',
  scopes: {
    active: (qb) => qb.where({ status: 'active' }),
    verified: (qb) => qb.where({ email_verified_at: ['IS NOT', null] }),
    premium: (qb) => qb.where({ subscription: 'premium' }),
  }
}

// Use scopes in queries
const premiumUsers = await db
  .selectFrom('users')
  .scope('active')
  .scope('premium')
  .get()
```

## Soft Deletes

```typescript
// Include soft deleted records
const allUsers = await db
  .selectFrom('users')
  .withTrashed()
  .get()

// Only soft deleted records
const deletedUsers = await db
  .selectFrom('users')
  .onlyTrashed()
  .get()
```

## Next Steps

- Learn about [where clauses](./where.md)
- Explore [joins](./join.md)
- Master [transactions](./transactions.md)
