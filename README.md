<p align="center"><img src=".github/art/cover.jpg" alt="Social Card of this repo"></p>

[![npm version][npm-version-src]][npm-version-href]
[![GitHub Actions][github-actions-src]][github-actions-href]
[![Commitizen friendly](https://img.shields.io/badge/commitizen-friendly-brightgreen.svg)](http://commitizen.github.io/cz-cli/)
<!-- [![npm downloads][npm-downloads-src]][npm-downloads-href] -->
<!-- [![Codecov][codecov-src]][codecov-href] -->

# bun-query-builder

Fully-typed, model-driven Query Builder for Bun’s native `sql`.

Define your data model once and get a type-safe query experience _(a la Kysely/Laravel)_, powered by Bun’s tagged templates for safety and performance.

## Features

- **Typed from Models**: Infer tables/columns/PKs from your model files; `selectFrom('users')` and `where({ active: true })` are typed.
- **Fluent Builder**: `select/insert/update/delete`, `where/andWhere/orWhere`, `join/leftJoin/rightJoin/crossJoin`, `groupBy/having`, `union/unionAll`.
- **Relations**: `with(...)`, `withCount(...)`, `whereHas(...)`, `selectAllRelations()` with configurable aliasing.
- **Utilities**: `distinct/distinctOn`, `orderByDesc/latest/oldest/inRandomOrder`, `whereColumn/whereRaw/groupByRaw/havingRaw`, JSON/date helpers.
- **Pagination**: `paginate`, `simplePaginate`, `cursorPaginate`, plus `chunk/chunkById/eachById`.
- **Transactions**: `transaction` with retries/backoff/isolation/onRetry/afterCommit; `savepoint`; distributed tx helpers.
- **Configurable**: Dialect hints, timestamps, alias strategies, relation FK formats, JSON mode, random function, shared lock syntax.
- **Bun API passthroughs**: `unsafe`, `file`, `simple`, pool `reserve/release`, `close`, `ping/waitForReady`.
- **CLI**: Introspection, query printing, connectivity checks, file/unsafe execution, explain.

> Note: LISTEN/NOTIFY and COPY helpers are scaffolded and will be wired as Bun exposes native APIs.

## Get Started

### Installation

```bash
bun add bun-query-builder
```

### Usage

```ts
import { buildDatabaseSchema, buildSchemaMeta, createQueryBuilder } from 'bun-query-builder'

// Load or define your model files (see docs for model shape)
const models = {
  User: { name: 'User', table: 'users', primaryKey: 'id', attributes: { id: { validation: { rule: {} } }, name: { validation: { rule: {} } }, active: { validation: { rule: {} } } } },
} as const

const schema = buildDatabaseSchema(models as any)
const meta = buildSchemaMeta(models as any)
const db = createQueryBuilder<typeof schema>({ schema, meta })

// Fully-typed query
const q = db
  .selectFrom('users')
  .where({ active: true })
  .orderBy('created_at', 'desc')
  .limit(10)

const rows = await q.execute()
```

## Migrations

Generate and execute migrations from your models:

```ts
import { generateMigration, executeMigration } from 'bun-query-builder'

// Generate migration from models directory
const migration = await generateMigration('./models', { 
  dialect: 'postgres', 
  apply: true, 
  full: true 
})

// Execute the migration
await executeMigration(migration)
```

### CLI

```bash
# Print inferred schema from model dir
query-builder introspect ./app/Models --verbose

# Print a sample SQL (text) for a table
query-builder sql ./app/Models users --limit 5

# Connectivity:
query-builder ping
query-builder wait-ready --attempts 30 --delay 250

# Execute a file or unsafe string (be careful!)
query-builder file ./migrations/seed.sql
query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[1]"

# Explain a query
query-builder explain "SELECT * FROM users WHERE active = true"
```

## Testing

```bash
bun test
```

## Changelog

Please see our [releases](https://github.com/stackjs/bun-query-builder/releases) page for more information on what has changed recently.

## Contributing

Please see [CONTRIBUTING](.github/CONTRIBUTING.md) for details.

## Community

For help, discussion about best practices, or any other conversation that would benefit from being searchable:

[Discussions on GitHub](https://github.com/stacksjs/ts-starter/discussions)

For casual chit-chat with others using this package:

[Join the Stacks Discord Server](https://discord.gg/stacksjs)

## Postcardware

“Software that is free, but hopes for a postcard.” We love receiving postcards from around the world showing where Stacks is being used! We showcase them on our website too.

Our address: Stacks.js, 12665 Village Ln #2306, Playa Vista, CA 90094, United States 🌎

## Sponsors

We would like to extend our thanks to the following sponsors for funding Stacks development. If you are interested in becoming a sponsor, please reach out to us.

- [JetBrains](https://www.jetbrains.com/)
- [The Solana Foundation](https://solana.com/)

## License

The MIT License (MIT). Please see [LICENSE](LICENSE.md) for more information.

Made with 💙

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/bun-query-builder?style=flat-square
[npm-version-href]: https://npmjs.com/package/bun-query-builder
[github-actions-src]: https://img.shields.io/github/actions/workflow/status/stacksjs/ts-starter/ci.yml?style=flat-square&branch=main
[github-actions-href]: https://github.com/stacksjs/ts-starter/actions?query=workflow%3Aci

<!-- [codecov-src]: https://img.shields.io/codecov/c/gh/stacksjs/ts-starter/main?style=flat-square
[codecov-href]: https://codecov.io/gh/stacksjs/ts-starter -->
