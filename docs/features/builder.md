# Query Builder

Build type-safe SQL with a fluent API backed by Bun's tagged template literals. All table/column types are inferred from your model files.

This comprehensive guide covers concepts, API, recipes, performance tips, best practices, and common pitfalls when using the query builder.

## Overview

The query builder emits Bun `sql` queries. `toSQL()` returns a Bun query object with methods: `execute()`, `values()`, `raw()`, `cancel()`. This preserves Bun’s performance and safety while providing a Laravel/Kysely-like fluent API.

- Fully typed via your model definitions
- Composable, chainable methods
- Ergonomic helpers for dates, JSON, NULL checks, column-to-column comparisons

## Getting Started

```ts
// Find active users, most recent first
const users = await db
  .selectFrom('users')
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(10)
  .execute()

// Find Chris's posts with specific status
const chrisposts = await db
  .selectFrom('posts')
  .where({ author_name: 'Chris', status: 'published' })
  .orderByDesc('published_at')
  .execute()

// Complex filtering with operators
const recentOrders = await db
  .selectFrom('orders')
  .where(['total', '>=', 100])
  .andWhere(['created_at', '>', new Date('2024-01-01')])
  .execute()
```

**Key Concepts:**

- `where({})` builds equality comparisons for provided keys
- Tuple form `[column, operator, value]` gives explicit control over comparison operators
- Use `orderByDesc`, `latest`, `oldest`, and `reorder` for different ordering patterns
- Chain methods for complex queries while maintaining type safety

## Selecting Data

```ts
// Select all columns from projects
const allProjects = await db
  .selectFrom('projects')
  .limit(5)
  .execute()

// Select specific columns with aliases
const userInfo = await db
  .select('users', 'id', 'email', 'name as display_name')
  .where({ active: true })
  .execute()

// Select with computed columns using raw fragments
const userStats = await db
  .selectFrom('users')
  .select('users', 'id', 'name')
  .selectRaw(db.sql`COUNT(posts.id) as post_count`)
  .leftJoin('posts', 'posts.user_id', '=', 'users.id')
  .groupBy('users.id', 'users.name')
  .execute()

// Select from multiple tables with joins
const userProfiles = await db
  .selectFrom('users')
  .innerJoin('profiles', 'profiles.user_id', '=', 'users.id')
  .select('users', 'id', 'name')
  .selectRaw(db.sql`profiles.bio, profiles.avatar_url`)
  .where({ 'users.active': true })
  .execute()
```

### Aliases and Expressions

- Use `"column as alias"` syntax in `select(table, ...)` for simple aliases
- Use `selectRaw(db.sql\`...\`)` for complex expressions, functions, and computed columns
- Combine `select()` and `selectRaw()` calls to build comprehensive column lists
- Always prefix column names with table names when joining to avoid ambiguity

### Best Practices for Selection

- **Be selective**: Only select columns you actually need to improve performance
- **Use aliases wisely**: Choose meaningful aliases that match your application's naming conventions
- **Leverage computed columns**: Use `selectRaw` for calculations, aggregations, and database functions
- **Type safety**: The builder maintains type information for selected columns

## Filtering and Condition Building

The query builder supports comprehensive filtering with multiple operators and condition types.

**Supported operators**: `=`, `!=`, `<`, `>`, `<=`, `>=`, `like`, `in`, `not in`, `is`, `is not`

```ts
// Simple equality conditions
const activeUsers = await db
  .selectFrom('users')
  .where({ active: true, role: 'member' })
  .execute()

// Using operators with tuple syntax
const adults = await db
  .selectFrom('users')
  .where(['age', '>=', 18])
  .execute()

// Complex conditions with multiple filters
const eligibleUsers = await db
  .selectFrom('users')
  .where({ active: true })
  .andWhere(['age', '>=', 18])
  .andWhere(['country', 'in', ['US', 'CA', 'GB']])
  .orWhere(['role', '=', 'admin'])
  .execute()

// Dynamic condition building
async function searchUsers(filters: { name?: string, role?: string, minAge?: number }) {
  let query = db.selectFrom('users')

  if (filters.name) {
    query = query.where(['name', 'like', `%${filters.name}%`])
  }
  if (filters.role) {
    query = query.andWhere({ role: filters.role })
  }
  if (filters.minAge) {
    query = query.andWhere(['age', '>=', filters.minAge])
  }

  return await query.execute()
}

// Chris's team members
const chrisTeam = await db
  .selectFrom('users')
  .where({ team_lead: 'Chris', active: true })
  .orWhere({ name: 'Chris' }) // Include Chris himself
  .execute()
```

