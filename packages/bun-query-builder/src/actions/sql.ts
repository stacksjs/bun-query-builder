import type { SqlOptions } from '../types'
import { config } from '../config'
import { buildDatabaseSchema, createQueryBuilder, loadModels } from '../index'

export function sql(dir: string, table: string, opts: SqlOptions = {}) {
  const models = loadModels({ modelsDir: dir })
  const dbSchema = buildDatabaseSchema(models)

  // enable debug text capture so we can print a textual representation
  if (config.debug)
    config.debug.captureText = true

  const qb = createQueryBuilder<typeof dbSchema>({ schema: dbSchema })
  const s = (qb.selectFrom(table as any).limit(Number(opts.limit || 10)) as any).toText?.() ?? ''

  console.log(s || '[query]')

  return { sql: s, qb, schema: dbSchema }
}
