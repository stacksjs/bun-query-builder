/**
 * Regression tests for stacksjs/bun-query-builder#1022.
 *
 * #1022 reported that `setConfig()` had no effect on the model layer — model
 * queries hit a hardcoded default connection and, when it failed, silently
 * fell back to in-memory SQLite (producing misleading "no such table"
 * errors). The headline symptom was resolved by #1021 (the model layer now
 * routes through the configured dialect). These tests guard the two pieces
 * that close #1022:
 *
 *  1. `getBunSql()` must FAIL LOUDLY for non-sqlite dialects instead of
 *     silently swapping in an empty in-memory SQLite database.
 *  2. `setConfig()` must actually reach the model executor — verified in a
 *     fresh process so it can't be masked by `configureOrm`'s global override
 *     or a cached connection from another test file. This would have caught
 *     the original #1021 routing bug.
 */

import { describe, expect, it, afterEach, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { config } from '../src/config'
import { getOrCreateBunSql, resetConnection } from '../src/db'

describe('getBunSql connection failures (#1022)', () => {
  // Full snapshot of the process-wide config so a test's mutations can't leak
  // into other test files (config is module-global).
  let snapshot: { dialect: string, verbose: boolean | undefined, database: Record<string, unknown> }
  let origConsoleError: typeof console.error
  let errorCalls: string[]

  beforeEach(() => {
    snapshot = {
      dialect: config.dialect,
      verbose: config.verbose,
      database: { ...config.database },
    }
    errorCalls = []
    origConsoleError = console.error
    console.error = (...args: unknown[]) => { errorCalls.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.error = origConsoleError
    config.dialect = snapshot.dialect as any
    config.verbose = snapshot.verbose
    for (const k of Object.keys(config.database)) delete (config.database as any)[k]
    Object.assign(config.database, snapshot.database)
    resetConnection()
  })

  it('throws for a non-sqlite dialect with an unconstructable connection instead of silently using in-memory SQLite', () => {
    // An unsupported protocol makes Bun's `new SQL(...)` throw synchronously
    // at construction — the only path that reaches getBunSql()'s catch block.
    config.dialect = 'postgres' as any
    config.verbose = false // prove the error is surfaced even when not verbose
    config.database.url = 'weird://unsupported-protocol'
    resetConnection()

    expect(() => getOrCreateBunSql(true)).toThrow()
    // Surfaced unconditionally (not gated behind verbose) — the masking that
    // caused #1022's "no such table" confusion is gone.
    expect(errorCalls.some(m => m.includes('Failed to create database connection'))).toBe(true)
  })

  it('still allows the sqlite dialect to construct without throwing', () => {
    config.dialect = 'sqlite' as any
    config.database.url = undefined
    config.database.database = ':memory:'
    resetConnection()
    // The sqlite path must never adopt the non-sqlite loud-fail behavior.
    expect(() => getOrCreateBunSql(true)).not.toThrow()
  })
})

describe('setConfig reaches the model layer (#1022 / #1021)', () => {
  let workdir: string

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'qb-1022-'))
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('routes model writes to the connection configured via setConfig (fresh process)', () => {
    // Run in a fresh process: in-process, an earlier test file may have called
    // configureOrm() (which pins the model layer to its own sqlite handle via
    // globalDb) or cached a connection, masking whether setConfig is honored.
    // A subprocess starts from clean module state, so a row landing in the
    // configured file proves the model executor used setConfig's connection.
    const dbFile = join(workdir, 'routed.db')
    const srcEntry = resolve(import.meta.dir, '../src/index.ts')
    const scriptPath = join(workdir, 'probe.ts')
    writeFileSync(scriptPath, `
import { setConfig, createModel, createTableFromModel } from ${JSON.stringify(srcEntry)}
import { Database } from 'bun:sqlite'

const file = process.argv[2]
setConfig({ dialect: 'sqlite', database: { database: file } })

const M = createModel({
  name: 'CfgProbe', table: 'cfg_probe', primaryKey: 'id', autoIncrement: true,
  attributes: { name: { type: 'string', fillable: true } },
})

await createTableFromModel(M.getDefinition())
await M.create({ name: 'routed' })

const rows = new Database(file).query('SELECT name FROM cfg_probe').all()
process.stdout.write(JSON.stringify(rows))
`)

    const proc = Bun.spawnSync({
      cmd: ['bun', scriptPath, dbFile],
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: process.cwd(),
      env: { ...process.env },
    })
    const dec = new TextDecoder()
    const stdout = dec.decode(proc.stdout).trim()
    const stderr = dec.decode(proc.stderr).trim()

    expect(proc.exitCode, `probe failed (stderr: ${stderr})`).toBe(0)
    expect(stdout).toBe(JSON.stringify([{ name: 'routed' }]))

    // And independently confirm the row really lives in the configured file —
    // not some in-memory database the model layer used instead.
    const rows = new Database(dbFile).query('SELECT name FROM cfg_probe').all()
    expect(rows).toEqual([{ name: 'routed' }])
  })
})
