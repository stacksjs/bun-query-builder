# Configuration

All defaults can be overridden via `import { config } from 'bun-query-builder'`.

```ts
import { config } from 'bun-query-builder'

config.dialect = 'postgres'
config.sql.randomFunction = 'RANDOM()'
config.sql.sharedLockSyntax = 'FOR SHARE'
config.sql.jsonContainsMode = 'operator'
config.aliasing.relationColumnAliasFormat = 'table_column'
config.relations.singularizeStrategy = 'stripTrailingS'
config.transactionDefaults.retries = 2
```

### Options

```ts
export interface QueryBuilderConfig {
  verbose: boolean
  dialect: 'postgres' | 'mysql' | 'sqlite'
  timestamps: { createdAt: string, updatedAt: string, defaultOrderColumn: string }
  pagination: { defaultPerPage: number, cursorColumn: string }
  aliasing: { relationColumnAliasFormat: 'table_column' | 'table.dot.column' | 'camelCase' }
  relations: { foreignKeyFormat: 'singularParent_id' | 'parentId', singularizeStrategy?: 'stripTrailingS' | 'none' }
  transactionDefaults: { retries: number, isolation?: 'read committed' | 'repeatable read' | 'serializable', sqlStates: string[], backoff: { baseMs: number, factor: number, maxMs: number, jitter: boolean } }
  sql: { randomFunction?: 'RANDOM()' | 'RAND()', sharedLockSyntax?: 'FOR SHARE' | 'LOCK IN SHARE MODE', jsonContainsMode?: 'operator' | 'function' }
  features: { distinctOn: boolean }
  debug?: { captureText: boolean }
}
```

### Best Practices

- Align `sql.randomFunction` and `sql.sharedLockSyntax` with your dialect.
- Use `operator` JSON mode for PG (`@>`), `function` for MySQL (`JSON_CONTAINS`).
- Enable `debug.captureText` only for local debugging.

### Examples

```ts
// MySQL-style config
config.dialect = 'mysql'
config.sql.randomFunction = 'RAND()'
config.sql.sharedLockSyntax = 'LOCK IN SHARE MODE'
config.sql.jsonContainsMode = 'function'
```
