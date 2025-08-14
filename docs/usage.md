# Usage

There are two ways to use bun-query-builder: as a library and via the CLI. This guide covers both approaches with comprehensive examples and best practices.

## Library Usage

### Quick Start

```ts
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from 'bun-query-builder'

// Define your models with relationships
const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
      team_id: { validation: { rule: {} } },
      active: { validation: { rule: {} } },
      created_at: { validation: { rule: {} } }
    },
    belongsTo: {
      Team: { foreignKey: 'team_id', table: 'teams' }
    },
    hasMany: {
      Post: { foreignKey: 'author_id', table: 'posts' }
    }
  },
  Team: {
    name: 'Team',
    table: 'teams',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      name: { validation: { rule: {} } },
      department: { validation: { rule: {} } }
    }
  },
  Post: {
    name: 'Post',
    table: 'posts',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      title: { validation: { rule: {} } },
      content: { validation: { rule: {} } },
      author_id: { validation: { rule: {} } },
      published: { validation: { rule: {} } },
      created_at: { validation: { rule: {} } }
    },
    belongsTo: {
      User: { foreignKey: 'author_id', table: 'users' }
    }
  }
} as const

const schema = buildDatabaseSchema(models)
const meta = buildSchemaMeta(models)
const db = createQueryBuilder<typeof schema>({ schema, meta })
```

### Basic Queries

```ts
// Chris's team: Find active users with pagination
const activeUsers = await db
  .selectFrom('users')
  .where({ active: true })
  .orderByDesc('created_at')
  .paginate(25, 1)

// Avery's e-commerce: Complex product filtering
const featuredProducts = await db
  .selectFrom('products')
  .where(['active', '=', true])
  .whereJsonContains('attributes', { featured: true })
  .whereBetween('price', 10.00, 100.00)
  .orderBy('popularity_score', 'desc')
  .limit(20)
  .execute()

// Buddy's analytics: User engagement metrics
const userStats = await db
  .selectFrom('users')
  .selectRaw(db.sql`
    COUNT(posts.id) as post_count,
    AVG(posts.engagement_score) as avg_engagement
  `)
  .leftJoin('posts', 'posts.author_id', '=', 'users.id')
  .where(['users.created_at', '>=', new Date('2024-01-01')])
  .groupBy('users.id', 'users.name')
  .having(['post_count', '>', 0])
  .execute()
```

### Data Manipulation Operations

```ts
// Create new user (Chris's onboarding flow)
const newUser = await db
  .insertInto('users')
  .values({
    name: 'Chris Johnson',
    email: 'chris@company.com',
    team_id: 1,
    active: true,
    created_at: new Date()
  })
  .returning('id')
  .execute()

// Batch insert (Avery's bulk import)
const newProducts = await db
  .insertInto('products')
  .values([
    { name: 'Product A', price: 29.99, category_id: 1 },
    { name: 'Product B', price: 49.99, category_id: 2 },
    { name: 'Product C', price: 19.99, category_id: 1 }
  ])
  .execute()

// Update user profile (Buddy's user management)
await db
  .updateTable('users')
  .set({
    name: 'Buddy Smith',
    updated_at: new Date()
  })
  .where(['email', '=', 'buddy@company.com'])
  .execute()

// Conditional delete (Chris's data cleanup)
await db
  .deleteFrom('sessions')
  .where(['last_activity', '<', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)])
  .execute()
```

### Advanced Relationships

```ts
// Eager loading with Chris's user dashboard
const usersWithTeamsAndPosts = await db
  .selectFrom('users')
  .with('Team', 'Post')
  .selectAllRelations()
  .where({ 'users.active': true })
  .limit(10)
  .execute()

// Relation counting for Avery's admin panel
const teamsWithUserCounts = await db
  .selectFrom('teams')
  .withCount('User', 'member_count')
  .withCount('User', 'active_members', ['active', '=', true])
  .orderByDesc('member_count')
  .execute()

// Existence filtering for Buddy's content moderation
const activeAuthors = await db
  .selectFrom('users')
  .whereHas('Post', qb =>
    qb.where(['published', '=', true])
      .andWhere(['created_at', '>', new Date('2024-01-01')]))
  .execute()
```

### Robust Transaction Handling

