import type { BelongsToManyConfig, ModelRecord } from './schema'
import { tableNameFor } from './inflect'
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
  /**
   * Named query scopes, keyed by model then by scope name.
   *
   * The builder parameter stays `any`: a scope receives the fully-typed
   * builder for its own model, which this erased metadata table cannot name
   * without making every model's scopes mutually unassignable. The value and
   * the return are `unknown`, so nothing downstream inherits the looseness.
   */
  scopes?: Record<string, Record<string, (qb: any, value?: unknown) => unknown>>
  /**
   * Original models record passed to `buildSchemaMeta`, retained so downstream
   * consumers (e.g. the pivot resolver) can read through-model attributes
   * without a second registry lookup. Stored as `unknown` to keep the meta
   * shape decoupled from the model definition type.
   */
  models?: ModelRecord
  /**
   * Per table, the columns that hold a date or a time.
   *
   * MySQL cannot parse the ISO-8601 an application naturally produces:
   * `new Date().toISOString()` is `2026-08-19T04:37:11.396Z` and the server
   * answers "Incorrect datetime value" - the `T`, the fraction and the `Z` are
   * all outside what a `DATETIME` literal may contain. Postgres takes it, so
   * the code that writes it looks correct until the day the engine changes.
   *
   * Knowing which columns those are is what lets a value be reshaped on the way
   * in rather than the application spelling it per dialect at every call site.
   * Only columns whose model declares a temporal `type` are listed: a
   * `varchar(40)` holding an ISO string is a string, and reformatting it would
   * quietly rewrite data.
   */
  temporalColumns?: Record<string, string[]>
}

export function buildSchemaMeta(models: ModelRecord): SchemaMeta {
  const modelToTable: Record<string, string> = {}
  const tableToModel: Record<string, string> = {}
  const primaryKeys: Record<string, string> = {}
  const relations: Required<SchemaMeta>['relations'] = {}
  const scopesByTable: Required<SchemaMeta>['scopes'] = {}
  const temporalColumns: Record<string, string[]> = {}

  for (const name of Object.keys(models)) {
    // Support both direct model definitions and wrapped models from defineModel()
    // defineModel() from model.ts wraps the definition in { definition, getDefinition, ... }
    const rawModel = models[name]
    const m = (rawModel as any).definition ?? (rawModel as any).getDefinition?.() ?? rawModel
    const table = tableNameFor(m)
    modelToTable[name] = table
    tableToModel[table] = name
    primaryKeys[table] = m.primaryKey ?? 'id'

    // The columns a value has to be reshaped for on MySQL. Declared types only;
    // see `temporalColumns` on the interface for why an inferred one is not
    // enough to justify rewriting a value.
    const temporal: string[] = []

    for (const [column, attribute] of Object.entries((m.attributes ?? {}) as Record<string, any>)) {
      if (/^(?:datetime|timestamp|timestamptz|date)$/i.test(String(attribute?.type ?? '')))
        temporal.push(column)
    }

    // `useTimestamps` adds two more that no attribute declares.
    const traits = (m.traits ?? {}) as Record<string, unknown>

    if (traits.useTimestamps ?? traits.timestampable)
      temporal.push('created_at', 'updated_at')

    if (temporal.length > 0)
      temporalColumns[table] = [...new Set(temporal)]

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

  return { modelToTable, tableToModel, primaryKeys, relations, scopes: scopesByTable, models, temporalColumns }
}
