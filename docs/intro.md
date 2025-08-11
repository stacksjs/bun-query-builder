<p align="center"><img src="https://github.com/stacksjs/bun-query-builder/blob/main/.github/art/cover.jpg?raw=true" alt="Social Card of this repo"></p>

# bun-query-builder

Typed, model-driven Query Builder for Bun’s native `sql`.

Define your model once and write type-safe queries powered by Bun’s tagged templates for safety and performance.

## Why bun-query-builder?

- Strong types from your model files
- Laravel-like fluent API; Kysely-like DX
- Bun-native performance, safety, and features

## Quick Example

```ts
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from 'bun-query-builder'

const models = {
  User: {
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } }, active: { validation: { rule: {} } } },
  },
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)
const db = createQueryBuilder<typeof schema>({ schema, meta })

const rows = await db.selectFrom('users').where({ active: true }).limit(10).execute()
```

Next, see Install and Usage to get started.

<!-- Badges -->

<!-- [codecov-src]: https://img.shields.io/codecov/c/gh/stacksjs/rpx/main?style=flat-square
[codecov-href]: https://codecov.io/gh/stacksjs/rpx -->
