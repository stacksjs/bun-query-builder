# Relations

Work with related data via `with`, `withCount`, `whereHas`, `orWhereHas`, and `selectAllRelations`.

Relations leverage lightweight conventions and metadata from `buildSchemaMeta` to infer join keys without decorators or elaborate relationship definitions.

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

`with(...relations: string[])` performs LEFT JOINs for each specified relation, allowing you to fetch related data in a single query.

```ts
// Eager load projects for users
const usersWithProjects = await db
  .selectFrom('users')
  .with('Project')
  .where({ 'users.active': true })
  .orderBy('users.id')
  .execute()

// Load multiple relations at once
const usersWithProjectsAndProfiles = await db
  .selectFrom('users')
  .with('Project', 'Profile')
  .where({ 'users.role': 'member' })
  .execute()

// Chris's data with all related information
const chrisFullProfile = await db
  .selectFrom('users')
  .with('Project', 'Profile', 'Team')
  .where({ 'users.name': 'Chris' })
  .first()
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
### Nested paths and many-to-many

You can chain nested relations using dot notation. `belongsToMany` joins through a pivot inferred from naming (e.g., `users` ↔ `tags` → `tags_users`).

```ts
await db
  .selectFrom('users')
  .with('Project', 'Project.tags')
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

Add a column containing a count of related rows without loading the actual related data.

```ts
// Get users with their project counts
const usersWithCounts = await db
  .selectFrom('users')
  .select('users', 'id', 'name', 'email')
  .withCount('Project', 'projects_count')
  .execute()

// Access the count: usersWithCounts[0].projects_count → number

// Chris's project statistics
const chrisStats = await db
  .selectFrom('users')
  .where({ name: 'Chris' })
  .withCount('Project', 'total_projects')
  .withCount('Project', 'active_projects', ['status', '=', 'active'])
  .withCount('Project', 'completed_projects', ['status', '=', 'completed'])
  .first()
```

You can pass filters to scope the count to specific conditions:

```ts
// Team leads with their active project counts
const teamLeads = await db
  .selectFrom('users')
  .where({ role: 'team_lead' })
  .withCount('Project', 'active_projects', ['status', '=', 'active'])
  .withCount('Project', 'overdue_projects', ['due_date', '<', new Date()])
  .orderBy('active_projects', 'desc')
  .execute()

// Avery's content creation metrics
const averyMetrics = await db
  .selectFrom('users')
  .where({ name: 'Avery' })
  .withCount('Post', 'published_posts', ['published', '=', true])
  .withCount('Post', 'draft_posts', ['published', '=', false])
  .withCount('Comment', 'total_comments')
  .first()
```

## whereHas()/orWhereHas(): Filtering by Related Existence

Filter parent rows based on conditions on a related table without actually joining the related data.

```ts
// Find users that have at least one active project
const activeProjectOwners = await db
  .selectFrom('users')
  .whereHas('Project', ['status', '=', 'active'])
  .execute()

// Find users with either public projects OR published posts
const contentCreators = await db
  .selectFrom('users')
  .whereHas('Project', ['visibility', '=', 'public'])
  .orWhereHas('Post', ['published', '=', true])
  .execute()

// Chris's colleagues who have ongoing work
const busyColleagues = await db
  .selectFrom('users')
  .where({ team: 'Chris\s Team' })
  .whereHas('Project', ['status', 'in', ['active', 'in_progress']])
  .whereHas('Task', ['completed', '=', false])
  .execute()

// Advanced filtering with multiple conditions
const qualifiedContributors = await db
  .selectFrom('users')
  .whereHas('Project', qb => qb
    .where(['status', '=', 'completed'])
    .andWhere(['created_at', '>', new Date('2024-01-01')]))
  .whereHas('Review', ['rating', '>=', 4])
  .execute()
```

**How it works**: `whereHas` translates to an `EXISTS (subquery)` filter with an implicit join through FK conventions, allowing efficient filtering without loading related data.

### Complex whereHas Examples

```ts
// Buddy's project managers (users who manage projects Buddy works on)
const buddyManagers = await db
  .selectFrom('users')
  .where({ role: 'manager' })
  .whereHas('Project', qb => qb
    .join('project_members', 'project_members.project_id', '=', 'projects.id')
    .join('users as members', 'members.id', '=', 'project_members.user_id')
    .where(['members.name', '=', 'Buddy']))
  .execute()

// Avery's team members who have recent activity
const averyActiveTeam = await db
  .selectFrom('users')
  .whereHas('Team', ['lead_id', '=', (await db.selectFrom('users').where({ name: 'Avery' }).first())?.id])
  .whereHas('Activity', ['created_at', '>', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)])
  .execute()
```

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

