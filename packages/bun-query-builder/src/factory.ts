import type { DatabaseSchema, ModelRecord } from './schema'
import { tableNameFor } from './inflect'

export type BuildDatabaseSchema<MRecord extends ModelRecord> = DatabaseSchema<MRecord>

export function buildDatabaseSchema<MRecord extends ModelRecord>(models: MRecord): BuildDatabaseSchema<MRecord> {
  const schema: any = {}
  for (const modelName of Object.keys(models)) {
    // Support both direct model definitions and wrapped models from defineModel()
    const rawModel = models[modelName]
    const m = (rawModel as any).definition ?? (rawModel as any).getDefinition?.() ?? rawModel
    const table: string = tableNameFor(m)
    const attrs = m.attributes ?? {}
    const columns: Record<string, unknown> = {}
    for (const key of Object.keys(attrs)) columns[key] = undefined
    schema[table] = {
      columns,
      primaryKey: m.primaryKey ?? 'id',
    }
  }
  return schema
}

export type TablesFromSchema<DB> = keyof DB & string

export type ColumnsOf<DB, TTable extends keyof DB & string> = DB[TTable] extends { columns: infer C }
  ? C
  : never
