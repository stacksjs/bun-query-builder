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
    hasOneThrough?: Record<string, { through: string, target: string }>
    hasManyThrough?: Record<string, { through: string, target: string }>
    morphOne?: Record<string, string>
    morphMany?: Record<string, string>
    morphTo?: Record<string, unknown>
    morphToMany?: Record<string, string>
    morphedByMany?: Record<string, string>
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
    // Support both direct model definitions and wrapped models from defineModel()
    // defineModel() from model.ts wraps the definition in { definition, getDefinition, ... }
    const rawModel = models[name]
    const m = (rawModel as any).definition ?? (rawModel as any).getDefinition?.() ?? rawModel
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
    const toThroughRecord = (v: any): Record<string, { through: string, target: string }> => {
      if (!v)
        return {}
      return v as Record<string, { through: string, target: string }>
    }
    relations[table] = {
      hasOne: toRecord(m.hasOne),
      hasMany: toRecord(m.hasMany),
      belongsTo: toRecord(m.belongsTo),
      belongsToMany: toRecord(m.belongsToMany),
      hasOneThrough: toThroughRecord(m.hasOneThrough),
      hasManyThrough: toThroughRecord(m.hasManyThrough),
      morphOne: toRecord(m.morphOne),
      morphMany: toRecord(m.morphMany),
      morphTo: m.morphTo,
      morphToMany: toRecord(m.morphToMany),
      morphedByMany: toRecord(m.morphedByMany),
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
