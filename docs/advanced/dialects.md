# Dialects & Config

Configure behavior to match your database.

```ts
import { config } from 'bun-query-builder'

config.dialect = 'postgres'
config.sql.randomFunction = 'RANDOM()'
config.sql.sharedLockSyntax = 'FOR SHARE'
config.sql.jsonContainsMode = 'operator'
```

## Best Practices

- Align random function and lock syntax with your DB
- Choose JSON mode: operator (@>) for PG, function (JSON_CONTAINS) for MySQL

## Examples

```ts
config.dialect = 'mysql'
config.sql.randomFunction = 'RAND()'
config.sql.sharedLockSyntax = 'LOCK IN SHARE MODE'
config.sql.jsonContainsMode = 'function'
```