### NULL and BETWEEN helpers

```ts
// Find orders that haven't been shipped yet
const unshippedOrders = await db
  .selectFrom('orders')
  .whereNull('shipped_at')
  .where({ status: 'paid' })
  .execute()

// Find orders within a price range
const mediumOrders = await db
  .selectFrom('orders')
  .whereBetween('total', 100, 500)
  .execute()

// Exclude small orders
const largerOrders = await db
  .selectFrom('orders')
  .whereNotBetween('total', 0, 99)
  .execute()

// Check for non-null profile data
const completeProfiles = await db
  .selectFrom('users')
  .whereNotNull('profile_picture')
  .whereNotNull('bio')
  .execute()
```

### Column to Column and Nesting

```ts
// Compare columns within the same row
const validEvents = await db
  .selectFrom('events')
  .whereColumn('start_at', '<=', 'end_at')
  .whereColumn('registration_end', '>=', 'registration_start')
  .execute()

// Nested subquery conditions
const popularEvents = await db
  .selectFrom('events')
  .whereColumn('start_at', '<=', 'end_at')
  .orWhereNested(
    db.selectFrom('events').where(['name', 'like', '%conference%'])
  )
  .execute()

// Complex nested conditions
const buddyEvents = await db
  .selectFrom('events')
  .where({ organizer: 'Buddy' })
  .orWhereNested(qb =>
    qb.where(['category', '=', 'workshop'])
      .andWhere(['max_attendees', '>', 50])
  )
  .execute()
```

### Dates and JSON

```ts
// Date comparisons for upcoming events
const upcomingEvents = await db
  .selectFrom('events')
  .whereDate('start_at', '>=', new Date())
  .orderBy('start_at', 'asc')
  .execute()

// Find users who joined this month
const newUsers = await db
  .selectFrom('users')
  .whereDate('created_at', '>=', new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  .execute()

// JSON contains queries
const betaUsers = await db
  .selectFrom('users')
  .whereJsonContains('meta', { beta: true, tier: 'premium' })
  .execute()

// JSON path comparisons (PostgreSQL)
const darkModeUsers = await db
  .selectFrom('users')
  .whereJsonPath?.('meta->preferences->theme', '=', 'dark')
  ?.execute()

// Avery's preferences stored in JSON
const averyPrefs = await db
  .selectFrom('users')
  .where({ name: 'Avery' })
  .whereJsonContains('preferences', { notifications: true })
  .execute()
```

### Best Practices for Filtering

- **Use indexes**: Ensure filtered columns have appropriate database indexes
- **Parameterized queries**: The builder automatically parameterizes values for SQL injection safety
- **Logical grouping**: Use `orWhere` and `andWhere` to create clear logical groups
- **Dynamic filters**: Build conditions conditionally based on user input or application state
- **JSON performance**: Be mindful that JSON operations may require special indexes

## Joining Tables

```ts
await db
  .selectFrom('users')
  .innerJoin('profiles', 'users.id', '=', 'profiles.user_id')
  .leftJoin('projects', 'users.id', '=', 'projects.user_id')
  .where(['projects.status', '=', 'active'])
  .execute()
```

### Subquery Joins

```ts
const activeProjects = db
  .selectFrom('projects')
  .where(['status', '=', 'active'])

await db
  .selectFrom('users')
  .joinSub(activeProjects, 'ap', 'users.id', '=', 'ap.user_id')
  .execute()
```

## Grouping, Aggregates, Having

```ts
await db
  .selectFrom('users')
  .groupBy('country')
  .having(['country', '!=', ''])
  .execute()
```

### Aggregate Methods

Aggregation methods are available on the query builder for convenient calculations:

```ts
// Count records
const userCount = await db.selectFrom('users').count()
const activeUserCount = await db.selectFrom('users')
  .where({ active: true })
  .count()

// Average calculations
const avgAge = await db.selectFrom('users').avg('age')
const avgOrderTotal = await db.selectFrom('orders')
  .where({ status: 'completed' })
  .avg('total')

// Sum calculations
const totalRevenue = await db.selectFrom('orders')
  .where({ status: 'paid' })
  .sum('amount')

// Min and Max values
const youngestAge = await db.selectFrom('users').min('age')
const oldestAge = await db.selectFrom('users').max('age')
const highestScore = await db.selectFrom('games').max('score')
const lowestScore = await db.selectFrom('games').min('score')
```

