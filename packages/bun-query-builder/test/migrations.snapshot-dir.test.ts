import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config, defaultConfig } from '../src/config'

/**
 * The snapshot defaults to `.qb` at the workspace root. That is fine for a
 * standalone project, but an application that already has a home for generated
 * state should not get a dot-directory in its root as well, so the location is
 * configurable.
 */

let workspace: string
let original: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'qb-snapshot-dir-'))
  original = config.snapshotDir
})

afterEach(() => {
  config.snapshotDir = original
  rmSync(workspace, { recursive: true, force: true })
})

describe('snapshotDir', () => {
  it('defaults to .qb, so existing projects are unaffected', () => {
    expect(defaultConfig.snapshotDir).toBe('.qb')
  })

  it('writes the snapshot under the configured directory, not .qb', async () => {
    config.snapshotDir = 'storage/framework/database'

    const { saveMigrationSnapshot } = await import('../src/actions/migrate')
    saveMigrationSnapshot({ dialect: 'postgres', statements: [] } as any, { workspaceRoot: workspace })

    expect(existsSync(join(workspace, 'storage/framework/database/model-snapshot.postgres.json'))).toBe(true)
    // The whole point: nothing lands in the project root.
    expect(existsSync(join(workspace, '.qb'))).toBe(false)
  })

  it('still writes to .qb when left at the default', async () => {
    config.snapshotDir = '.qb'

    const { saveMigrationSnapshot } = await import('../src/actions/migrate')
    saveMigrationSnapshot({ dialect: 'postgres', statements: [] } as any, { workspaceRoot: workspace })

    expect(existsSync(join(workspace, '.qb/model-snapshot.postgres.json'))).toBe(true)
  })

  it('creates a nested directory that does not exist yet', async () => {
    config.snapshotDir = 'storage/framework/database/deeply/nested'

    const { saveMigrationSnapshot } = await import('../src/actions/migrate')
    saveMigrationSnapshot({ dialect: 'sqlite', statements: [] } as any, { workspaceRoot: workspace })

    expect(existsSync(join(workspace, 'storage/framework/database/deeply/nested/model-snapshot.sqlite.json'))).toBe(true)
  })

  it('accepts a nested path without requiring it to pre-exist', () => {
    config.snapshotDir = 'storage/framework/database'

    // The directory is created on demand; nothing here should have to mkdir.
    expect(existsSync(join(workspace, 'storage/framework/database'))).toBe(false)
    expect(config.snapshotDir).toBe('storage/framework/database')
  })
})
