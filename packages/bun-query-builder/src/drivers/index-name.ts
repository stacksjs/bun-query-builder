/**
 * Postgres truncates any identifier over 63 bytes, silently, with a notice
 * nobody reads. MySQL refuses one over 64 outright.
 *
 * A truncated index name is worse than a rejected one. The database ends up
 * holding a name the model never declared, so the next diff looks for the
 * declared name, does not find it, and proposes creating it - forever. That is
 * exactly what "drop and recreate this index, unchanged, on every single run"
 * looks like from the outside.
 */
export const MAX_IDENTIFIER_LENGTH = 63

/**
 * A stable short suffix for a name that has to be shortened.
 *
 * Derived from the full name, so the same index always shortens to the same
 * thing: a hash that moved between runs would reintroduce the churn this exists
 * to prevent. Deliberately tiny - it only has to separate names that share a
 * 55-character prefix, which is a handful per table at most.
 */
function fingerprint(value: string): string {
  // FNV-1a. Small, dependency-free, and more than enough to tell apart the few
  // names in one table that collide after truncation.
  let hash = 0x811C9DC5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return hash.toString(36).padStart(7, '0').slice(-7)
}

/**
 * Shorten a name to what the database will actually store.
 *
 * Truncating and appending the fingerprint of the full name keeps the result
 * readable at the front - where the table and column names are - and unique at
 * the back.
 */
export function boundIdentifier(name: string, limit = MAX_IDENTIFIER_LENGTH): string {
  if (name.length <= limit)
    return name

  const suffix = `_${fingerprint(name)}`

  return name.slice(0, limit - suffix.length) + suffix
}

/**
 * The name an index has in the database.
 *
 * Qualified with its table when it is not already, then bounded. Both halves
 * have to happen here rather than at the call sites, because the diff compares
 * what the model declares against what the database reports, and those only
 * agree if the same function produced both.
 */
export function qualifiedIndexName(tableName: string, indexName: string): string {
  const prefix = `${tableName}_`
  const qualified = indexName.startsWith(prefix) ? indexName : `${prefix}${indexName}`

  return boundIdentifier(qualified)
}