These methods work seamlessly with filtering and other query builders:

```ts
// Complex aggregation with conditions
const stats = {
  avgActiveUserAge: await db.selectFrom('users')
    .where({ active: true })
    .avg('age'),
  maxInactiveUserAge: await db.selectFrom('users')
    .where({ active: false })
    .max('age'),
  totalPremiumRevenue: await db.selectFrom('subscriptions')
    .where({ tier: 'premium' })
    .sum('monthly_price')
}
```

## Ordering, Limiting, Paging

```ts
await db
  .selectFrom('articles')
  .latest('published_at')
  .forPage(2, 25)
  .execute()
```

### Random ordering

```ts
await db.selectFrom('tips').inRandomOrder().limit(1).execute()
```

## Modifiers: Distinct and Distinct On

```ts
await db.selectFrom('users').distinct().execute()
await db.selectFrom('users').distinctOn('email').execute() // PG-only
```

## Raw Expressions

Use raw sparingly for complex cases not covered by helpers.

```ts
await db
  .selectFrom('users')
  .whereRaw(db.sql`coalesce(age, 0) > 0`)
  .groupByRaw(db.sql`country`)
  .havingRaw(db.sql`count(*) > 10`)
  .execute()
```

## Relations Shortcuts and Auto-Aliasing

```ts
await db
  .selectFrom('users')
  .with('Project')
  .selectAllRelations()
  .execute()
```

### Nested relations and many-to-many

```ts
await db
  .selectFrom('users')
  .with('Project', 'Project.tags') // nested path
  .execute()
```

## Timeouts, Cancellation, and Hooks

```ts
// 1) Per-query timeout
await db.selectFrom('users').withTimeout(250).get()

// 2) AbortSignal
const ac = new AbortController()
const p = db.selectFrom('users').abort(ac.signal).get()
ac.abort()
await p
```

### Query Hooks

Query hooks provide observability into query execution:

```ts
import { config } from 'bun-query-builder'

config.hooks = {
  onQueryStart: ({ sql, params, kind }) => {
    logger.debug({ sql, params, kind })
  },
  onQueryEnd: ({ sql, durationMs, rowCount, kind }) => {
    logger.info({ sql, durationMs, rowCount, kind })
  },
  onQueryError: ({ sql, error, durationMs, kind }) => {
    logger.error({ sql, error, durationMs, kind })
  },
  startSpan: ({ sql, kind }) => {
    const span = tracer.startSpan('db.query', { sql, kind })
    return {
      end: (error?: any) => span.end(error)
    }
  }
}
```

### Model Lifecycle Hooks

Model hooks allow you to intercept and react to CRUD operations:

```ts
import { createQueryBuilder } from 'bun-query-builder'

const db = createQueryBuilder({
  schema,
  meta,
  hooks: {
    // CREATE hooks
    beforeCreate: async ({ table, data }) => {
      console.log(`Creating ${table}:`, data)
      // Modify data, validate, or throw to prevent creation
      if (table === 'users' && !data.email) {
        throw new Error('Email is required')
      }
    },
    afterCreate: async ({ table, data, result }) => {
      console.log(`Created ${table}:`, result)
      // Trigger notifications, update caches, send webhooks, etc.
      if (table === 'users') {
        await sendWelcomeEmail(result.email)
      }
    },

    // UPDATE hooks
    beforeUpdate: async ({ table, data, where }) => {
      console.log(`Updating ${table}:`, { data, where })
      // Audit logging, validation, etc.
      await auditLog.record('update', table, data)
    },
    afterUpdate: async ({ table, data, where, result }) => {
      console.log(`Updated ${table}:`, result)
      // Clear related caches, send webhooks, etc.
      await cache.invalidate(`${table}:*`)
    },

    // DELETE hooks
    beforeDelete: async ({ table, where }) => {
      console.log(`Deleting from ${table}:`, where)
      // Prevent deletion, check constraints, etc.
      if (table === 'users') {
        const hasActiveOrders = await checkActiveOrders(where)
        if (hasActiveOrders) {
          throw new Error('Cannot delete user with active orders')
        }
      }
    },
    afterDelete: async ({ table, where, result }) => {
      console.log(`Deleted from ${table}:`, result)
      // Clean up related data, update aggregates, etc.
      await cleanupRelatedData(table, where)
    },
  }
})
```