```ts
// Chris's user onboarding with comprehensive error handling
async function createUserWithProfile(userData: any, profileData: any) {
  return await db.transaction(async (tx) => {
    try {
      // Create user
      const user = await tx
        .insertInto('users')
        .values(userData)
        .returning('id')
        .execute()

      // Create profile
      await tx
        .insertInto('profiles')
        .values({
          user_id: user[0].id,
          ...profileData
        })
        .execute()

      // Log successful creation
      await tx
        .insertInto('audit_logs')
        .values({
          action: 'user_created',
          user_id: user[0].id,
          timestamp: new Date()
        })
        .execute()

      return user[0]
    }
    catch (error) {
      console.error('User creation failed:', error)
      throw error // Transaction will auto-rollback
    }
  }, {
    retries: 3,
    isolation: 'read committed',
    backoff: { baseMs: 100, factor: 2, maxMs: 1000, jitter: true }
  })
}

// Avery's e-commerce order processing
async function processOrderTransaction(orderData: any) {
  return await db.transaction(async (tx) => {
    // Reserve inventory
    for (const item of orderData.items) {
      const product = await tx
        .selectFrom('products')
        .select('stock_quantity')
        .where({ id: item.product_id })
        .forUpdate() // Lock for update
        .first()

      if (!product || product.stock_quantity < item.quantity) {
        throw new Error(`Insufficient stock for product ${item.product_id}`)
      }

      await tx
        .updateTable('products')
        .set({ stock_quantity: db.sql`stock_quantity - ${item.quantity}` })
        .where({ id: item.product_id })
        .execute()
    }

    // Create order
    const order = await tx
      .insertInto('orders')
      .values({
        customer_id: orderData.customer_id,
        status: 'processing',
        total: orderData.total,
        created_at: new Date()
      })
      .returning('id')
      .execute()

    return order[0]
  }, { retries: 5, isolation: 'serializable' })
}
```

### Performance Optimization Patterns

```ts
// Buddy's efficient bulk processing
async function processBulkData(items: any[]) {
  await db
    .selectFrom('large_table')
    .where(['processed', '=', false])
    .orderBy('id', 'asc')
    .chunkById(1000, 'id', async (batch) => {
      // Process each batch
      const processed = batch.map(item => ({
        ...item,
        processed: true,
        processed_at: new Date()
      }))

      // Batch update
      for (const item of processed) {
        await db
          .updateTable('large_table')
          .set({ processed: true, processed_at: item.processed_at })
          .where({ id: item.id })
          .execute()
      }

      console.log(`Processed ${batch.length} items`)
    })
}

// Chris's optimized pagination for APIs
async function getUsersPaginated(page: number = 1, perPage: number = 25) {
  const result = await db
    .selectFrom('users')
    .select('id', 'name', 'email', 'created_at')
    .where({ active: true })
    .orderByDesc('created_at')
    .paginate(perPage, page)

  return {
    users: result.data,
    pagination: {
      current_page: result.meta.currentPage,
      total_pages: result.meta.lastPage,
      total_count: result.meta.total,
      per_page: perPage,
      has_next: result.meta.hasNextPage,
      has_prev: result.meta.hasPreviousPage
    }
  }
}

// Avery's cursor-based infinite scroll
async function getProductsFeed(cursor?: string, limit: number = 20) {
  return await db
    .selectFrom('products')
    .with('Category', 'Reviews')
    .selectAllRelations()
    .where({ active: true })
    .cursorPaginate(limit, cursor, 'created_at', 'desc')
}
```

### Library Best Practices

- **Type Safety**: Always use properly typed models to get full TypeScript inference
- **Model Naming**: Keep model attribute keys in `snake_case` to align with SQL conventions
- **Query Building**: Prefer `where({})` for simple equality, tuples for explicit operators
- **Pagination**: Use `paginate/simplePaginate/cursorPaginate` instead of manual LIMIT/OFFSET for UIs
- **Transactions**: Wrap related operations in transactions with appropriate retry and isolation settings
- **Relations**: Use `with()` for eager loading and `whereHas()` for existence filtering
- **Performance**: Use chunking methods for processing large datasets
- **Error Handling**: Always handle database errors gracefully and provide meaningful error messages

## CLI Usage

The CLI provides powerful tools for development, debugging, and operational tasks. Here are comprehensive examples for different use cases.

### Development and Schema Introspection

```bash
# Chris's development workflow: Inspect models and generate schema
query-builder introspect ./app/Models --verbose
query-builder introspect ./app/Models --output schema.json

# Avery's API development: Generate sample queries for documentation
query-builder sql ./app/Models users --limit 10 --where "active = true"
query-builder sql ./app/Models products --joins "categories,reviews" --limit 5

# Buddy's testing: Quick schema validation
query-builder introspect ./models --validate-only
```

