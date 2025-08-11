# Query Builder

The fluent API for building type-safe SQL using Bun’s tagged template literals.

## Basics

```ts
const rows = await db
  .selectFrom('users')
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(10)
  .execute()
```

- `where({})` for equality; tuple `[col, op, val]` for explicit operators
- `orderBy`, `orderByDesc`, `latest`, `oldest`, `inRandomOrder`
- `groupBy`, `having`
- `union`, `unionAll`

## Joins

```ts
await db
  .selectFrom('users')
  .leftJoin('projects', 'users.id', '=', 'projects.user_id')
  .where(['projects.status', '=', 'active'])
  .execute()
```

Also `join`, `innerJoin`, `rightJoin`, `crossJoin`, `joinSub`, `leftJoinSub`, `crossJoinSub`.

## Raw helpers

- `whereRaw`, `groupByRaw`, `havingRaw`, `selectRaw`
- `whereColumn` and `orWhereColumn`
- `whereNested` and `orWhereNested`

## Best Practices

- Prefer composable helpers over raw strings where possible
- Use `selectAllRelations()` with `with()` to alias related columns safely
- For large result sets, prefer `paginate/simplePaginate/cursorPaginate`

## Examples

```ts
// select subset
await db.select('users', 'id', 'email').where({ active: true }).execute()

// nested conditions
await db
  .selectFrom('users')
  .whereNested(
    db.selectFrom('users').where(['age', '>=', 18]),
  )
  .execute()
```