**Hook Use Cases:**
- **Validation**: Enforce business rules before operations
- **Audit Logging**: Track all data changes
- **Cache Invalidation**: Clear caches when data changes
- **Webhooks**: Trigger external integrations
- **Notifications**: Send emails, push notifications, etc.
- **Cascade Operations**: Clean up or update related records
- **Analytics**: Track usage patterns and metrics

**Best Practices:**
- Keep hooks fast to avoid slowing down queries
- Use async hooks for I/O operations
- Throw errors in before* hooks to prevent operations
- Never throw in after* hooks (log errors instead)
- Be mindful of infinite loops (hook triggering another query)

## Soft deletes

Enable a global soft‑delete filter and override it per query.

```ts
import { config } from 'bun-query-builder'

// Enable default filter (WHERE deleted_at IS NULL)
config.softDeletes = { enabled: true, column: 'deleted_at', defaultFilter: true }

// Default: filtered out
await db.selectFrom('users').get()

// Include soft‑deleted rows
await db.selectFrom('users').withTrashed?.().get()

// Only soft‑deleted rows
await db.selectFrom('users').onlyTrashed?.().get()
```

Configure alias formats via `config.aliasing.relationColumnAliasFormat`.

## Query Caching

The query builder includes a built-in LRU cache with TTL support for frequently-run queries:

```ts
// Cache results for 60 seconds (default TTL)
const users = await db.selectFrom('users')
  .where({ active: true })
  .cache()
  .get()

// Custom cache TTL (5 seconds)
const recentPosts = await db.selectFrom('posts')
  .orderBy('created_at', 'desc')
  .limit(10)
  .cache(5000)
  .get()

// Cache with complex queries
const stats = await db.selectFrom('analytics')
  .where(['date', '>=', startDate])
  .where(['date', '<=', endDate])
  .groupBy('category')
  .cache(300000) // 5 minutes
  .get()
```

### Cache Management

```ts
import { clearQueryCache, setQueryCacheMaxSize } from 'bun-query-builder'

// Clear all cached queries
clearQueryCache()

// Configure cache size (default: 100 entries)
setQueryCacheMaxSize(500)
```

**Best Practices:**
- Use caching for expensive queries that don't change frequently
- Set appropriate TTL based on data freshness requirements
- Clear cache when underlying data changes
- Consider cache size based on available memory
- Cache works transparently - query results are cached automatically

## Batch Operations

Efficient batch operations for inserting, updating, and deleting multiple records:

```ts
// Insert multiple records at once
await db.insertMany('users', [
  { name: 'Alice', email: 'alice@example.com', role: 'user' },
  { name: 'Bob', email: 'bob@example.com', role: 'user' },
  { name: 'Charlie', email: 'charlie@example.com', role: 'admin' },
])

// Update multiple records matching conditions
const affectedRows = await db.updateMany(
  'users',
  { verified: false }, // conditions
  { status: 'pending', verification_sent: new Date() } // updates
)

// Delete multiple records by IDs
const deletedCount = await db.deleteMany('old_sessions', [1, 2, 3, 4, 5])
```

**Performance Tips:**
- `insertMany()` is more efficient than multiple individual inserts
- Use `updateMany()` for bulk updates with conditions
- `deleteMany()` uses `WHERE id IN (...)` for efficient bulk deletion
- Consider transaction boundaries for large batch operations

## DML: Insert / Update / Delete

### Insert Operations

```ts
// Insert single user
const newUser = await db
  .insertInto('users')
  .values({
    name: 'Chris',
    email: 'chris@example.com',
    role: 'admin',
    active: true
  })
  .execute()

// Insert multiple users
await db
  .insertInto('users')
  .values([
    { name: 'Avery', email: 'avery@example.com', role: 'member' },
    { name: 'Buddy', email: 'buddy@example.com', role: 'member' },
  ])
  .execute()

// Insert with returning (PostgreSQL)
const insertedUser = await db
  .insertInto('users')
  .values({
    name: 'Chris',
    email: 'chris@dev.com',
    created_at: new Date()
  })
  .returning('id', 'created_at')
  .execute()

// Insert with conflict handling (upsert)
await db.upsert(
  'users',
  [{ email: 'avery@example.com', name: 'Avery Updated', last_login: new Date() }],
  ['email'], // conflict columns
  ['name', 'last_login'] // columns to update on conflict
)
```

### Update Operations

