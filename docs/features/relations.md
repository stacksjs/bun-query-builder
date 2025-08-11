# Relations

Work with related data via `with`, `withCount`, `whereHas`, `orWhereHas`, and `selectAllRelations`.

Relations leverage lightweight conventions and metadata from `buildSchemaMeta` to infer join keys without decorators or elaborate relationship definitions.

## Table of Contents

- Overview
- Conventions and Configuration
- with(): Eager Loading via LEFT JOIN
- selectAllRelations(): Aliased Related Columns
- withCount(): Counting Related Records
- whereHas()/orWhereHas(): Filtering by Related Existence
- Picking Columns vs Selecting All
- Multiple Relations and Join Order
- Performance Considerations
- Advanced Patterns
- Best Practices
- Recipes
- FAQ

## Overview

- Eager load relations with `with('ModelOrTable')`
- Auto-join uses FK naming conventions and `SchemaMeta` primary keys
- `selectAllRelations()` selects joined columns using a safe aliasing strategy
- `withCount()` adds relation counts with optional scoped filters
- `whereHas()` and `orWhereHas()` filter parents by related rows

## Conventions and Configuration

The builder infers join keys using:

- `meta.modelToTable` and `meta.tableToModel` to translate inputs like `'Project'` to `'projects'`
- Parent primary key from `meta.primaryKeys[parentTable]` (defaults to `id`)
- Child foreign key convention: `${singular(parentTable)}_id`

You can adjust naming:

- `config.relations.singularizeStrategy`: `'stripTrailingS' | 'none'`
- `config.aliasing.relationColumnAliasFormat`: `'table_column' | 'table.dot.column' | 'camelCase'`

Example alias formats for `projects.name`:

- `table_column`: `projects_name`
- `table.dot.column`: `projects.name`
- `camelCase`: `projectsName`

## with(): Eager Loading via LEFT JOIN

`with(...relations: string[])` performs LEFT JOINs for each specified relation.

```ts
// eager load projects for users
const qb = db
  .selectFrom('users')
  .with('Project')
  .orderBy('users.id')

const rows = await qb.execute()
```

Under the hood, we generate:

```
LEFT JOIN projects ON projects.user_id = users.id
```

If the parent table is `users` and `meta.primaryKeys['users'] = 'id'`.

### Multiple relations

```ts
await db
  .selectFrom('users')
  .with('Project', 'Profile')
  .execute()
```

Join order follows the order you pass to `with()`.

### Custom tables vs models

`with('projects')` and `with('Project')` work identically when `meta.modelToTable.Project === 'projects'`.

## selectAllRelations(): Aliased Related Columns

Selects the parent table’s `*` and each joined table’s columns, aliased per `config.aliasing.relationColumnAliasFormat`.

```ts
const rows = await db
  .selectFrom('users')
  .with('Project')
  .selectAllRelations()
  .execute()

// rows[0].projects_name (table_column)
// or rows[0]['projects.name'] (table.dot.column)
// or rows[0].projectsName (camelCase)
```

Use this for convenience in admin dashboards or quick joins. For API responses, consider explicitly selecting only required columns.

## withCount(): Counting Related Records

Add a column containing a count of related rows.

```ts
const rows = await db
  .selectFrom('users')
  .withCount('Project', 'projects_count')
  .execute()

// rows[0].projects_count → number
```

You can pass a filter as a `where` tuple to scope the count:

```ts
await db
  .selectFrom('users')
  .withCount('Project', 'active_projects', ['status', '=', 'active'])
  .execute()
```

## whereHas()/orWhereHas(): Filtering by Related Existence

Filter parent rows based on conditions on a related table.

```ts
// users that have at least one active project
await db
  .selectFrom('users')
  .whereHas('Project', ['status', '=', 'active'])
  .execute()

// OR condition across relations
await db
  .selectFrom('users')
  .orWhereHas('Project', ['visibility', '=', 'public'])
  .execute()
```

`whereHas` translates to an `EXISTS (subquery)` filter with an implicit join through FK conventions.

## Picking Columns vs Selecting All

- Use `selectAllRelations()` for quick exploration and admin UIs
- Prefer `selectRaw` / `select(table, ...)` for explicit column lists in performance-sensitive code

Example:

```ts
await db
  .selectFrom('users')
  .with('Project')
  .select('users', 'id', 'email')
  .selectRaw(db.sql`projects.name as projects_name`)
  .execute()
```

## Multiple Relations and Join Order

When joining multiple relations, be mindful of column name collisions. Aliasing from `selectAllRelations()` avoids overwriting columns with the same name across tables.

```ts
await db
  .selectFrom('users')
  .with('Project', 'Profile')
  .selectAllRelations()
  .execute()
```

## Performance Considerations

- LEFT JOINs can multiply rows; consider `withCount` when you only need counts
- Apply filters on joined tables to reduce row set size
- Keep indexes on foreign keys (e.g., `projects.user_id`)
- Avoid joining very wide tables unless necessary; prefer targeted selections
- For massive datasets, paginate or use cursor pagination

## Advanced Patterns

### Conditional eager loading

```ts
await db
  .selectFrom('users')
  .when(process.env.INCLUDE_PROJECTS, qb => qb.with('Project'))
  .execute()
```

### Scoped relation selects

```ts
await db
  .selectFrom('users')
  .with('Project')
  .select('users', 'id', 'email')
  .selectRaw(db.sql`projects.id as projects_id`)
  .selectRaw(db.sql`projects.name as projects_name`)
  .execute()
```

