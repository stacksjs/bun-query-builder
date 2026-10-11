import type { ColumnPlan } from '../migrations'

/**
 * The precision a `decimal` column gets when its model does not say.
 *
 * Kept as the long-standing `decimal(10,2)` so a plan or snapshot written
 * before precision was configurable renders, and diffs, exactly as it did.
 */
export const DEFAULT_DECIMAL_PRECISION = 10
export const DEFAULT_DECIMAL_SCALE = 2

/**
 * The `(precision, scale)` a decimal column is rendered with.
 *
 * Only one of the two may be declared. A precision on its own keeps the
 * default scale of 2 (clamped to the precision) rather than SQL's implicit 0,
 * because the column is almost always money and silently dropping the cents
 * is the worse surprise. A scale on its own keeps the default precision,
 * widened if the scale would not otherwise fit.
 */
export function decimalPrecision(column: Pick<ColumnPlan, 'precision' | 'scale'>): { precision: number, scale: number } {
  const scale = column.scale ?? Math.min(DEFAULT_DECIMAL_SCALE, column.precision ?? DEFAULT_DECIMAL_SCALE)
  const precision = column.precision ?? Math.max(DEFAULT_DECIMAL_PRECISION, scale)
  return { precision, scale }
}

/** `decimal(p,s)` for a column, in the spelling every SQL dialect accepts. */
export function decimalTypeSql(column: Pick<ColumnPlan, 'precision' | 'scale'>): string {
  const { precision, scale } = decimalPrecision(column)
  return `decimal(${precision},${scale})`
}
