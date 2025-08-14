import type { SupportedDialect } from '../src'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAC } from 'cac'
import { version } from '../package.json'
import { buildDatabaseSchema, buildMigrationPlan, createQueryBuilder, generateDiffSql, generateSql, hashMigrationPlan, loadModels } from '../src'
import { config } from '../src/config'

const cli = new CAC('query-builder')

interface CliOption {
  verbose: boolean
}

cli
  .command('introspect <dir>', 'Load models and print inferred schema')
  .option('--verbose', 'Enable verbose logging')
  .example('query-builder introspect ./app/Models --verbose')
  .action(async (dir: string, _options?: CliOption) => {
    const models = loadModels({ modelsDir: dir })
    const schema = buildDatabaseSchema(models)

    console.log(JSON.stringify(schema, null, 2))
  })

cli
  .command('sql <dir> <table>', 'Build a sample query for a table')
  .option('--limit <n>', 'Limit rows', { default: 10 })
  .example('query-builder sql ./app/Models users --limit 5')
  .action(async (dir: string, table: string, opts: any) => {
    const models = loadModels({ modelsDir: dir })
    const dbSchema = buildDatabaseSchema(models)
    // enable debug text capture so we can print a textual representation
    if (config.debug)
      config.debug.captureText = true
    const qb = createQueryBuilder<typeof dbSchema>({ schema: dbSchema })
    const s = (qb.selectFrom(table as any).limit(Number(opts.limit)) as any).toText?.() ?? ''
    console.log(s || '[query]')
  })

cli
  .command('ping', 'Test database connectivity (uses environment variables)')
  .example('query-builder ping')
  .action(async () => {
    const qb = createQueryBuilder()
    const ok = await qb.ping()
    console.log(ok ? 'OK' : 'NOT READY')
  })

cli
  .command('wait-ready', 'Wait for database to become ready')
  .option('--attempts <n>', 'Number of attempts', { default: 10 })
  .option('--delay <ms>', 'Delay between attempts', { default: 100 })
  .example('query-builder wait-ready --attempts 30 --delay 250')
  .action(async (opts: any) => {
    const qb = createQueryBuilder()
    try {
      await qb.waitForReady({ attempts: Number(opts.attempts), delayMs: Number(opts.delay) })
      console.log('READY')
    }
    catch {
      console.error('NOT READY')
      const proc = await import('node:process')
      proc.default.exitCode = 1
    }
  })

cli
  .command('unsafe <sql>', 'Execute an unsafe SQL string (one statement with params)')
  .option('--params <json>', 'JSON array of parameters')
  .example('query-builder unsafe "SELECT * FROM users WHERE id = $1" --params "[1]"')
  .action(async (sql: string, opts: any) => {
    const qb = createQueryBuilder()
    const params = opts.params ? JSON.parse(opts.params) : undefined
    const res = await qb.unsafe(sql, params)
    console.log(JSON.stringify(res))
  })

cli
  .command('file <path>', 'Execute a SQL file (supports $1, $2 params)')
  .option('--params <json>', 'JSON array of parameters')
  .example('query-builder file ./migrations/seed.sql')
  .example('query-builder file ./reports/top.sql --params "[30]"')
  .action(async (path: string, opts: any) => {
    const qb = createQueryBuilder()
    const params = opts.params ? JSON.parse(opts.params) : undefined
    const res = await qb.file(path, params)
    console.log(JSON.stringify(res))
  })

cli
  .command('migrate <dir>', 'Generate SQL migrations from models')
  .option('--dialect <d>', 'Dialect (postgres|mysql|sqlite)', { default: 'postgres' })
  .option('--state <path>', 'Path to migration state file (defaults to <dir>/.qb-migrations.<dialect>.json)')
  .option('--apply', 'Execute the generated SQL against the database')
  .option('--full', 'Force full migration SQL instead of incremental diff')
  .example('query-builder migrate ./app/Models --dialect postgres')
  .action(async (dir: string, opts: any) => {
    const dialect = String(opts.dialect) as SupportedDialect
    const models = loadModels({ modelsDir: dir })
    const plan = buildMigrationPlan(models, { dialect })

    const defaultStatePath = join(dir, `.qb-migrations.${dialect}.json`)
    const statePath = String(opts.state || defaultStatePath)

    let previous: any | undefined
    if (existsSync(statePath)) {
      try {
        const raw = readFileSync(statePath, 'utf8')
        const parsed = JSON.parse(raw)
        previous = parsed?.plan && parsed.plan.tables ? parsed.plan : (parsed?.tables ? parsed : undefined)
      }
      catch {
        // ignore corrupt state; treat as no previous
      }
    }

    const sql = opts.full ? generateSql(plan) : generateDiffSql(previous, plan)
    const hasChanges = /\b(?:CREATE|ALTER)\b/i.test(sql)

    if (opts.apply) {
      const qb = createQueryBuilder()
      // Use a temp file to execute multiple statements safely via file()
      const dirPath = mkdtempSync(join(tmpdir(), 'qb-migrate-'))
      const filePath = join(dirPath, 'migration.sql')
      try {
        if (hasChanges) {
          writeFileSync(filePath, sql)
          await qb.file(filePath)
          console.log('-- Migration applied')
        }
        else {
          console.log('-- No changes; nothing to apply')
        }
        // On success, write state snapshot with current plan and hash
        writeFileSync(statePath, JSON.stringify({ plan, hash: hashMigrationPlan(plan), updatedAt: new Date().toISOString() }, null, 2))
      }
      catch (err) {
        console.error('-- Migration failed:', err)
        const proc = await import('node:process')
        proc.default.exitCode = 1
      }
    }
    else {
      console.log(sql)
    }
  })

cli
  .command('explain <sql>', 'Explain a query')
  .example('query-builder explain "SELECT * FROM users WHERE active = true"')
  .action(async (sql: string) => {
    const qb = createQueryBuilder()
    const q = qb.raw([sql] as unknown as TemplateStringsArray)
    const rows = await ((q as any).simple()?.execute?.() ?? Promise.resolve([]))
    console.log(JSON.stringify(rows, null, 2))
  })

cli.command('version', 'Show the version of the CLI').action(() => {
  console.log(version)
})

cli.version(version)
cli.help()
cli.parse()
