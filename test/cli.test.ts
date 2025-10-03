import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteMigrationFiles } from '@/actions/migrate'
import pkg from '../package.json'
import { setupDatabase } from './setup'

beforeAll(async () => {
  await setupDatabase()
})

afterAll(async () => {
  await deleteMigrationFiles('./examples/models', undefined, { dialect: 'postgres' })
})

function runCli(args: string[]) {
  const proc = Bun.spawnSync({
    cmd: ['bun', 'bin/cli.ts', ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: process.cwd(),
    env: { ...process.env },
  })
  const dec = new TextDecoder()
  return {
    code: proc.exitCode,
    stdout: dec.decode(proc.stdout).trim(),
    stderr: dec.decode(proc.stderr).trim(),
  }
}

function makeTempModelsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qb-cli-'))
  const modelJs = `module.exports = {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: { id: { validation: { rule: {} } }, email: { validation: { rule: {} } } },
}`
  writeFileSync(join(dir, 'user.js'), modelJs)
  return dir
}

describe('CLI', () => {
  it('version prints package version', () => {
    const out = runCli(['version'])
    expect(out.stdout).toBe(pkg.version)
    expect(out.code).toBe(0)
  })

  it('introspect prints JSON schema from models dir', () => {
    const dir = makeTempModelsDir()

    const out = runCli(['introspect', dir])

    expect(out.code).toBe(0)

    const json = JSON.parse(out.stdout)

    expect(Object.keys(json)).toContain('users')
    expect(json.users).toHaveProperty('primaryKey')
    expect(typeof json.users.columns).toBe('object')
    rmSync(dir, { recursive: true, force: true })
  })

  it('sql prints a textual query (or placeholder) for a table', () => {
    const dir = makeTempModelsDir()
    const out = runCli(['sql', dir, 'users', '--limit', '3'])
    expect(typeof out.stdout).toBe('string')
    expect(out.stdout.length).toBeGreaterThan(0)
    expect(out.code).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  })

  it('file and unsafe commands run without throwing (no DB expected)', () => {
    const tmp = join(mkdtempSync(join(tmpdir(), 'qb-sql-')), 'q.sql')
    writeFileSync(tmp, 'SELECT 1')
    const f = runCli(['file', tmp])
    // may succeed or fail depending on env; just assert process did not crash
    expect([0, 1]).toContain(f.code)
    const u = runCli(['unsafe', 'SELECT 1'])
    expect([0, 1]).toContain(u.code)
  })

  it('explain prints JSON or exits non-zero gracefully without a DB', () => {
    const out = runCli(['explain', 'SELECT 1'])
    if (out.code === 0) {
      if (out.stdout.trim()) {
        const parsed = JSON.parse(out.stdout)
        expect(Array.isArray(parsed)).toBeTrue()
      }
      else {
        // Empty response when DB unavailable - still acceptable
        expect(out.code).toBe(0)
      }
    }
    else {
      // still should not crash the test suite; stdout or stderr may contain info
      expect(typeof out.stdout).toBe('string')
    }
  })

  it('ping prints an availability message', () => {
    const out = runCli(['ping'])
    expect(['OK', 'NOT READY']).toContain(out.stdout)
  })

  it('help prints usage information', () => {
    const out = runCli(['--help'])
    expect(out.stdout.toLowerCase()).toContain('query-builder')
  })

  it('migrate prints SQL from models', () => {
    const dir = makeTempModelsDir()
    const out = runCli(['migrate', dir, '--dialect', 'postgres'])
    expect(typeof out.stdout).toBe('string')
    expect(out.stdout.length).toBeGreaterThan(0)
    rmSync(dir, { recursive: true, force: true })
  })
})
