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

#### How `orWhere` groups

A chained `orWhere` groups with the term immediately before it, and that group
is ANDed into the rest of the chain:

```typescript
db.selectFrom('posts')
  .where('status', '=', 'pending')
  .where('title', 'like', term)
  .orWhere('content', 'like', term)

// WHERE status = ? AND (title like ? OR content like ?)
```

In other words `OR` binds **tighter** than `AND` here — the inverse of raw SQL,
and the reading the chain has when you say it out loud. It also matches what
`whereAny` already does.

This matters because the other reading fails silently and in the widening
direction. Under raw SQL precedence the same chain means
`(status AND title) OR content`, so every row matching `content` comes back
regardless of its status — a valid query, no warning, and a result set that
looks like data rather than an error.

To get `(a AND b) OR c`, use `whereGroup`:

```typescript
db.selectFrom('posts')
  .whereGroup(qb => qb.where('status', '=', 'pending').where('title', 'like', term))
  .orWhere('content', 'like', term)

// WHERE (status = ? AND title like ?) OR content like ?
```

Two notes:

- An object passed to `where`/`orWhere` is a **single** term, so
  `.where({ a, b }).orWhere(c)` means `(a AND b) OR c`.
- A `whereRaw`/`orWhereRaw` fragment is also a single term and is **not**
  auto-parenthesised. If your fragment contains a top-level `OR`, bracket it
  yourself.

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

For complex conditions. On `db.selectFrom(...)`, `whereRaw` takes a single SQL
fragment and no bindings. Build the fragment with the `raw` tagged template,
which inlines each interpolated value as an escaped literal:

```typescript
import { raw } from 'bun-query-builder'

const email = 'john@example.com'
const result = await db
  .selectFrom('users')
  .whereRaw(raw`LOWER(email) = ${email}`)
  .get()

const live = await db
  .selectFrom('orders')
  .whereRaw(raw('deleted_at IS NULL'))
  .get()
```

Passing values after the fragment throws, rather than sending an unbound `?`.
So does `raw('...', value)`: the plain-string form takes no values. Values are
inlined, not bound, so prefer `where()` for request input.

Model queries do bind `?` placeholders. `Model.query().whereRaw()` and
`orWhereRaw()` take the bindings either as separate arguments or as one array,
and the two spellings build the same query:

```typescript
const active = await User.query()
  .whereRaw('LOWER(email) = ?', 'john@example.com')
  .where('active', true)
  .get()

const same = await User.query()
  .whereRaw('LOWER(email) = ?', ['john@example.com'])
  .where('active', true)
  .get()
```

A lone array is always the bindings list, and each of its values is bound just
as if it had been passed separately. Two consequences on Postgres:

- Bun's driver sends an array bound to a `json`/`jsonb` parameter as JSON, so
  wrap an array you mean as one value. Unwrapped,
  `whereRaw('tags @> ?', ['bun'])` binds the string `'bun'`, not the array.
- A number or boolean compared with text needs a string or a cast, e.g.
  `whereRaw("meta->>'id' = ?", [String(id)])`.

```typescript
// tags @> '["bun"]'
const tagged = await Post.query()
  .whereRaw('tags @> ?', [['bun']])
  .get()
```

A `?` inside a string literal, quoted identifier or comment is not a
placeholder. Postgres' jsonb `?`, `?|` and `?&` operators can't be told apart
from placeholders, so use their function forms, `jsonb_exists(tags, ?)`,
`jsonb_exists_any(tags, ?)` and `jsonb_exists_all(tags, ?)`.

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

`whereGroup(callback)` is the same thing under an explicit name, and
`orWhereGroup(callback)` ORs the group onto the query instead of ANDing it:

```typescript
db.selectFrom('users')
  .where('active', '=', true)
  .orWhereGroup(qb => qb.where('role', '=', 'admin').where('verified', '=', true))

// WHERE active = ? OR (role = ? AND verified = ?)
```

A callback that adds no conditions **throws**. A group that contributed nothing
would drop out of the query and leave it matching every row the filter existed
to exclude, which is the failure this API exists to prevent.

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
