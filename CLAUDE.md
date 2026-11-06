# Claude Code Guidelines

## About

A fully-typed, model-driven SQL query builder for Bun's native database drivers (SQLite via `bun:sqlite`, Postgres via `Bun.sql`). It provides a fluent Kysely/Laravel-style API with type-safe table/column inference from model definitions, relations with eager loading, query scopes, model hooks, built-in LRU caching, soft deletes, transactions with retries, migrations, seeders, and a CLI for introspection, seeding, and schema management.

## Linting

- Use **pickier** for linting — never use eslint directly
- Run `bunx --bun pickier .` to lint, `bunx --bun pickier . --fix` to auto-fix
- When fixing unused variable warnings, prefer `// eslint-disable-next-line` comments over prefixing with `_`

## Frontend

- Use **stx** for templating — never write vanilla JS (`var`, `document.*`, `window.*`) in stx templates
- Use **crosswind** as the default CSS framework which enables standard Tailwind-like utility classes
- stx `<script>` tags should only contain stx-compatible code (signals, composables, directives)

## Dependencies

- **buddy-bot** handles dependency updates — not renovatebot
- **better-dx** provides shared dev tooling as peer dependencies — do not install its peers (e.g., `typescript`, `pickier`, `bun-plugin-dtsx`) separately if `better-dx` is already in `package.json`
- If `better-dx` is in `package.json`, ensure `bunfig.toml` includes `linker = "hoisted"`

## Worktrees

- **Never create a git worktree.** One project is always one agent here, so there is nothing to isolate from. Do not run `git worktree add`, do not pass `isolation: "worktree"` to a subagent, and do not offer background-task chips (each one opens a fresh worktree)
- Do follow-up work in the current checkout. A branch is the right unit when isolation is wanted
- Stale worktrees under `/private/tmp` outlive their session and clutter the filesystem; `git worktree prune` clears a dead record

## Commits

- Use conventional commit messages (e.g., `fix:`, `feat:`, `chore:`)