```ts
// Update single record
await db
  .updateTable('users')
  .set({
    active: false,
    deactivated_at: new Date(),
    deactivated_by: 'admin'
  })
  .where(['id', '=', 1])
  .execute()

// Update with complex conditions
await db
  .updateTable('users')
  .set({ last_login: new Date(), login_count: db.sql`login_count + 1` })
  .where({ email: 'chris@example.com' })
  .andWhere(['active', '=', true])
  .execute()

// Bulk update with returning
const updatedUsers = await db
  .updateTable('users')
  .set({ status: 'verified' })
  .where(['created_at', '>', new Date('2024-01-01')])
  .returning('id', 'email', 'status')
  .execute()

// Conditional updates
await db
  .updateTable('projects')
  .set({
    status: 'completed',
    completed_by: 'Buddy',
    completed_at: new Date()
  })
  .where(['owner', '=', 'Buddy'])
  .andWhere(['status', '=', 'in_progress'])
  .execute()
```

### Delete Operations

```ts
// Delete specific records
await db
  .deleteFrom('users')
  .where(['id', 'in', [2, 3, 4]])
  .execute()

// Soft delete (recommended)
await db
  .updateTable('users')
  .set({ deleted_at: new Date(), deleted_by: 'admin' })
  .where(['email', '=', 'old-user@example.com'])
  .execute()

// Delete with complex conditions
await db
  .deleteFrom('sessions')
  .where(['created_at', '<', new Date(Date.now() - 24 * 60 * 60 * 1000)]) // older than 24h
  .andWhere(['user_id', 'is not', null])
  .execute()

// Delete with returning (PostgreSQL)
const deletedRecords = await db
  .deleteFrom('temp_data')
  .where(['processed', '=', true])
  .returning('id', 'created_at')
  .execute()
```

### Helper Methods

```ts
// Convenient creation methods
const chris = await db.create('users', {
  name: 'Chris',
  email: 'chris@example.com',
  role: 'admin'
})

// Create many at once
await db.createMany('posts', [
  { title: 'Avery\'s First Post', author_id: avery.id, published: true },
  { title: 'Buddy\'s Tutorial', author_id: buddy.id, published: false }
])

// Find or create pattern
const user = await db.firstOrCreate(
  'users',
  { email: 'chris@example.com' }, // search criteria
  { name: 'Chris', role: 'admin' } // defaults if creating
)

// Update or create
const profile = await db.updateOrCreate(
  'profiles',
  { user_id: chris.id }, // match criteria
  { bio: 'Updated bio', avatar_url: 'new-avatar.jpg' } // values to set
)

// Save method (update if exists, create if not)
const savedUser = await db.save('users', {
  id: chris.id, // if ID exists, updates; otherwise creates
  name: 'Chris Updated',
  last_activity: new Date()
})
```

## Pagination and Chunking

See the Pagination page for details. Highlights:

```ts
await db.selectFrom('users').paginate(25, 1)
await db.selectFrom('users').simplePaginate(25)
await db.selectFrom('users').cursorPaginate(100, undefined, 'id', 'asc')
await db.selectFrom('users').chunkById(1000, 'id', async (batch) => { /* ... */ })
```

## CTEs and Recursive Queries

```ts
const sub = db.selectFrom('users').where(['active', '=', true])
await db.selectFrom('users').withCTE('active_users', sub).execute()

const recursive = db.selectFrom('nodes') // build your recursive part
await db.selectFrom('nodes').withRecursive('tree', recursive).execute()
```

## Locks and Concurrency Controls

```ts
await db.selectFrom('orders').lockForUpdate().execute()
await db.selectFrom('orders').sharedLock().execute()
```

Respect your dialect via `config.sql.sharedLockSyntax`.

## Flow Utilities

```ts
await db
  .selectFrom('users')
  .when(process.env.DEBUG, qb => qb.dump())
  .tap(qb => qb.orderBy('created_at', 'desc'))
  .explain()
```

- `when(cond, then, otherwise?)`
- `tap(fn)` for inline mutation
- `dump()` prints SQL
- `dd()` prints then throws
- `explain()` returns plan rows

## Execution, toSQL, simple, values, raw

```ts
const q = db.selectFrom('users').where({ active: true }).toSQL()
const rows = await q.execute()
const valueMatrix = await q.values()
const rawWire = await q.raw()

// simple protocol (e.g., DDL or multi-statement)
await (q as any).simple()?.execute?.()
```

## Debugging and toText

```ts
import { config } from 'bun-query-builder'
config.debug = { captureText: true }
const q = db.selectFrom('users').where({ active: true }).toSQL()
console.log((q as any).toText?.())
```

