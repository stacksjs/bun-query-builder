/**
 * Every test file in this package is reachable from the command CI runs.
 *
 * The `test` script hands bun an explicit path. That path was
 * `packages/bun-query-builder/test`, so `src/__tests__/type-narrowing.test.ts`
 * — 20 tests, 50 assertions — was never executed by CI. It passes, and it had
 * passed all along for anyone running bare `bun test` from the repository root,
 * which discovers the whole tree. CI's narrower path did not, and nothing said
 * so: the run reported 216 files and a green tick, and 216 looks no different
 * from 217 unless you already suspect the number.
 *
 * Only the runtime half was missing. tsconfig.json INCLUDES every source file
 * under a package's `src`, so that file's types are checked by the typecheck
 * job — and, inverted, it EXCLUDES everything under a package's `test`, so the
 * directory holding every other test is not typechecked at all. The two halves
 * cover opposite sides of the package, which is how a file could sit in the gap.
 *
 * So this asserts the invariant rather than the fix: a test file added anywhere
 * under the package must be somewhere the `test` script will find it. Moving
 * one into a new directory, or narrowing the script's path again, fails here
 * instead of quietly dropping it from the only run that gates a merge.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const REPO = resolve(import.meta.dir, '../../..')
const PACKAGE = resolve(import.meta.dir, '..')

/**
 * The paths the `test` script passes to bun, relative to the repository root.
 *
 * Read from package.json rather than hardcoded, so this tracks the script it
 * is about: narrowing the path is the regression, and a copy of the path here
 * would be narrowed along with it.
 */
function configuredTestPaths(): string[] {
  const script = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts?.test as string | undefined
  expect(script).toBeTypeOf('string')

  // `bun run build && bun test --max-concurrency=1 <path>...` — take the
  // segment that invokes the runner, then its non-flag arguments. A flag that
  // takes a separate value would need handling here; the script uses `=`.
  const invocation = script!.split('&&').map(part => part.trim()).find(part => /^bun\s+test\b/.test(part))
  expect(invocation).toBeTypeOf('string')

  return invocation!
    .replace(/^bun\s+test\b/, '')
    .split(/\s+/)
    .filter(argument => argument.length > 0 && !argument.startsWith('-'))
}

function testFilesUnder(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
      continue
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      testFilesUnder(path, found)
    else if (/\.test\.ts$/.test(entry.name))
      found.push(path)
  }
  return found
}

describe('the test command CI runs', () => {
  it('reaches every test file in the package', () => {
    const paths = configuredTestPaths()

    // No path at all means bun discovers the whole tree, which is the thing
    // being asked for — nothing to check.
    if (paths.length === 0)
      return

    const roots = paths.map(path => resolve(REPO, path))
    const orphans = testFilesUnder(PACKAGE)
      .filter(file => !roots.some(root => file === root || file.startsWith(root + sep)))
      .map(file => relative(REPO, file))

    // Named, not counted: the fix is to move the file or widen the script, and
    // either way the person reading this needs to know which file.
    expect(orphans).toEqual([])
  })

  it('finds the file that was missing, so this guard is wired to something real', () => {
    // A guard whose discovery is broken reports zero orphans forever. This
    // pins that the walk actually sees the file the incident was about.
    const found = testFilesUnder(PACKAGE).map(file => relative(REPO, file))

    expect(found).toContain('packages/bun-query-builder/src/__tests__/type-narrowing.test.ts')
    expect(found).toContain('packages/bun-query-builder/test/suite-coverage.test.ts')
  })
})
