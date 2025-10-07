import type { CliOption, FileOptions, MigrateOptions, SqlOptions, UnsafeOptions } from '../src/types'
import { CAC } from 'cac'
import { version } from '../package.json'
import { explain, file, introspect, ping, sql, unsafe, waitReady } from '../src/actions'
import { runBenchmark } from '../src/actions/benchmark'
import { cacheClear, cacheConfig, cacheStats } from '../src/actions/cache'
import { startConsole, tinker } from '../src/actions/console'
import { dumpDatabase, exportData, importData } from '../src/actions/data'
import { dbInfo, dbStats } from '../src/actions/db-info'
import { dbOptimize } from '../src/actions/db-optimize'
import { dbWipe } from '../src/actions/db-wipe'
import { inspectTable, tableInfo } from '../src/actions/inspect'
import { makeModel } from '../src/actions/make-model'
import { executeMigration, generateMigration, resetDatabase } from '../src/actions/migrate'
import { migrateGenerate } from '../src/actions/migrate-generate'
import { migrateRollback } from '../src/actions/migrate-rollback'
import { migrateList, migrateStatus } from '../src/actions/migrate-status'
import { modelShow } from '../src/actions/model-show'
import { queryExplainAll } from '../src/actions/query-explain-all'
import { relationDiagram } from '../src/actions/relation-diagram'
import { freshDatabase, makeSeeder, runSeeder, runSeeders } from '../src/actions/seed'
import { checkSchema, validateSchema } from '../src/actions/validate'

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
  .command('query:explain-all <path>', 'Run EXPLAIN on all SQL files in a directory')
  .option('--verbose', 'Enable verbose output')
  .option('--json', 'Output as JSON')
  .example('query-builder query:explain-all ./queries')
  .example('query-builder query:explain-all ./queries/users.sql')
  .action(async (path: string, opts: any) => {
    try {
      await queryExplainAll(path, {
        verbose: opts.verbose,
        json: opts.json,
      })
    }
    catch (err) {
      console.error('-- Explain all failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('relation:diagram', 'Generate relationship diagram from models')
  .option('--dir <path>', 'Models directory (defaults to app/Models)')
  .option('--format <fmt>', 'Output format (mermaid|dot)', { default: 'mermaid' })
  .option('--output <path>', 'Output file path')
  .option('--verbose', 'Enable verbose output')
  .example('query-builder relation:diagram')
  .example('query-builder relation:diagram --format dot --output schema.dot')
  .example('query-builder relation:diagram --output schema.mmd')
  .action(async (opts: any) => {
    try {
      await relationDiagram({
        dir: opts.dir,
        format: opts.format,
        output: opts.output,
        verbose: opts.verbose,
      })
    }
    catch (err) {
      console.error('-- Diagram generation failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
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

cli
  .command('seed', 'Run database seeders')
  .option('--dir <path>', 'Path to seeders directory (defaults to database/seeders)')
  .option('--class <name>', 'Run a specific seeder class')
  .option('--verbose', 'Enable verbose logging')
  .example('query-builder seed')
  .example('query-builder seed --class UserSeeder')
  .example('query-builder seed --dir ./database/seeders')
  .action(async (opts: any) => {
    try {
      if (opts.class) {
        await runSeeder(opts.class, { verbose: opts.verbose })
      }
      else {
        await runSeeders({ seedersDir: opts.dir, verbose: opts.verbose })
      }
    }
    catch (err) {
      console.error('-- Seeding failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('db:seed', 'Run database seeders (alias for seed)')
  .option('--dir <path>', 'Path to seeders directory (defaults to database/seeders)')
  .option('--class <name>', 'Run a specific seeder class')
  .option('--verbose', 'Enable verbose logging')
  .example('query-builder db:seed')
  .example('query-builder db:seed --class UserSeeder')
  .action(async (opts: any) => {
    try {
      if (opts.class) {
        await runSeeder(opts.class, { verbose: opts.verbose })
      }
      else {
        await runSeeders({ seedersDir: opts.dir, verbose: opts.verbose })
      }
    }
    catch (err) {
      console.error('-- Seeding failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('make:seeder <name>', 'Create a new seeder file')
  .example('query-builder make:seeder User')
  .example('query-builder make:seeder UserSeeder')
  .action(async (name: string) => {
    try {
      await makeSeeder(name)
    }
    catch (err) {
      console.error('-- Failed to create seeder:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('db:fresh', 'Drop all tables, re-run migrations and seed the database')
  .option('--models <path>', 'Path to models directory (defaults to app/Models)')
  .option('--seeders <path>', 'Path to seeders directory (defaults to database/seeders)')
  .option('--verbose', 'Enable verbose logging')
  .example('query-builder db:fresh')
  .example('query-builder db:fresh --models ./app/Models --seeders ./database/seeders')
  .action(async (opts: any) => {
    try {
      await freshDatabase({
        modelsDir: opts.models,
        seedersDir: opts.seeders,
        verbose: opts.verbose,
      })
    }
    catch (err) {
      console.error('-- Database fresh failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Make commands
cli
  .command('make:model <name>', 'Create a new model file')
  .option('--table <name>', 'Table name (defaults to plural of model name)')
  .option('--dir <path>', 'Models directory (defaults to app/Models)')
  .option('--timestamps', 'Include timestamp fields (default: true)')
  .example('query-builder make:model User')
  .example('query-builder make:model Post --table=blog_posts')
  .action(async (name: string, opts: any) => {
    try {
      await makeModel(name, {
        table: opts.table,
        dir: opts.dir,
        timestamps: opts.timestamps,
      })
    }
    catch (err) {
      console.error('-- Failed to create model:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Model inspection commands
cli
  .command('model:show <name>', 'Show detailed model information')
  .option('--dir <path>', 'Models directory (defaults to app/Models)')
  .option('--json', 'Output as JSON')
  .option('--verbose', 'Enable verbose output')
  .example('query-builder model:show User')
  .example('query-builder model:show Post --json')
  .action(async (name: string, opts: any) => {
    try {
      await modelShow(name, {
        dir: opts.dir,
        json: opts.json,
        verbose: opts.verbose,
      })
    }
    catch (err) {
      console.error('-- Failed to show model:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Migration management commands
cli
  .command('migrate:status', 'Show migration status')
  .example('query-builder migrate:status')
  .action(async () => {
    try {
      await migrateStatus()
    }
    catch (err) {
      console.error('-- Failed to get migration status:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('migrate:list', 'List all migrations (alias for migrate:status)')
  .example('query-builder migrate:list')
  .action(async () => {
    try {
      await migrateList()
    }
    catch (err) {
      console.error('-- Failed to list migrations:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('migrate:rollback', 'Rollback migrations')
  .option('--steps <n>', 'Number of migrations to rollback', { default: 1 })
  .example('query-builder migrate:rollback')
  .example('query-builder migrate:rollback --steps 2')
  .action(async (opts: any) => {
    try {
      await migrateRollback({ steps: Number(opts.steps) })
    }
    catch (err) {
      console.error('-- Rollback failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('migrate:generate [dir]', 'Generate migration from model changes')
  .option('--dialect <d>', 'Dialect (postgres|mysql|sqlite)', { default: 'postgres' })
  .option('--state <path>', 'Path to migration state file')
  .option('--apply', 'Execute the generated SQL')
  .option('--full', 'Force full migration SQL')
  .example('query-builder migrate:generate')
  .example('query-builder migrate:generate ./app/Models --dialect postgres')
  .action(async (dir?: string, opts?: any) => {
    try {
      await migrateGenerate(dir, {
        dialect: opts?.dialect,
        state: opts?.state,
        apply: opts?.apply,
        full: opts?.full,
      })
    }
    catch (err) {
      console.error('-- Generate migration failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Database info commands
cli
  .command('db:info', 'Show database information and statistics')
  .example('query-builder db:info')
  .action(async () => {
    try {
      await dbInfo()
    }
    catch (err) {
      console.error('-- Failed to get database info:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('db:stats', 'Show database statistics (alias for db:info)')
  .example('query-builder db:stats')
  .action(async () => {
    try {
      await dbStats()
    }
    catch (err) {
      console.error('-- Failed to get database stats:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('db:wipe', 'Drop all tables from the database')
  .option('--dialect <d>', 'Dialect (postgres|mysql|sqlite)', { default: 'postgres' })
  .option('--force', 'Skip confirmation prompt')
  .option('--verbose', 'Enable verbose output')
  .example('query-builder db:wipe')
  .example('query-builder db:wipe --force')
  .action(async (opts: any) => {
    try {
      await dbWipe({
        dialect: opts.dialect,
        force: opts.force,
        verbose: opts.verbose,
      })
    }
    catch (err) {
      console.error('-- Wipe failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('db:optimize', 'Optimize database tables (VACUUM, ANALYZE, OPTIMIZE)')
  .option('--dialect <d>', 'Dialect (postgres|mysql|sqlite)', { default: 'postgres' })
  .option('--aggressive', 'Use aggressive optimization (VACUUM FULL for postgres)')
  .option('--tables <tables>', 'Comma-separated list of tables to optimize')
  .option('--verbose', 'Enable verbose output')
  .example('query-builder db:optimize')
  .example('query-builder db:optimize --aggressive')
  .example('query-builder db:optimize --tables users,posts')
  .action(async (opts: any) => {
    try {
      await dbOptimize({
        dialect: opts.dialect,
        aggressive: opts.aggressive,
        tables: opts.tables ? opts.tables.split(',') : undefined,
        verbose: opts.verbose,
      })
    }
    catch (err) {
      console.error('-- Optimize failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Console/REPL commands
cli
  .command('console', 'Start interactive query console')
  .example('query-builder console')
  .action(async () => {
    try {
      await startConsole()
    }
    catch (err) {
      console.error('-- Console failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('tinker', 'Start interactive query console (alias for console)')
  .example('query-builder tinker')
  .action(async () => {
    try {
      await tinker()
    }
    catch (err) {
      console.error('-- Tinker failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Table inspection commands
cli
  .command('inspect <table>', 'Inspect a table structure')
  .option('--verbose', 'Enable verbose output', { default: true })
  .example('query-builder inspect users')
  .action(async (table: string, opts: any) => {
    try {
      await inspectTable(table, { verbose: opts.verbose })
    }
    catch (err) {
      console.error('-- Failed to inspect table:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('table:info <table>', 'Show table information (alias for inspect)')
  .option('--verbose', 'Enable verbose output', { default: true })
  .example('query-builder table:info users')
  .action(async (table: string, opts: any) => {
    try {
      await tableInfo(table, { verbose: opts.verbose })
    }
    catch (err) {
      console.error('-- Failed to get table info:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Cache management commands
cli
  .command('cache:clear', 'Clear the query cache')
  .example('query-builder cache:clear')
  .action(async () => {
    try {
      await cacheClear()
    }
    catch (err) {
      console.error('-- Failed to clear cache:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('cache:stats', 'Show cache statistics')
  .example('query-builder cache:stats')
  .action(async () => {
    try {
      await cacheStats()
    }
    catch (err) {
      console.error('-- Failed to get cache stats:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('cache:config', 'Configure cache settings')
  .option('--size <n>', 'Set maximum cache size')
  .example('query-builder cache:config --size 500')
  .action(async (opts: any) => {
    try {
      await cacheConfig({ size: opts.size })
    }
    catch (err) {
      console.error('-- Failed to configure cache:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Benchmark command
cli
  .command('benchmark', 'Run performance benchmarks')
  .option('--operations <ops>', 'Comma-separated list of operations (select,insert,update,delete,count)')
  .option('--iterations <n>', 'Number of iterations per operation', { default: 1000 })
  .example('query-builder benchmark')
  .example('query-builder benchmark --operations select,insert --iterations 5000')
  .action(async (opts: any) => {
    try {
      await runBenchmark({
        operations: opts.operations,
        iterations: opts.iterations ? Number(opts.iterations) : undefined,
      })
    }
    catch (err) {
      console.error('-- Benchmark failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Schema validation commands
cli
  .command('validate:schema [dir]', 'Validate models against database schema')
  .example('query-builder validate:schema')
  .example('query-builder validate:schema ./app/Models')
  .action(async (dir?: string) => {
    try {
      await validateSchema(dir)
    }
    catch (err) {
      console.error('-- Validation failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('check [dir]', 'Validate schema (alias for validate:schema)')
  .example('query-builder check')
  .action(async (dir?: string) => {
    try {
      await checkSchema(dir)
    }
    catch (err) {
      console.error('-- Check failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

// Data export/import commands
cli
  .command('export <table>', 'Export data from a table')
  .option('--format <fmt>', 'Export format (json|csv|sql)', { default: 'json' })
  .option('--output <path>', 'Output file path')
  .option('--limit <n>', 'Limit number of rows')
  .example('query-builder export users')
  .example('query-builder export users --format csv --output users.csv')
  .example('query-builder export users --format sql --limit 100')
  .action(async (table: string, opts: any) => {
    try {
      await exportData(table, {
        format: opts.format,
        output: opts.output,
        limit: opts.limit ? Number(opts.limit) : undefined,
      })
    }
    catch (err) {
      console.error('-- Export failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('import <table> <file>', 'Import data into a table')
  .option('--format <fmt>', 'Import format (json|csv)')
  .option('--truncate', 'Truncate table before import')
  .example('query-builder import users users.json')
  .example('query-builder import users users.csv --truncate')
  .action(async (table: string, file: string, opts: any) => {
    try {
      await importData(table, file, {
        format: opts.format,
        truncate: opts.truncate,
      })
    }
    catch (err) {
      console.error('-- Import failed:', err)
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('dump', 'Dump database to SQL file')
  .option('--tables <tables>', 'Comma-separated list of tables to dump')
  .option('--output <path>', 'Output file path')
  .example('query-builder dump')
  .example('query-builder dump --tables users,posts')
  .example('query-builder dump --output backup.sql')
  .action(async (opts: any) => {
    try {
      await dumpDatabase({
        tables: opts.tables,
        output: opts.output,
      })
    }
    catch (err) {
      console.error('-- Dump failed:', err)
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
