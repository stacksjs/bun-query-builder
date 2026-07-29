/**
 * Every command has to agree on which project it is operating on.
 *
 * The migration runner resolved its workspace as `process.cwd()` verbatim,
 * while `migrate:status`, `migrate:rollback`, `seed`, `make:model` and
 * `validate` all walked up to the nearest `package.json`. Run `qb migrate`
 * from a subdirectory and it looked for `<subdir>/database/migrations`, found
 * nothing, and reported nothing to do — while `migrate:status` in the same
 * shell listed the real corpus from the project root.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { findWorkspaceRoot, getSqlDirectory } from '../src/workspace'

let projectRoot: string
let subdir: string
let originalCwd: string

beforeAll(() => {
  originalCwd = process.cwd()
  // realpath: on macOS /var is a symlink to /private/var, and process.cwd()
  // reports the resolved form.
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'qb-workspace-')))
  subdir = join(projectRoot, 'apps', 'api', 'src')
  mkdirSync(subdir, { recursive: true })
  mkdirSync(join(projectRoot, 'database', 'migrations'), { recursive: true })
  writeFileSync(join(projectRoot, 'package.json'), '{"name":"workspace-fixture"}')
})

afterAll(() => {
  process.chdir(originalCwd)
  rmSync(projectRoot, { recursive: true, force: true })
})

describe('workspace resolution', () => {
  it('finds the project root from the project root', () => {
    process.chdir(projectRoot)
    expect(findWorkspaceRoot()).toBe(projectRoot)
  })

  it('finds the project root from a subdirectory', () => {
    process.chdir(subdir)
    expect(findWorkspaceRoot()).toBe(projectRoot)
  })

  it('resolves the same migrations directory from either place', () => {
    process.chdir(projectRoot)
    const fromRoot = getSqlDirectory()
    process.chdir(subdir)
    const fromSubdir = getSqlDirectory()

    expect(fromSubdir).toBe(fromRoot)
    expect(fromSubdir).toBe(join(projectRoot, 'database', 'migrations'))
  })

  it('treats a directory with no package.json above it as its own workspace', () => {
    // A scratch folder or test fixture is still a workspace; falling back to
    // the working directory keeps those usable.
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'qb-bare-')))
    process.chdir(bare)
    try {
      // `/tmp` may sit under a package.json on some machines, so assert the
      // contract rather than the exact path: whatever root is chosen, the SQL
      // directory hangs off it.
      expect(getSqlDirectory()).toBe(join(findWorkspaceRoot(), 'database', 'migrations'))
    }
    finally {
      process.chdir(originalCwd)
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('honours an explicitly passed root', () => {
    process.chdir(subdir)
    expect(getSqlDirectory('/somewhere/else')).toBe(join('/somewhere/else', 'database', 'migrations'))
  })
})