### Aggregating related data

```ts
await db
  .selectFrom('users')
  .with('Project')
  .groupBy('users.id')
  .selectRaw(db.sql`COUNT(projects.id) as projects_count`)
  .execute()
```

## Best Practices

- Keep FK naming consistent across tables
- Configure aliasing to a format that fits your consuming layer
- Use `withCount` over `selectAllRelations` for count-only needs
- Combine `whereHas` with selective joins for precise filtering
- Index foreign keys and join columns

## Recipes

### Users with only active projects

```ts
await db
  .selectFrom('users')
  .with('Project')
  .whereHas('Project', ['status', '=', 'active'])
  .groupBy('users.id')
  .havingRaw(db.sql`COUNT(CASE WHEN projects.status = 'inactive' THEN 1 END) = 0`)
  .execute()
```

### Top users by project count

```ts
await db
  .selectFrom('users')
  .with('Project')
  .groupBy('users.id')
  .selectRaw(db.sql`COUNT(projects.id) as projects_count`)
  .orderByDesc('projects_count' as any)
  .limit(10)
  .execute()
```

### Users with at least N projects

```ts
const N = 3
await db
  .selectFrom('users')
  .with('Project')
  .groupBy('users.id')
  .havingRaw(db.sql`COUNT(projects.id) >= ${db.sql(String(N))}`)
  .execute()
```

## FAQ

### How are join keys determined?

We use `SchemaMeta`: the parent PK and child FK by convention `${singular(parent)}_id`. You can adjust singularization in config.

### Can I join nested relations?

Call `with` multiple times; joins are flat in SQL. For nested constraints, use `whereHas` with subqueries.

### What if my FK names are different?

Prefer `join` with explicit keys, or adapt your models to include the conventional FK naming.

### How do I avoid column collisions?

Use `selectAllRelations()` (it aliases columns) or `selectRaw`/`select` with explicit aliases.

---

## Quick Reference

- `with(...relations)` → LEFT JOIN per relation
- `selectAllRelations()` → selects parent `*` and aliased related columns
- `withCount(relation, alias?, where?)` → adds count column
- `whereHas(relation, where?)` / `orWhereHas(...)` → existence filters

---

## Advanced Examples and Variants

### Explicit join keys when conventions don’t fit

If your schema deviates from the convention, use explicit joins:

```ts
await db
  .selectFrom('users')
  .join('projects', 'projects.ownerId' as any, '=', 'users.uid' as any)
  .select('users', 'uid as id', 'email')
  .selectRaw(db.sql`projects.title as projects_title`)
  .execute()
```

### Filtering joined tables without selecting them

```ts
await db
  .selectFrom('users')
  .with('Project')
  .where(['projects.status', '=', 'active'])
  .select('users', 'id', 'email')
  .execute()
```

### Multiple counts with aliases

```ts
await db
  .selectFrom('users')
  .withCount('Project', 'projects_total')
  .withCount('Project', 'projects_active', ['status', '=', 'active'])
  .execute()
```

### whereHas with nested conditions

```ts
await db
  .selectFrom('users')
  .whereHas('Project', ['status', '=', 'active'])
  .orWhereHas('Project', ['visibility', '=', 'public'])
  .execute()
```

### Selecting a subset of related columns with consistent aliases

```ts
await db
  .selectFrom('users')
  .with('Project')
  .select('users', 'id', 'email')
  .selectRaw(db.sql`projects.id as projects_id`)
  .selectRaw(db.sql`projects.status as projects_status`)
  .execute()
```

### Grouped aggregates across relations

```ts
await db
  .selectFrom('users')
  .with('Project')
  .groupBy('users.id')
  .selectRaw(db.sql`COUNT(projects.id) as projects_count`)
  .selectRaw(db.sql`SUM(CASE WHEN projects.status = 'active' THEN 1 ELSE 0 END) as active_count`)
  .execute()
```

### Conditional eager loading via when

```ts
await db
  .selectFrom('users')
  .when(process.env.INCLUDE_PROJECTS === '1', qb => qb.with('Project'))
  .execute()
```

### Relation-aware ordering

```ts
await db
  .selectFrom('users')
  .with('Project')
  .orderBy('users.id')
  .orderBy('projects.created_at' as any, 'desc')
  .execute()
```

### Paginating parents while filtering on relations

```ts
const page = await db
  .selectFrom('users')
  .with('Project')
  .where(['projects.status', '=', 'active'])
  .paginate(25, 1)
```

### Cursor pagination with relations

```ts
let cursor: string | number | undefined
do {
  const { data, meta } = await db
    .selectFrom('users')
    .with('Project')
    .cursorPaginate(50, cursor, 'users.id', 'asc')
  // ...process data
  cursor = meta.nextCursor ?? undefined
} while (cursor)
```

### Combining withCount and whereHas for precise slices

```ts
await db
  .selectFrom('users')
  .withCount('Project', 'active_count', ['status', '=', 'active'])
  .whereHas('Project', ['status', '=', 'active'])
  .orderBy('active_count' as any, 'desc')
  .execute()
```

### Dialect notes

- Prefer `distinct on` only when using Postgres and guard via config
- MySQL users: emulate `distinct on` with window functions or grouping when needed

### Troubleshooting

- Missing columns after join: ensure aliases or `selectAllRelations()`
- Duplicate rows: add appropriate `groupBy` or select de-duplicating keys
- Slow queries: verify indexes on foreign keys and filter columns
