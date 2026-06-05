import type { OnForeignKeyAction } from './schema'

/**
 * A relation entry reduced to the fields the schema/migration layers need.
 *
 * Single source of truth for unwrapping the supported relation-declaration
 * shapes. Previously `meta.ts` (toRecord) and `migrations.ts`
 * (normalizeBelongsTo) each re-implemented this — the exact shape that caused
 * stacksjs/bun-query-builder#1023, and the fix had to be applied twice. See #1042.
 */
export interface NormalizedRelation {
  model: string
  /** Custom FK column name (object form); generators default to `${snake(model)}_id`. */
  foreignKey?: string
  /** ON DELETE behaviour (object form). */
  onDelete?: OnForeignKeyAction
}

/**
 * Unwrap a single relation entry to a descriptor, or null if it isn't a valid
 * relation entry. Accepts:
 *   - `'Model'`
 *   - `{ model: 'Model', foreignKey?, onDelete? }`
 */
export function normalizeRelationEntry(entry: unknown): NormalizedRelation | null {
  if (typeof entry === 'string')
    return { model: entry }
  if (entry && typeof entry === 'object' && typeof (entry as any).model === 'string') {
    const e = entry as { model: string, foreignKey?: string, onDelete?: OnForeignKeyAction }
    return { model: e.model, foreignKey: e.foreignKey, onDelete: e.onDelete }
  }
  return null
}

/**
 * Flatten a relation declaration into descriptors. Accepts every supported
 * shape: string array, object-in-array, record (name->Model) and record
 * (name->config). Invalid entries are dropped.
 */
export function normalizeRelationList(rel: unknown): NormalizedRelation[] {
  if (!rel)
    return []
  const entries = Array.isArray(rel)
    ? rel
    : (typeof rel === 'object' ? Object.values(rel as Record<string, unknown>) : [])
  return entries.map(normalizeRelationEntry).filter((x): x is NormalizedRelation => x !== null)
}
