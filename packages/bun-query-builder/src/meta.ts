import type { BelongsToManyConfig, ModelRecord } from './schema'
import { normalizeRelationEntry } from './relation-utils'

export interface SchemaMeta {
  modelToTable: Record<string, string>
  tableToModel: Record<string, string>
  primaryKeys: Record<string, string>
  relations?: Record<string, {
    hasOne?: Record<string, string>
    hasMany?: Record<string, string>
    belongsTo?: Record<string, string>
    /**
     * Either a model-name string (legacy form) or a `BelongsToManyConfig`
     * object (Option A inline / Option B `through:`). Use `resolvePivot`
     * from `./pivot` to read pivot metadata uniformly.
     */
    belongsToMany?: Record<string, string | BelongsToManyConfig>
    hasOneThrough?: Record<string, { through: string, target: string }>
    hasManyThrough?: Record<string, { through: string, target: string }>
    morphOne?: Record<string, string>
    morphMany?: Record<string, string>
    morphTo?: Record<string, unknown>
    morphToMany?: Record<string, string>
    morphedByMany?: Record<string, string>
  }>
  scopes?: Record<string, Record<string, (qb: any, value?: any) => any>>
  /**
   * Original models record passed to `buildSchemaMeta`, retained so downstream
   * consumers (e.g. the pivot resolver) can read through-model attributes
   * without a second registry lookup. Stored as `unknown` to keep the meta
   * shape decoupled from the model definition type.
   */
  models?: ModelRecord
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

    // Normalize relations to name->ModelName mapping. Entries may be plain
    // model-name strings or object form `{ model, foreignKey?, onDelete? }`
    // (the latter is what crashed the migration generator in
    // stacksjs/bun-query-builder#1023); unwrap to the model name either way.
    const toRecord = (v: any): Record<string, string> => {
      if (!v)
        return {}
      const rec: Record<string, string> = {}
      if (Array.isArray(v)) {
        // Array form: relation name is the (unwrapped) model name.
        for (const item of v) {
          const n = normalizeRelationEntry(item)
          if (n)
            rec[n.model] = n.model
        }
        return rec
      }
      if (typeof v === 'object') {
        // Record form: relation name is the key, value unwraps to the model name.
        for (const [key, val] of Object.entries(v)) {
          const n = normalizeRelationEntry(val)
          if (n)
            rec[key] = n.model
        }
        return rec
      }
      return {}
    }
    // belongsToMany variant: preserves the config object form (Option A/B).
    const toBelongsToManyRecord = (v: any): Record<string, string | BelongsToManyConfig> => {
      if (!v)
        return {}
      if (Array.isArray(v)) {
        const rec: Record<string, string | BelongsToManyConfig> = {}
        for (const item of v) {
          if (typeof item === 'string') {
            rec[item] = item
          }
          else if (item && typeof item === 'object' && typeof item.model === 'string') {
            rec[item.model] = item as BelongsToManyConfig
          }
        }
        return rec
      }
      return v as Record<string, string | BelongsToManyConfig>
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
      belongsToMany: toBelongsToManyRecord(m.belongsToMany),
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

  return { modelToTable, tableToModel, primaryKeys, relations, scopes: scopesByTable, models }
}
