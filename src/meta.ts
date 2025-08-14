import type { ModelRecord } from './schema'

export interface SchemaMeta {
  modelToTable: Record<string, string>
  tableToModel: Record<string, string>
  primaryKeys: Record<string, string>
  relations?: Record<string, {
    hasOne?: Record<string, string>
    hasMany?: Record<string, string>
    belongsTo?: Record<string, string>
    belongsToMany?: Record<string, string>
  }>
  scopes?: Record<string, Record<string, (qb: any, value?: any) => any>>
}

export function buildSchemaMeta(models: ModelRecord): SchemaMeta {
  const modelToTable: Record<string, string> = {}
  const tableToModel: Record<string, string> = {}
  const primaryKeys: Record<string, string> = {}
  const relations: Required<SchemaMeta>['relations'] = {}
  const scopesByTable: Required<SchemaMeta>['scopes'] = {}

  for (const name of Object.keys(models)) {
    const m = models[name]
    const table = (m.table as string) || `${String(m.name).toLowerCase()}s`
    modelToTable[name] = table
    tableToModel[table] = name
    primaryKeys[table] = m.primaryKey ?? 'id'

    // Normalize relations to name->ModelName mapping
    const toRecord = (v: any): Record<string, string> => {
      if (!v)
        return {}
      if (Array.isArray(v)) {
        const rec: Record<string, string> = {}
        for (const relName of v) rec[relName] = relName
        return rec
      }
      return v as Record<string, string>
    }
    relations[table] = {
      hasOne: toRecord(m.hasOne),
      hasMany: toRecord(m.hasMany),
      belongsTo: toRecord(m.belongsTo),
      belongsToMany: toRecord(m.belongsToMany),
    }

    // Scopes
    if (m.scopes && typeof m.scopes === 'object') {
      scopesByTable[table] = {}
      for (const key of Object.keys(m.scopes)) {
        const fn = (m.scopes as any)[key]
        if (typeof fn === 'function')
          scopesByTable[table][key] = fn
      }
    }
  }

  return { modelToTable, tableToModel, primaryKeys, relations, scopes: scopesByTable }
}
