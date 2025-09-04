import type { CliOption, FileOptions, MigrateOptions, SqlOptions, UnsafeOptions } from '../src/types'
import { CAC } from 'cac'
import { version } from '../package.json'
import { explain, file, introspect, ping, sql, unsafe, waitReady } from '../src/actions'
import { executeMigration, generateMigration, resetDatabase } from '../src/actions/migrate'

const cli = new CAC('query-builder')

cli
  .command('introspect <dir>', 'Load models and print inferred schema')
  .option('--verbose', 'Enable verbose logging')
  .example('query-builder introspect ./app/Models --verbose')
  .action(async (dir: string, _options?: CliOption) => {
    await introspect(dir, _options)
  })

cli
  .command('sql <dir> <table>', 'Build a sample query for a table')
  .option('--limit <n>', 'Limit rows', { default: 10 })
  .example('query-builder sql ./app/Models users --limit 5')
  .action(async (dir: string, table: string, opts: SqlOptions) => {
    await sql(dir, table, opts)
  })

cli
  .command('ping', 'Test database connectivity (uses environment variables)')
  .example('query-builder ping')
  .action(async () => {
    await ping()
  })

cli
  .command('wait-ready', 'Wait for database to become ready')
  .option('--attempts <n>', 'Number of attempts', { default: 10 })
  .option('--delay <ms>', 'Delay between attempts', { default: 100 })
  .example('query-builder wait-ready --attempts 30 --delay 250')
  .action(async (opts: any) => {
    try {
      await waitReady(opts)
    }
    catch {
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('unsafe <sql>', 'Execute an unsafe SQL string (one statement with params)')
  .option('--params <json>', 'JSON array of parameters')
  .example('query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[1]"')
  .action(async (sql: string, opts: UnsafeOptions) => {
    await unsafe(sql, opts)
  })

cli
  .command('file <path>', 'Execute a SQL file (supports $1, $2 params)')
  .option('--params <json>', 'JSON array of parameters')
  .example('query-builder file ./migrations/seed.sql')
  .example('query-builder file ./reports/top.sql --params "[30]"')
  .action(async (path: string, opts: FileOptions) => {
    await file(path, opts)
  })

cli
  .command('migrate <dir>', 'Generate SQL migrations from models')
  .option('--dialect <d>', 'Dialect (postgres|mysql|sqlite)', { default: 'postgres' })
  .option('--state <path>', 'Path to migration state file (defaults to <dir>/.qb-migrations.<dialect>.json)')
  .option('--apply', 'Execute the generated SQL against the database')
  .option('--full', 'Force full migration SQL instead of incremental diff')
  .example('query-builder migrate ./app/Models --dialect postgres')
  .action(async (dir: string, opts: MigrateOptions) => {
    try {
      await generateMigration(dir, {
        dialect: opts.dialect,
        state: opts.state,
        apply: opts.apply,
        full: opts.full,
      })

      await executeMigration()
    }
    catch (err) {
      console.error('-- Migration failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('explain <sql>', 'Explain a query')
  .example('query-builder explain "SELECT * FROM users WHERE active = true"')
  .action(async (sql: string) => {
    await explain(sql)
  })

cli
  .command('migrate:fresh <dir>', 'Reset database and run all migrations')
  .option('--dialect <d>', 'Dialect (postgres|mysql|sqlite)', { default: 'postgres' })
  .option('--state <path>', 'Path to migration state file (defaults to <dir>/.qb-migrations.<dialect>.json)')
  .option('--full', 'Force full migration SQL instead of incremental diff')
  .example('query-builder migrate:fresh ./app/Models --dialect postgres')
  .action(async (dir: string, opts: MigrateOptions) => {
    try {
      console.log('-- Resetting database...')
      await resetDatabase(dir, {
        dialect: opts.dialect,
        state: opts.state,
      })

      console.log('-- Generating fresh migrations...')
      await generateMigration(dir, {
        dialect: opts.dialect,
        state: opts.state,
        full: opts.full,
      })

      console.log('-- Executing migrations...')
      await executeMigration()
    }
    catch (err) {
      console.error('-- Migrate fresh failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('reset <dir>', 'Drop all tables and reset database')
  .option('--dialect <d>', 'Dialect (postgres|mysql|sqlite)', { default: 'postgres' })
  .option('--state <path>', 'Path to migration state file (defaults to <dir>/.qb-migrations.<dialect>.json)')
  .example('query-builder reset ./app/Models --dialect postgres')
  .action(async (dir: string, opts: MigrateOptions) => {
    try {
      await resetDatabase(dir, {
        dialect: opts.dialect,
        state: opts.state,
      })
    }
    catch (err) {
      console.error('-- Reset failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli.command('version', 'Show the version of the CLI').action(() => {
  console.log(version)
})

cli.version(version)
cli.help()
cli.parse()