Disable in production.

## Best Practices

### Query Construction

- **Type Safety First**: Leverage the builder's type inference by defining comprehensive models
- **Method Chaining**: Use fluent chaining for readability: `db.selectFrom('users').where(...).orderBy(...)`
- **Conditional Logic**: Use the `when()` method for conditional query building instead of if statements
- **Raw SQL Sparingly**: Prefer structured methods over `whereRaw()` when possible for better type safety

```ts
// Good: Use structured methods
const users = await db
  .selectFrom('users')
  .where({ active: true })
  .when(includeAdmin, qb => qb.orWhere({ role: 'admin' }))
  .orderBy('created_at', 'desc')
  .execute()

// Avoid: Excessive raw SQL
const users = await db
  .selectFrom('users')
  .whereRaw(db.sql`active = true ${includeAdmin ? 'OR role = "admin"' : ''}`)
  .execute()
```

### Performance Optimization

- **Select Only What You Need**: Avoid `SELECT *` in production; specify columns explicitly
- **Use Appropriate Indexes**: Ensure filtered and joined columns have database indexes
- **Pagination Strategy**: Use cursor-based pagination for large datasets instead of offset-based
- **Batch Operations**: Use `insertMany()`, `chunkById()`, and `eachById()` for bulk operations
- **Connection Pooling**: Configure appropriate pool sizes for your workload

```ts
// Good: Selective column selection
const userSummary = await db
  .select('users', 'id', 'name', 'email')
  .where({ active: true })
  .execute()

// Good: Cursor pagination for large datasets
const page = await db
  .selectFrom('events')
  .cursorPaginate(50, cursor, 'created_at', 'desc')

// Good: Efficient bulk processing
await db.selectFrom('large_table').chunkById(1000, 'id', async (batch) => {
  // Process batch efficiently
  await processBatch(batch)
})
```

### Security and Safety

- **Parameterized Queries**: The builder automatically parameterizes inputs—don't bypass this
- **Input Validation**: Validate user inputs before passing to query methods
- **Privilege Principle**: Use least-privilege database users for application connections
- **SQL Injection**: Be extra careful with `whereRaw()` and dynamic identifier construction

```ts
// Good: Safe parameterized query
const user = await db
  .selectFrom('users')
  .where({ email: userInput.email })
  .first()

// Dangerous: String interpolation
const user = await db
  .selectFrom('users')
  .whereRaw(db.sql`email = '${userInput.email}'`) // DON'T DO THIS
```

### Error Handling and Monitoring

- **Transaction Boundaries**: Use transactions for multi-step operations that must succeed together
- **Query Timeouts**: Set appropriate timeouts for long-running operations
- **Error Logging**: Log query errors with context but avoid logging sensitive data
- **Performance Monitoring**: Track query execution times and identify slow queries

```ts
// Good: Proper transaction usage
await db.transaction(async (tx) => {
  const user = await tx.insertInto('users').values(userData).returning('id').execute()
  await tx.insertInto('profiles').values({ user_id: user[0].id, ...profileData }).execute()
})

// Good: Query timeout
const results = await db
  .selectFrom('heavy_analytics')
  .withTimeout(30000) // 30 second timeout
  .execute()
```

### Development Workflow

- **Enable Debug Mode**: Use `config.debug.captureText = true` in development for query inspection
- **Query Testing**: Write tests that verify both query structure and results
- **Migration Strategy**: Use the builder for data migrations and seed scripts
- **Documentation**: Document complex queries and business logic they represent

```ts
// Development debugging
if (process.env.NODE_ENV === 'development') {
  config.debug = { captureText: true }
}

// Query testing example
it('should find Chris\'s active projects', async () => {
  const query = db
    .selectFrom('projects')
    .where({ owner: 'Chris', status: 'active' })
    .orderBy('created_at', 'desc')
    .toSQL()

  expect(query.toText()).toContain('WHERE')
  expect(query.toText()).toContain('ORDER BY')

  const results = await query.execute()
  expect(results.every(p => p.owner === 'Chris')).toBe(true)
})
```

## Security and SQL Injection Safety

- Most methods parameterize inputs under the hood via Bun `sql`
- Prefer structured helpers over raw strings
- Validate dynamic identifiers if interpolated into raw fragments

## Type-safety Guide

- Tables and columns are typed from your model definitions
- `select('table', 'col as alias')` maintains output typing for known columns
- Joining introduces union of tables for column refs via `JoinColumn` typing

