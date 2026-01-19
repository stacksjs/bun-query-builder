# Where Clauses

Learn how to filter data with various where clause conditions.

## Basic Where Clauses

### Simple Equality

```typescript
// Object syntax
const users = await db
  .selectFrom('users')
  .where({ active: true })
  .get()

// Column, operator, value syntax
const adults = await db
  .selectFrom('users')
  .where('age', '>=', 18)
  .get()

// Multiple conditions (AND)
const result = await db
  .selectFrom('users')
  .where({ active: true, verified: true })
  .get()
```

### Comparison Operators

```typescript
// Equals
.where('status', '=', 'active')

// Not equals
.where('status', '!=', 'deleted')
.where('status', '<>', 'deleted')

// Greater than / Less than
.where('age', '>', 18)
.where('age', '<', 65)
.where('age', '>=', 21)
.where('age', '<=', 30)

// LIKE
.where('name', 'LIKE', '%john%')
.where('email', 'LIKE', '%@gmail.com')

// IS NULL / IS NOT NULL
.where('deleted_at', 'IS', null)
.where('email_verified_at', 'IS NOT', null)
```

## Chaining Where Clauses

### AND Conditions

```typescript
const users = await db
  .selectFrom('users')
  .where('active', '=', true)
  .andWhere('age', '>=', 18)
  .andWhere('country', '=', 'USA')
  .get()
```

### OR Conditions

```typescript
const users = await db
  .selectFrom('users')
  .where('role', '=', 'admin')
  .orWhere('role', '=', 'moderator')
  .get()
```

## Special Where Methods

### whereIn / whereNotIn

```typescript
// Check if value is in array
const selectedUsers = await db
  .selectFrom('users')
  .whereIn('id', [1, 2, 3, 4, 5])
  .get()

// Check if value is not in array
const otherUsers = await db
  .selectFrom('users')
  .whereNotIn('status', ['banned', 'suspended'])
  .get()
```

### whereBetween / whereNotBetween

```typescript
// Value between range
const middleAged = await db
  .selectFrom('users')
  .whereBetween('age', 30, 50)
  .get()

// Value outside range
const extremes = await db
  .selectFrom('users')
  .whereNotBetween('age', 30, 50)
  .get()
```

### whereNull / whereNotNull

```typescript
// Check for NULL
const unverified = await db
  .selectFrom('users')
  .whereNull('email_verified_at')
  .get()

// Check for NOT NULL
const verified = await db
  .selectFrom('users')
  .whereNotNull('email_verified_at')
  .get()
```

### whereColumn

Compare two columns:

```typescript
const result = await db
  .selectFrom('posts')
  .whereColumn('created_at', '=', 'updated_at')
  .get()

const modified = await db
  .selectFrom('posts')
  .whereColumn('updated_at', '>', 'created_at')
  .get()
```

### whereRaw

For complex conditions:

```typescript
const result = await db
  .selectFrom('users')
  .whereRaw('LOWER(email) = ?', ['john@example.com'])
  .get()

const recent = await db
  .selectFrom('orders')
  .whereRaw('created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)')
  .get()
```

## Date Conditions

```typescript
// Using date helpers
const today = await db
  .selectFrom('orders')
  .whereDate('created_at', '=', '2024-01-15')
  .get()

const thisMonth = await db
  .selectFrom('orders')
  .whereMonth('created_at', '=', 1)
  .get()

const thisYear = await db
  .selectFrom('orders')
  .whereYear('created_at', '=', 2024)
  .get()
```

## JSON Conditions

```typescript
// Query JSON fields
const users = await db
  .selectFrom('users')
  .whereJson('preferences->theme', '=', 'dark')
  .get()

const admins = await db
  .selectFrom('users')
  .whereJsonContains('roles', 'admin')
  .get()
```

## Grouped Conditions

Use callbacks for complex grouping:

```typescript
const users = await db
  .selectFrom('users')
  .where('active', '=', true)
  .where((qb) => {
    qb.where('role', '=', 'admin')
      .orWhere('role', '=', 'moderator')
  })
  .get()

// Generates: WHERE active = true AND (role = 'admin' OR role = 'moderator')
```

## Existence Checks

```typescript
// Check if any records exist
const hasUsers = await db
  .selectFrom('users')
  .where({ active: true })
  .exists()

// Check if no records exist
const isEmpty = await db
  .selectFrom('users')
  .where({ active: true })
  .doesntExist()
```

## Subqueries

```typescript
// Where in subquery
const activeUserPosts = await db
  .selectFrom('posts')
  .whereIn('user_id', (subquery) => {
    subquery
      .selectFrom('users')
      .select(['id'])
      .where({ active: true })
  })
  .get()
```

## Full-Text Search

```typescript
// Match against (MySQL)
const results = await db
  .selectFrom('articles')
  .whereFullText(['title', 'body'], 'search terms')
  .get()
```

## Examples

### E-commerce Product Filter

```typescript
const products = await db
  .selectFrom('products')
  .where('category', '=', 'electronics')
  .where('price', '>=', 100)
  .where('price', '<=', 500)
  .whereNotNull('stock')
  .where('stock', '>', 0)
  .whereIn('brand', ['Apple', 'Samsung', 'Sony'])
  .orderBy('price', 'asc')
  .get()
```

### User Search

```typescript
function searchUsers(term: string, filters: UserFilters) {
  let query = db.selectFrom('users')

  if (term) {
    query = query.where((qb) => {
      qb.where('name', 'LIKE', `%${term}%`)
        .orWhere('email', 'LIKE', `%${term}%`)
    })
  }

  if (filters.active !== undefined) {
    query = query.where({ active: filters.active })
  }

  if (filters.roles?.length) {
    query = query.whereIn('role', filters.roles)
  }

  if (filters.createdAfter) {
    query = query.where('created_at', '>=', filters.createdAfter)
  }

  return query.get()
}
```

## Next Steps

- Learn about [joins](./join.md)
- Explore [insert, update, delete](./insert-update-delete.md)
- Master [transactions](./transactions.md)
