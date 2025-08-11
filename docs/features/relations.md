# Relations

Work with related data via `with`, `withCount`, `whereHas`, and `selectAllRelations`.

## Basics

```ts
const rows = await db
  .selectFrom('users')
  .with('Project')
  .selectAllRelations()
  .limit(10)
  .execute()
```

- with('ModelOrTable') performs a LEFT JOIN using FK conventions
- selectAllRelations() selects aliased related columns (configurable)
- withCount(relation, alias?, where?) counts with optional filters

## Best Practices

- Keep FK naming consistent; configure singularization and alias formats
- Avoid selecting all relation columns for very large related tables; prefer selectRaw or pick columns

## Examples

```ts
await db
  .selectFrom('users')
  .with('Project')
  .withCount('Project', 'projects_count', ['status', '=', 'active'])
  .whereHas('Project', ['status', '=', 'active'])
  .execute()
```
