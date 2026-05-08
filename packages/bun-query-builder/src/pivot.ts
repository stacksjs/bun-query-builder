/**
 * Pivot resolver — single source of truth for `belongsToMany` pivot metadata.
 *
 * Accepts both the legacy string form (`belongsToMany: { athletes: 'Athlete' }`)
 * and the new config form (Option A inline / Option B `through:`). Centralizes
 * the `[a,b].sort().join('_')` table-name convention that previously lived in
 * five places across `client.ts`.
 */

import type { BelongsToManyConfig, ModelRecord, PivotColumnAttribute } from './schema'
import type { SchemaMeta } from './meta'

/** Default trailing-s singularization, matching the legacy convention. */
function defaultSingularize(name: string): string {
  return name.endsWith('s') ? name.slice(0, -1) : name
}

export interface ResolvedPivot {
  /** Final pivot table name. */
  pivotTable: string
  /** FK column on the pivot pointing at the parent (owning) model. */
  fkParent: string
  /** FK column on the pivot pointing at the related (target) model. */
  fkRelated: string
  /** Declared pivot column names (excluding the two FKs and timestamps). */
  pivotColumns: string[]
  /** Pivot column attribute metadata, when known (Option A or Option B). */
  pivotColumnDefs: Record<string, PivotColumnAttribute>
  /** Pivot model name when declared via `through:` (Option B). */
  pivotModelName?: string
  /** Whether the pivot tracks `created_at`/`updated_at`. */
  timestamps: boolean
  /** The target (related) model name. */
  relatedModelName: string
  /** The target (related) table. */
  relatedTable: string
  /** True when the relation declaration uses the new config form. */
  hasConfig: boolean
}

export interface ResolvePivotOptions {
  /** Override the trailing-s singularization (e.g. when config opts out). */
  singularize?: (s: string) => string
  /** Original models record for reading through-model attributes (Option B). */
  models?: ModelRecord
}

/**
 * Resolve a `belongsToMany` relation entry to a `ResolvedPivot`. Returns null
 * when the relation key is absent or not a `belongsToMany` on the parent.
 */
export function resolvePivot(
  meta: SchemaMeta,
  parentTable: string,
  relationKey: string,
  options: ResolvePivotOptions = {},
): ResolvedPivot | null {
  const singularize = options.singularize ?? defaultSingularize
  const rels = meta.relations?.[parentTable]
  const entry = rels?.belongsToMany?.[relationKey]
  if (entry == null)
    return null

  const isConfig = typeof entry === 'object'
  const config = isConfig ? entry as BelongsToManyConfig : null
  const relatedModelName = isConfig ? config!.model : (entry as string)
  const relatedTable = meta.modelToTable[relatedModelName] || relatedModelName

  // Resolve pivot table name:
  // 1. explicit `table:` override
  // 2. `through:` -> resolved through-model's table
  // 3. legacy default: [singular(a), singular(b)].sort().join('_')
  let pivotTable: string
  let pivotModelName: string | undefined
  if (config?.table) {
    pivotTable = config.table
  }
  else if (config?.through) {
    pivotModelName = config.through
    pivotTable = meta.modelToTable[config.through]
    if (!pivotTable) {
      throw new Error(
        `[query-builder] belongsToMany relation '${relationKey}' on '${parentTable}' references unknown through model '${config.through}'. Make sure '${config.through}' is registered via defineModels({...}).`,
      )
    }
  }
  else {
    const a = singularize(parentTable)
    const b = singularize(relatedTable)
    pivotTable = [a, b].sort().join('_')
  }

  // FK column names on the pivot:
  const fkParent = config?.foreignKey ?? `${singularize(parentTable)}_id`
  const fkRelated = config?.relatedKey ?? `${singularize(relatedTable)}_id`

  // Pivot column metadata (Option A inline, or Option B from through-model attrs):
  const pivotColumnDefs: Record<string, PivotColumnAttribute> = {}
  if (config?.pivot?.columns) {
    Object.assign(pivotColumnDefs, config.pivot.columns)
  }
  if (pivotModelName && options.models) {
    const raw = options.models[pivotModelName]
    const def = raw?.definition ?? raw?.getDefinition?.() ?? raw
    const attrs = (def?.attributes ?? {}) as Record<string, any>
    for (const [k, attr] of Object.entries(attrs)) {
      // Skip the two FK columns and primary key — they're not "extra" pivot data.
      if (k === fkParent || k === fkRelated || k === (def?.primaryKey ?? 'id'))
        continue
      pivotColumnDefs[k] = {
        default: attr?.default,
        nullable: attr?.nullable,
        validation: attr?.validation,
      }
    }
  }

  const timestamps = Boolean(config?.pivot?.timestamps)
  const pivotColumns = Object.keys(pivotColumnDefs)

  return {
    pivotTable,
    fkParent,
    fkRelated,
    pivotColumns,
    pivotColumnDefs,
    pivotModelName,
    timestamps,
    relatedModelName,
    relatedTable,
    hasConfig: isConfig,
  }
}

/**
 * Iterate every declared `belongsToMany` relation across all parent tables and
 * yield each as a `ResolvedPivot`. Useful for migration emission and CLI
 * introspection.
 */
export function* iterateAllPivots(
  meta: SchemaMeta,
  options: ResolvePivotOptions = {},
): Generator<{ parentTable: string, relationKey: string, resolved: ResolvedPivot }> {
  const rels = meta.relations
  if (!rels)
    return
  for (const [parentTable, parentRels] of Object.entries(rels)) {
    const btm = parentRels?.belongsToMany
    if (!btm)
      continue
    for (const relationKey of Object.keys(btm)) {
      const resolved = resolvePivot(meta, parentTable, relationKey, options)
      if (resolved)
        yield { parentTable, relationKey, resolved }
    }
  }
}