### Relationship Design

- **Consistent FK Naming**: Follow a consistent foreign key naming convention (e.g., `user_id`, `project_id`)
- **Index Foreign Keys**: Always create indexes on foreign key columns for optimal join performance
- **Model Definitions**: Define relationships in your model files to leverage automatic join key inference
- **Naming Conventions**: Configure `config.relations.foreignKeyFormat` to match your database schema

```ts
// Good: Consistent FK naming
const userProjects = await db
  .selectFrom('users')
  .with('Project') // Auto-infers projects.user_id = users.id
  .execute()

// Configure for your schema
config.relations = {
  foreignKeyFormat: 'singularParent_id', // user_id, project_id
  singularizeStrategy: 'stripTrailingS' // users → user
}
```

### Performance Optimization

- **Selective Loading**: Use `withCount()` when you only need counts, not actual related data
- **Explicit Column Selection**: Prefer explicit column selection over `selectAllRelations()` in production
- **Batch Loading**: Load relations for multiple records in a single query rather than N+1 queries
- **Index Strategy**: Ensure foreign keys and filtered columns have appropriate database indexes

```ts
// Good: Efficient count-only query
const userStats = await db
  .selectFrom('users')
  .select('users', 'id', 'name')
  .withCount('Project', 'project_count')
  .withCount('Post', 'post_count')
  .execute()

// Good: Explicit column selection for performance
const teamData = await db
  .selectFrom('users')
  .with('Project')
  .select('users', 'id', 'name', 'role')
  .selectRaw(db.sql`projects.id as project_id, projects.name as project_name`)
  .where({ 'users.team': 'Engineering' })
  .execute()
```

### Query Strategy

- **whereHas vs with**: Use `whereHas()` for filtering, `with()` for data loading
- **Aliasing Configuration**: Set `config.aliasing.relationColumnAliasFormat` to match your frontend needs
- **Pagination with Relations**: Be mindful of result multiplication when paginating joined data
- **Transaction Boundaries**: Use transactions when creating related records that must be consistent

```ts
// Good: Use whereHas for filtering without loading data
const activeUsers = await db
  .selectFrom('users')
  .whereHas('Project', ['status', '=', 'active'])
  .select('users', 'id', 'name', 'email')
  .execute()

// Good: Use with for loading related data
const usersWithProjects = await db
  .selectFrom('users')
  .with('Project')
  .where({ 'users.active': true })
  .limit(10)
  .execute()
```

### Data Integrity

- **Cascade Considerations**: Plan cascade behavior for deletions and updates
- **Soft Deletes**: Handle soft deletes consistently across related tables
- **Validation**: Validate foreign key references before creating relationships
- **Audit Trails**: Track relationship changes for important business entities

```ts
// Good: Create related records in a transaction
async function createUserWithProfile(userData: any, profileData: any) {
  return await db.transaction(async (tx) => {
    const user = await tx.create('users', userData)
    const profile = await tx.create('profiles', {
      ...profileData,
      user_id: user.id
    })
    return { user, profile }
  })
}

// Good: Handle soft deletes in relations
const activeUsersWithActiveProjects = await db
  .selectFrom('users')
  .with('Project')
  .whereNull('users.deleted_at')
  .where({ 'projects.deleted_at': null, 'users.active': true })
  .execute()
```

### Aliasing and Naming

- **Frontend Integration**: Choose aliasing format that matches your API response structure
- **Consistency**: Use the same aliasing strategy across your application
- **Documentation**: Document your aliasing conventions for team consistency
- **Type Safety**: Leverage TypeScript interfaces that match your aliasing format

```ts
// Configure aliasing for your needs
config.aliasing = {
  relationColumnAliasFormat: 'camelCase' // projectName, userId
  // or 'table_column' for project_name, user_id
  // or 'table.dot.column' for project.name, user.id
}

// Access aliased columns based on your config
const results = await db
  .selectFrom('users')
  .with('Project')
  .selectAllRelations()
  .execute()

// With camelCase: results[0].projectName
// With table_column: results[0].project_name
// With table.dot.column: results[0]['project.name']
```

### Common Pitfalls to Avoid

- **N+1 Queries**: Always prefer eager loading relations over separate queries per record
- **Missing Indexes**: Don't forget to index foreign key columns
- **Result Multiplication**: Be aware that LEFT JOINs can multiply result rows
- **Memory Usage**: Avoid loading large relations for many records without pagination
- **Type Mismatches**: Ensure foreign key types match between related tables

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