### Database Connectivity and Health Checks

```bash
# Production readiness checks (great for Kubernetes probes)
query-builder ping
query-builder wait-ready --attempts 30 --delay 250

# CI/CD pipeline integration
query-builder wait-ready --attempts 10 --delay 500 --timeout 30000

# Health monitoring with detailed output
query-builder ping --verbose --timeout 5000
```

### Script Execution and Migrations

```bash
# Chris's migration workflow
query-builder file ./migrations/001_create_users.sql
query-builder file ./migrations/002_create_teams.sql --dry-run

# Avery's data seeding for e-commerce
query-builder file ./seeds/products.sql
query-builder file ./seeds/categories.sql --transaction

# Buddy's data analysis scripts
query-builder file ./scripts/analytics.sql --output results.json
```

### Query Analysis and Performance

```bash
# Performance analysis for Chris's dashboard queries
query-builder explain "SELECT * FROM users JOIN teams ON users.team_id = teams.id WHERE users.active = true"

# Avery's e-commerce query optimization
query-builder explain "SELECT p.*, c.name as category_name FROM products p JOIN categories c ON p.category_id = c.id WHERE p.featured = true"

# Buddy's complex analytics query analysis
query-builder explain --analyze "SELECT u.name, COUNT(p.id) as post_count FROM users u LEFT JOIN posts p ON u.id = p.author_id GROUP BY u.id, u.name HAVING COUNT(p.id) > 5"
```

### Advanced CLI Operations

```bash
# Parameterized queries (use with caution)
query-builder unsafe "SELECT * FROM users WHERE id = $1 AND team_id = $2" --params "[1, 3]"

# Bulk operations with transaction support
query-builder file ./scripts/bulk_update.sql --transaction --batch-size 1000

# Output formatting for different use cases
query-builder sql ./models users --format json --output users.json
query-builder sql ./models products --format csv --output products.csv
query-builder sql ./models analytics --format table  # Pretty table in terminal
```

### Production and Monitoring

```bash
# Health checks for load balancers
query-builder ping --timeout 2000 --exit-code  # Returns proper exit codes

# Performance monitoring
query-builder explain --format json "SELECT COUNT(*) FROM users" | jq '.["Execution Time"]'

# Database connectivity testing
query-builder wait-ready --attempts 5 --delay 1000 --fail-fast

# Schema drift detection
query-builder introspect ./models --compare-with production_schema.json
```

### CI/CD Integration Examples

```yaml
# GitHub Actions example
- name: Wait for Database
  run: query-builder wait-ready --attempts 20 --delay 1000

- name: Run Migrations
  run: |
    query-builder file ./migrations/001_users.sql
    query-builder file ./migrations/002_teams.sql
    query-builder file ./migrations/003_posts.sql

- name: Validate Schema
  run: query-builder introspect ./models --validate-only

- name: Health Check
  run: query-builder ping --timeout 5000
```

```dockerfile
# Docker health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD query-builder ping --timeout 5000 || exit 1
```

### CLI Best Practices

- **CI Integration**: Use `wait-ready` in CI pipelines to ensure database availability before tests
- **Health Monitoring**: Implement `ping` in container health checks and load balancer probes
- **Script Safety**: Prefer `file` for SQL scripts over `unsafe` for untrusted input
- **Performance**: Use `explain` regularly to analyze query performance during development
- **Schema Management**: Use `introspect` to validate model changes and detect schema drift
- **Error Handling**: Always check exit codes in automated scripts
- **Timeouts**: Set appropriate timeouts for different environments (development vs production)
- **Output Formats**: Use JSON output for programmatic processing, table format for human reading

### Environment-Specific Configurations

```bash
# Development environment
export DB_TIMEOUT=10000
export DB_RETRY_ATTEMPTS=3

# Production environment
export DB_TIMEOUT=5000
export DB_RETRY_ATTEMPTS=1
export DB_HEALTH_CHECK_INTERVAL=30

# Testing environment
export DB_TIMEOUT=15000
export DB_RETRY_ATTEMPTS=5
export DB_WAIT_READY_ATTEMPTS=30
```

The CLI is designed to integrate seamlessly with modern development workflows, from local development to production monitoring. Choose the right commands and options for your specific use case and environment.
