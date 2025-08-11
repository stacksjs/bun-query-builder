import { CAC } from 'cac'
import { version } from '../package.json'
import { buildDatabaseSchema, createQueryBuilder, loadModels } from '../src'

const cli = new CAC('query-builder')

interface CliOption {
  verbose: boolean
}

cli
  .command('introspect <dir>', 'Load models and print inferred schema')
  .option('--verbose', 'Enable verbose logging')
  .example('query-builder introspect ./app/Models --verbose')
  .action(async (dir: string, options?: CliOption) => {
    const models = loadModels({ modelsDir: dir })
    const schema = buildDatabaseSchema(models)

    console.log(JSON.stringify(schema, null, 2))
  })

cli
  .command('sql <dir> <table>', 'Build a sample query for a table')
  .option('--limit <n>', 'Limit rows', { default: 10 })
  .action(async (dir: string, table: string, opts: any) => {
    const models = loadModels({ modelsDir: dir })
    const schema = buildDatabaseSchema(models)
    const qb = createQueryBuilder<typeof schema>()
    const q = qb.selectFrom(table as any).limit(Number(opts.limit)).toSQL()

    console.log(String(q))
  })

cli.command('version', 'Show the version of the CLI').action(() => {
  console.log(version)
})

cli.version(version)
cli.help()
cli.parse()
