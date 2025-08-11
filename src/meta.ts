import type { ModelRecord } from './schema'

export interface SchemaMeta {
  modelToTable: Record<string, string>
  tableToModel: Record<string, string>
  primaryKeys: Record<string, string>
}

export function buildSchemaMeta(models: ModelRecord): SchemaMeta {
  const modelToTable: Record<string, string> = {}
  const tableToModel: Record<string, string> = {}
  const primaryKeys: Record<string, string> = {}

  for (const name of Object.keys(models)) {
    const m = models[name]
    const table = (m.table as string) || `${String(m.name).toLowerCase()}s`
    modelToTable[name] = table
    tableToModel[table] = name
    primaryKeys[table] = m.primaryKey ?? 'id'
  }

  return { modelToTable, tableToModel, primaryKeys }
}
