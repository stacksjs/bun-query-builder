import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'

const packageRoot = resolve(import.meta.dir, '..')
const rootEntry = join(packageRoot, 'dist/src/index.js')
const runtimeEntry = join(packageRoot, 'dist/src/runtime.js')

function runProbe(source: string): { exitCode: number, output: string, stderr: string, stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qb-runtime-entry-'))
  const script = join(dir, 'probe.ts')
  const resultPath = join(dir, 'result.json')
  writeFileSync(script, `${source}\nawait Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(result))\n`)
  const proc = Bun.spawnSync({
    cmd: [process.execPath, '--no-env-file', script],
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
  })
  const probe = {
    exitCode: proc.exitCode,
    output: existsSync(resultPath) ? readFileSync(resultPath, 'utf8').trim() : '',
    stderr: proc.stderr.toString().trim(),
    stdout: proc.stdout.toString().trim(),
  }
  rmSync(dir, { recursive: true, force: true })
  return probe
}

describe('runtime package entry', () => {
  it('publishes JavaScript and declaration paths', async () => {
    const manifest = await Bun.file(join(packageRoot, 'package.json')).json()
    expect(manifest.exports['./runtime']).toEqual({
      types: './dist/runtime.d.ts',
      import: './dist/src/runtime.js',
    })
  })

  describe('built output', () => {
    it('matches the root entry for SQLite reads and writes', () => {
      const outputs = [rootEntry, runtimeEntry].map((entry) => {
        const probe = runProbe(`
import * as queryBuilder from ${JSON.stringify(entry)}
queryBuilder.setConfig({ dialect: 'sqlite', database: { database: ':memory:' } })
queryBuilder.resetConnection()
const db = queryBuilder.createQueryBuilder()
await db.unsafe('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
await db.unsafe('INSERT INTO items (id, name) VALUES (?, ?)', [41, 'runtime'])
const rows = await db.unsafe('SELECT id, name FROM items')
await db.close()
queryBuilder.resetConnection()
const result = rows
`)
        expect(probe.exitCode, `SQLite parity probe failed for ${entry}.\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`).toBe(0)
        return probe.output
      })
      expect(outputs).toEqual([
        JSON.stringify([{ id: 41, name: 'runtime' }]),
        JSON.stringify([{ id: 41, name: 'runtime' }]),
      ])
    })

    it('shares request-time state across root and runtime imports', () => {
      const probe = runProbe(`
import * as runtime from ${JSON.stringify(runtimeEntry)}
import * as root from ${JSON.stringify(rootEntry)}
if (root.config !== runtime.config) throw new Error('config is duplicated')
if (root.createQueryBuilder !== runtime.createQueryBuilder) throw new Error('client is duplicated')
runtime.setConfig({ dialect: 'sqlite', database: { database: ':memory:' }, verbose: true })
root.resetConnection()
const runtimeDb = runtime.createQueryBuilder()
await runtimeDb.unsafe('CREATE TABLE shared_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
await runtimeDb.unsafe("INSERT INTO shared_items (id, name) VALUES (41, 'shared')")
const rootDb = root.createQueryBuilder()
const rows = await rootDb.unsafe('SELECT id, name FROM shared_items')
root.setConfig({ verbose: false })
if (runtime.config.verbose !== false) throw new Error('config update is not shared')
runtime.resetConnection()
let resetCreatedFreshConnection = false
const freshDb = runtime.createQueryBuilder()
try {
  await freshDb.unsafe('SELECT id FROM shared_items')
}
catch {
  resetCreatedFreshConnection = true
}
await freshDb.close()
root.resetConnection()
const result = { rows, dialect: runtime.config.dialect, resetCreatedFreshConnection }
`)
      expect(probe.exitCode, `shared-state probe failed.\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`).toBe(0)
      expect(probe.output).toBe(JSON.stringify({
        rows: [{ id: 41, name: 'shared' }],
        dialect: 'sqlite',
        resetCreatedFreshConnection: true,
      }))
    })
  })
})
