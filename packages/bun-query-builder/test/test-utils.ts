/**
 * Test Utilities
 *
 * Provides safe, auto-cleaning helpers for test infrastructure:
 *
 * - `createTempDir(prefix)` — creates a temp dir tracked for auto-cleanup
 * - `withTempDir(prefix, fn)` — runs fn with a scoped temp dir, cleans up after
 * - `createTestFile(dir, name, content)` — writes a file into a tracked temp dir
 * - `useTestDatabase()` — returns { beforeAll, afterAll } hooks for embedded Postgres
 *
 * All temp dirs are automatically cleaned up on process exit, SIGINT, SIGTERM,
 * or uncaught exceptions — even if afterAll doesn't fire.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── Tracked Temp Directories ────────────────────────────────────────────────

const trackedDirs = new Set<string>()
let cleanupRegistered = false

/**
 * Register process-level cleanup hooks (only once).
 * Ensures all tracked temp dirs are removed on exit, even on crash.
 */
function registerProcessCleanup(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true

  const cleanup = () => {
    for (const dir of trackedDirs) {
      try {
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true })
        }
      }
      catch {
        // Best-effort cleanup — don't throw during exit
      }
    }
    trackedDirs.clear()
  }

  process.on('exit', cleanup)
  process.on('SIGINT', () => { cleanup(); process.exit(130) })
  process.on('SIGTERM', () => { cleanup(); process.exit(143) })
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception during tests:', err)
    cleanup()
    process.exit(1)
  })
}

/**
 * Create a temporary directory that is automatically cleaned up on process exit.
 *
 * @param prefix - Prefix for the temp dir name (default: 'qb-test-')
 * @returns Absolute path to the created temp directory
 *
 * @example
 * ```ts
 * const dir = createTempDir('qb-e2e-')
 * // use dir...
 * // Automatically cleaned up on process exit, or call removeTempDir(dir) manually
 * ```
 */
export function createTempDir(prefix = 'qb-test-'): string {
  registerProcessCleanup()
  const dir = mkdtempSync(join(tmpdir(), prefix))
  trackedDirs.add(dir)
  return dir
}

/**
 * Manually remove a tracked temp directory and stop tracking it.
 */
export function removeTempDir(dir: string): void {
  trackedDirs.delete(dir)
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  catch {
    // Best-effort
  }
}

/**
 * Run a function with a scoped temp directory. The dir is always cleaned up
 * after the function completes, whether it succeeds or throws.
 *
 * @param prefix - Prefix for the temp dir name
 * @param fn - Async function that receives the temp dir path
 * @returns The return value of fn
 *
 * @example
 * ```ts
 * const result = await withTempDir('qb-cli-', async (dir) => {
 *   writeFileSync(join(dir, 'test.sql'), 'SELECT 1')
 *   return runCli(dir)
 * })
 * ```
 */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = createTempDir(prefix)
  try {
    return await fn(dir)
  }
  finally {
    removeTempDir(dir)
  }
}

/**
 * Synchronous version of withTempDir.
 */
export function withTempDirSync<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = createTempDir(prefix)
  try {
    return fn(dir)
  }
  finally {
    removeTempDir(dir)
  }
}

// ─── File Helpers ────────────────────────────────────────────────────────────

/**
 * Create a file inside a directory, creating intermediate dirs as needed.
 *
 * @example
 * ```ts
 * const dir = createTempDir('qb-test-')
 * createTestFile(dir, 'database/seeders/UserSeeder.ts', seederContent)
 * ```
 */
export function createTestFile(baseDir: string, relativePath: string, content: string): string {
  const fullPath = join(baseDir, relativePath)
  const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'))
  if (parentDir && !existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }
  writeFileSync(fullPath, content)
  return fullPath
}

/**
 * Create a directory inside a base dir, creating intermediates as needed.
 */
export function createTestDir(baseDir: string, relativePath: string): string {
  const fullPath = join(baseDir, relativePath)
  mkdirSync(fullPath, { recursive: true })
  return fullPath
}

// ─── Database Lifecycle ──────────────────────────────────────────────────────

/**
 * Returns beforeAll/afterAll hooks for tests that need Postgres.
 * Uses external Postgres if available, otherwise starts one via pantry.
 */
export function useTestDatabase() {
  return {
    beforeAll: async () => {
      const { ensurePostgres } = await import('./setup')
      await ensurePostgres()
    },
    afterAll: async () => {
      const { teardownPostgres } = await import('./setup')
      await teardownPostgres()
    },
  }
}

/**
 * Returns beforeAll/afterAll hooks that set up the full database
 * (runs migrations against the examples models).
 */
export function useTestDatabaseWithMigrations() {
  return {
    beforeAll: async () => {
      const { setupDatabase } = await import('./setup')
      await setupDatabase()
    },
    afterAll: async () => {
      const { teardownPostgres, EXAMPLES_MODELS_PATH } = await import('./setup')
      const { resetDatabase } = await import('../src/actions/migrate')
      const { config } = await import('../src/config')
      try {
        await resetDatabase(EXAMPLES_MODELS_PATH, { dialect: config.dialect })
      }
      catch {
        // Ignore cleanup errors
      }
      await teardownPostgres()
    },
  }
}

// ─── Re-exports for convenience ──────────────────────────────────────────────

export { mockSql, mockQueryBuilderState } from './utils'