## Performance Tips

- Use `select()` to avoid fetching unnecessary columns
- Prefer `paginate` or `cursorPaginate` over large offsets
- Push heavy work into the database with aggregates and CTEs when appropriate

## Error Handling

- Wrap calls in transactions for multi-step consistency
- Consider `when` to toggle debug/trace behavior

## Recipes

### Advanced User Management

```ts
// Soft delete with audit trail
async function softDeleteUser(userId: number, deletedBy: string) {
  return await db.transaction(async (tx) => {
    // Update user record
    await tx
      .updateTable('users')
      .set({
        deleted_at: new Date(),
        deleted_by: deletedBy,
        status: 'deleted'
      })
      .where(['id', '=', userId])
      .execute()

    // Log the action
    await tx
      .insertInto('audit_logs')
      .values({
        action: 'user_deleted',
        user_id: userId,
        performed_by: deletedBy,
        created_at: new Date()
      })
      .execute()
  })
}

// Find active users excluding soft deletes
const activeUsers = await db
  .selectFrom('users')
  .whereNull('deleted_at')
  .where({ active: true })
  .execute()
```

### Upsert Patterns

```ts
// User profile upsert
await db.upsert(
  'user_profiles',
  [{
    user_id: chris.id,
    bio: 'Chris is a software engineer with expertise in TypeScript and databases.',
    location: 'San Francisco, CA',
    website: 'https://chris.dev'
  }],
  ['user_id'], // conflict on user_id
  ['bio', 'location', 'website', 'updated_at'] // update these columns
)

// Batch upsert for user preferences
await db.upsert(
  'user_preferences',
  [
    { user_id: chris.id, key: 'theme', value: 'dark' },
    { user_id: avery.id, key: 'theme', value: 'light' },
    { user_id: buddy.id, key: 'notifications', value: 'email' }
  ],
  ['user_id', 'key'],
  ['value', 'updated_at']
)
```

### Search and Discovery

```ts
// Federated search across multiple content types
const searchQuery = 'TypeScript'

const articleResults = db
  .selectFrom('articles')
  .select('articles', 'id', 'title', 'created_at')
  .selectRaw(db.sql`'article' as content_type`)
  .where(['title', 'like', `%${searchQuery}%`])
  .orWhere(['content', 'like', `%${searchQuery}%`])

const projectResults = db
  .selectFrom('projects')
  .select('projects', 'id', 'name as title', 'created_at')
  .selectRaw(db.sql`'project' as content_type`)
  .where(['name', 'like', `%${searchQuery}%`])
  .orWhere(['description', 'like', `%${searchQuery}%`])

const allResults = await articleResults
  .unionAll(projectResults)
  .orderBy('created_at', 'desc')
  .limit(20)
  .execute()
```

### Analytics and Reporting

```ts
// User engagement metrics
const userStats = await db
  .selectFrom('users')
  .select('users', 'id', 'name')
  .withCount('posts', 'total_posts')
  .withCount('posts', 'published_posts', ['published', '=', true])
  .withCount('comments', 'total_comments')
  .selectRaw(db.sql`
    CASE
      WHEN COUNT(posts.id) > 10 THEN 'high'
      WHEN COUNT(posts.id) > 5 THEN 'medium'
      ELSE 'low'
    END as activity_level
  `)
  .leftJoin('posts', 'posts.author_id', '=', 'users.id')
  .leftJoin('comments', 'comments.user_id', '=', 'users.id')
  .groupBy('users.id', 'users.name')
  .execute()

// Monthly user registration trends
const registrationTrends = await db
  .selectFrom('users')
  .selectRaw(db.sql`
    DATE_TRUNC('month', created_at) as month,
    COUNT(*) as new_users,
    COUNT(CASE WHEN role = 'admin' THEN 1 END) as new_admins
  `)
  .where(['created_at', '>=', new Date('2024-01-01')])
  .groupBy(db.sql`DATE_TRUNC('month', created_at)`)
  .orderBy('month', 'desc')
  .execute()
```

### Complex Relationships

