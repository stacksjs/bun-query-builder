/**
 * Regression guard for stacksjs/bun-query-builder#1043 (and #1022).
 *
 * setConfig() and the model executor must share ONE config object even in the
 * BUNDLED output — a source-level test can never catch a bundler binding-split.
 * config is now stored on a globalThis Symbol so every inlined copy shares it;
 * this guard imports the built dist in a fresh process and asserts setConfig
 * reaches the model layer.
 *
 * Skipped when dist/ hasn't been built — locally. The CI `test` job builds
 * before it tests, so there a missing dist means the build step did not run,
 * and the one guard that can see a bundler binding-split would skip on exactly
 * the run that needed it. See `gate.ts`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { gateUnavailable } from './gate'

const DIST = resolve(import.meta.dir, '../dist/src/index.js')
const distBuilt = existsSync(DIST)
  || gateUnavailable('the bundled dist', `${DIST} does not exist`, 'Run `bun run build`.')

describe.skipIf(!distBuilt)('config singleton survives bundling (#1043)', () => {
  it('setConfig reaches the model layer in the built dist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qb-dist43-'))
    const dbFile = join(dir, 'r.db')
    const script = join(dir, 'probe.ts')
    const resultPath = join(dir, 'result.json')
    writeFileSync(script, `
import { setConfig, createModel, createTableFromModel, config } from ${JSON.stringify(DIST)}
import { Database } from 'bun:sqlite'
setConfig({ dialect: 'sqlite', database: { database: ${JSON.stringify(dbFile)} } })
if (config.dialect !== 'sqlite') { console.error('config not shared'); process.exit(1) }
const M = createModel({ name: 'D43', table: 'd43', primaryKey: 'id', autoIncrement: true, attributes: { name: { type: 'string', fillable: true } } })
await createTableFromModel(M.getDefinition())
await M.create({ name: 'ok' })
const rows = new Database(${JSON.stringify(dbFile)}).query('SELECT name FROM d43').all()
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(rows))
`)
    const proc = Bun.spawnSync({ cmd: ['bun', script], stdout: 'pipe', stderr: 'pipe', cwd: process.cwd(), env: { ...process.env } })
    const out = readFileSync(resultPath, 'utf8').trim()
    const err = new TextDecoder().decode(proc.stderr).trim()
    rmSync(dir, { recursive: true, force: true })
    expect(proc.exitCode, `dist config-routing failed.\nstdout: ${out}\nstderr: ${err}`).toBe(0)
    expect(out).toBe(JSON.stringify([{ name: 'ok' }]))
  })
})
