import type { Database } from 'bun:sqlite'
import { config } from './config'

/**
 * Bootstrap pragmas applied to every sqlite connection the library opens.
 *
 * SQLite scopes these settings to the CONNECTION, not the database file, and
 * ships with unsafe defaults on every fresh connection: `foreign_keys` is OFF
 * (so `REFERENCES ... ON DELETE CASCADE` in the schema is silently inert and
 * orphan rows insert without error) and there is no busy timeout (concurrent
 * writers surface as immediate `SQLITE_BUSY` failures). They therefore have
 * to be re-applied on every connection the library creates — historically
 * only the query-builder connection got `journal_mode = WAL` while the
 * model-layer executor (the connection `Model.create()/save()/delete()`
 * writes through) got nothing at all, leaving FK enforcement off on the
 * exact connection performing the writes.
 *
 * Override via `setConfig({ sqlite: { pragmas: [...] } })` — the custom list
 * REPLACES this one. Caller-supplied `Database` instances
 * (`configureOrm({ database: db })`) are never touched.
 */
export const DEFAULT_SQLITE_PRAGMAS: readonly string[] = [
  // Write-Ahead Logging: readers don't block the writer and vice versa.
  'PRAGMA journal_mode = WAL',
  // Make schema-declared foreign keys actually enforce.
  'PRAGMA foreign_keys = ON',
  // Wait for a lock instead of failing instantly with SQLITE_BUSY.
  'PRAGMA busy_timeout = 5000',
]

/** The pragma list currently in effect: the config override, or the defaults. */
export function resolveSqlitePragmas(): readonly string[] {
  const custom = config.sqlite?.pragmas
  return Array.isArray(custom) ? custom : DEFAULT_SQLITE_PRAGMAS
}

/**
 * Apply the bootstrap pragmas to a freshly-opened `bun:sqlite` Database.
 *
 * Fail-open per pragma: a single rejected pragma (e.g. a dialect-specific
 * one in a custom list) must not take down connection creation — matching
 * the long-standing behavior of the WAL pragma this generalizes.
 */
export function applySqliteBootstrapPragmas(db: Database): void {
  for (const pragma of resolveSqlitePragmas()) {
    try {
      db.run(pragma)
    }
    catch {
      // fail open — see doc comment
    }
  }
}
