/**
 * Where the project's generated state lives.
 *
 * Six modules resolved this independently, and not identically: five walked up
 * from the working directory to the nearest `package.json`, while the migration
 * RUNNER used `process.cwd()` verbatim. Run `qb migrate` from a subdirectory of
 * your project — `src/`, `apps/api/`, anywhere but the root — and the runner
 * looked for `<subdir>/database/migrations`, found nothing, created an empty
 * one and reported "No migration files found", while `migrate:status` in the
 * same shell listed the real corpus from the project root. The commands
 * disagreed about which project they were operating on.
 *
 * One resolver now, so they cannot drift apart again.
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'

/**
 * The nearest ancestor of `startPath` containing a `package.json`, or the
 * working directory when there is none — which keeps a bare directory (a test
 * fixture, a scratch folder) working as its own workspace.
 */
export function findWorkspaceRoot(startPath: string = process.cwd()): string {
  let currentPath = startPath

  while (currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, 'package.json')))
      return currentPath
    currentPath = dirname(currentPath)
  }

  return process.cwd()
}

/** The configured migration corpus, resolved from the workspace root. */
export function getSqlDirectory(workspaceRoot?: string, migrationDir = 'database/migrations'): string {
  const configured = migrationDir || 'database/migrations'
  return isAbsolute(configured)
    ? configured
    : join(workspaceRoot ?? findWorkspaceRoot(), configured)
}