```ts
// Find Chris's team with their project counts
const chrisTeamWithStats = await db
  .selectFrom('users')
  .select('users', 'id', 'name', 'role')
  .withCount('projects', 'active_projects', ['status', '=', 'active'])
  .withCount('projects', 'total_projects')
  .where(['team_lead', '=', 'Chris'])
  .orWhere(['name', '=', 'Chris'])
  .orderBy('role', 'asc')
  .orderBy('name', 'asc')
  .execute()

// Projects with collaborator details
const projectsWithCollaborators = await db
  .selectFrom('projects')
  .select('projects', 'id', 'name', 'description')
  .selectRaw(db.sql`
    STRING_AGG(users.name, ', ') as collaborators,
    COUNT(DISTINCT project_users.user_id) as collaborator_count
  `)
  .leftJoin('project_users', 'project_users.project_id', '=', 'projects.id')
  .leftJoin('users', 'users.id', '=', 'project_users.user_id')
  .where(['projects.status', '=', 'active'])
  .groupBy('projects.id', 'projects.name', 'projects.description')
  .having(['COUNT(DISTINCT project_users.user_id)', '>', 1])
  .execute()
```

### Data Maintenance

```ts
// Cleanup old sessions
async function cleanupOldSessions() {
  const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days ago

  const deletedCount = await db
    .deleteFrom('user_sessions')
    .where(['last_activity', '<', cutoffDate])
    .returning('id')
    .execute()

  console.log(`Cleaned up ${deletedCount.length} old sessions`)
  return deletedCount.length
}

// Archive completed projects
async function archiveCompletedProjects() {
  return await db.transaction(async (tx) => {
    // Find projects completed over 6 months ago
    const projectsToArchive = await tx
      .selectFrom('projects')
      .select('projects', 'id', 'name')
      .where(['status', '=', 'completed'])
      .where(['completed_at', '<', new Date(Date.now() - 6 * 30 * 24 * 60 * 60 * 1000)])
      .execute()

    if (projectsToArchive.length === 0)
      return 0

    // Move to archive table
    await tx
      .insertInto('archived_projects')
      .values(projectsToArchive.map(p => ({
        original_id: p.id,
        name: p.name,
        archived_at: new Date(),
        archived_by: 'system'
      })))
      .execute()

    // Update original records
    await tx
      .updateTable('projects')
      .set({ status: 'archived', archived_at: new Date() })
      .where(['id', 'in', projectsToArchive.map(p => p.id)])
      .execute()

    return projectsToArchive.length
  })
}
```

## FAQ

### Why does `toSQL()` return an object instead of a string?

Because Bun’s `sql` returns a query object that preserves parameterization and execution features. We expose it directly for performance and safety.

### How do I print the SQL text?

Enable `config.debug.captureText = true` and call `(q as any).toText?.()`.

### How do I compare two columns?

Use `whereColumn(left, op, right)`.

### How do I add arbitrary fragments?

Use `selectRaw`, `whereRaw`, `groupByRaw`, or `havingRaw` and pass a Bun `sql` fragment.

---

## Quick Reference

- **Selection**: `selectFrom`, `select`, `selectRaw`
- **Filters**: `where`, `andWhere`, `orWhere`, `whereNull`, `whereBetween`, `whereColumn`, `whereDate`, `whereJsonContains`, `whereNested`
- **Joins**: `join`, `innerJoin`, `leftJoin`, `rightJoin`, `crossJoin`, `joinSub`, `leftJoinSub`, `crossJoinSub`
- **Grouping**: `groupBy`, `groupByRaw`, `having`, `havingRaw`
- **Aggregations**: `count()`, `avg(column)`, `sum(column)`, `max(column)`, `min(column)`
- **Unions**: `union`, `unionAll`
- **Modifiers**: `distinct`, `distinctOn`
- **Order/Paging**: `orderBy`, `orderByDesc`, `latest`, `oldest`, `inRandomOrder`, `reorder`, `limit`, `offset`, `forPage`
- **Results**: `value`, `pluck`, `exists`, `doesntExist`
- **Pagination**: `paginate`, `simplePaginate`, `cursorPaginate`, `chunk`, `chunkById`, `eachById`
- **DML**: `insertInto`, `updateTable`, `deleteFrom`, `returning`
- **Batch Operations**: `insertMany(table, records[])`, `updateMany(table, conditions, data)`, `deleteMany(table, ids[])`
- **Caching**: `cache(ttlMs?)`, `clearQueryCache()`, `setQueryCacheMaxSize(size)`
- **Flow**: `when`, `tap`, `dump`, `dd`, `explain`
- **CTEs**: `withCTE`, `withRecursive`
- **Locks**: `lockForUpdate`, `sharedLock`
- **Relations**: `with()`, `withCount()`, `whereHas()`, `has()`, `doesntHave()`
- **Soft Deletes**: `withTrashed()`, `onlyTrashed()`
