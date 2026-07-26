/**
 * Shared singularization for relation conventions.
 *
 * Pivot table names and FK columns are derived by singularizing a table name
 * (`posts` -> `post_id`, `[coach, athlete].sort().join('_')`). Four call sites
 * — client.ts, pivot.ts, orm.ts and migrations.ts — each open-coded the same
 * naive trailing-`s` strip, which is wrong for every table `toTableName()`
 * pluralizes with anything other than a bare `s`:
 *
 *   categories -> `categorie` (want `category`)
 *   addresses  -> `addresse`  (want `address`)
 *   boxes      -> `boxe`      (want `box`)
 *   status     -> `statu`     (want `status` — it was never plural)
 *
 * Changing the default would rename existing pivot tables and FK columns under
 * live schemas, so `'stripTrailingS'` remains the default and the corrected
 * behavior is opt-in via `relations.singularizeStrategy: 'inflect'`.
 */

/** Naive trailing-`s` strip — the historical default. */
export function stripTrailingS(name: string): string {
  return name.endsWith('s') ? name.slice(0, -1) : name
}

/**
 * Exact inverse of `toTableName()`'s pluralization rules.
 *
 * Words that aren't plural under those rules (`status`, `bus`, `data`) are
 * returned untouched — the naive strip mangled them.
 */
export function inflectSingular(name: string): string {
  // `categories` <- `category` (y -> ies, but not after a vowel)
  if (name.endsWith('ies') && name.length > 3) {
    const stem = name.slice(0, -3)
    const prev = stem[stem.length - 1]
    if (prev && !'aeiou'.includes(prev))
      return `${stem}y`
  }
  // `addresses` / `boxes` / `batches` / `dishes` <- s / x / ch / sh + es
  if (name.endsWith('es') && name.length > 2) {
    const stem = name.slice(0, -2)
    if (stem.endsWith('s') || stem.endsWith('x') || stem.endsWith('ch') || stem.endsWith('sh'))
      return stem
  }
  // A bare `s` plural — but `status`/`bus`/`address` end in `ss`/`us` and are
  // singular already, so don't strip those.
  if (name.endsWith('s') && !name.endsWith('ss') && !name.endsWith('us') && !name.endsWith('is'))
    return name.slice(0, -1)
  return name
}

/** Resolve the singularizer for a configured strategy. */
export function singularizerFor(strategy: 'stripTrailingS' | 'none' | 'inflect' | undefined): (name: string) => string {
  if (strategy === 'none')
    return (name: string) => name
  if (strategy === 'inflect')
    return inflectSingular
  return stripTrailingS
}
