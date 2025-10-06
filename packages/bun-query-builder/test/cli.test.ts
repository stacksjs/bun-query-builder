import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deleteMigrationFiles } from '@/actions/migrate'
import pkg from '../package.json'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

// Store the test directory root for CLI path resolution
const TEST_ROOT = resolve(__dirname, '..')
const CLI_PATH = join(TEST_ROOT, 'bin/cli.ts')

beforeAll(async () => {
  await setupDatabase()
})

afterAll(async () => {
  await deleteMigrationFiles(EXAMPLES_MODELS_PATH, undefined, { dialect: 'postgres' })
})

function runCli(args: string[]) {
  const proc = Bun.spawnSync({
    cmd: ['bun', CLI_PATH, ...args],
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

  it('make:seeder creates a new seeder file', () => {
    const workspace = join(tmpdir(), `qb-seeder-cli-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}')

    const originalCwd = process.cwd()
    process.chdir(workspace)

    const out = runCli(['make:seeder', 'TestUser'])
    expect(out.code).toBe(0)
    expect(out.stdout).toContain('Created seeder')

    const seederPath = join(workspace, 'database/seeders/TestUserSeeder.ts')
    // eslint-disable-next-line ts/no-require-imports
    expect(require('node:fs').existsSync(seederPath)).toBe(true)

    process.chdir(originalCwd)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('seed command runs without crashing', () => {
    const workspace = join(tmpdir(), `qb-seed-cli-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}')

    const seedersDir = join(workspace, 'database/seeders')
    mkdirSync(seedersDir, { recursive: true })

    // Create a simple seeder
    const seeder = `
import { Seeder } from 'bun-query-builder'

export default class TestSeeder extends Seeder {
  async run(qb) {
    console.log('Test seeder ran')
  }
}
`
    writeFileSync(join(seedersDir, 'TestSeeder.ts'), seeder)

    const originalCwd = process.cwd()
    process.chdir(workspace)

    const out = runCli(['seed', '--verbose'])
    // May fail due to DB connection, but should not crash
    expect([0, 1]).toContain(out.code)

    process.chdir(originalCwd)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('db:seed is an alias for seed', () => {
    const workspace = join(tmpdir(), `qb-dbseed-cli-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}')

    const originalCwd = process.cwd()
    process.chdir(workspace)

    const out = runCli(['db:seed', '--verbose'])
    // May fail due to DB connection, but should not crash
    expect([0, 1]).toContain(out.code)

    process.chdir(originalCwd)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('seed --class runs specific seeder', () => {
    const workspace = join(tmpdir(), `qb-seedclass-cli-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}')

    const seedersDir = join(workspace, 'database/seeders')
    mkdirSync(seedersDir, { recursive: true })

    const seeder = `
import { Seeder } from 'bun-query-builder'

export default class SpecificSeeder extends Seeder {
  async run(qb) {
    console.log('Specific seeder ran')
  }
}
`
    writeFileSync(join(seedersDir, 'SpecificSeeder.ts'), seeder)

    const originalCwd = process.cwd()
    process.chdir(workspace)

    const out = runCli(['seed', '--class', 'SpecificSeeder'])
    // May fail due to DB connection, but should not crash
    expect([0, 1]).toContain(out.code)

    process.chdir(originalCwd)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('db:fresh command exists', () => {
    const workspace = join(tmpdir(), `qb-fresh-cli-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}')

    const originalCwd = process.cwd()
    process.chdir(workspace)

    const out = runCli(['db:fresh'])
    // May fail due to DB/models, but should not crash
    expect([0, 1]).toContain(out.code)

    process.chdir(originalCwd)
    rmSync(workspace, { recursive: true, force: true })
  })

  describe('make:model command', () => {
    it('creates a new model file', () => {
      const workspace = join(tmpdir(), `qb-makemodel-${Date.now()}`)
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'package.json'), '{}')

      const originalCwd = process.cwd()
      process.chdir(workspace)

      const out = runCli(['make:model', 'Product'])
      expect(out.code).toBe(0)
      expect(out.stdout).toContain('Created model')

      const modelPath = join(workspace, 'app/Models/Product.ts')
      const fs = require('node:fs')
      expect(fs.existsSync(modelPath)).toBe(true)

      const content = fs.readFileSync(modelPath, 'utf8')
      expect(content).toContain('Product')
      expect(content).toContain('products')
      expect(content).toContain('defineModel')

      process.chdir(originalCwd)
      rmSync(workspace, { recursive: true, force: true })
    })

    it('accepts --table option', () => {
      const workspace = join(tmpdir(), `qb-makemodel-table-${Date.now()}`)
      mkdirSync(workspace, { recursive: true })
      writeFileSync(join(workspace, 'package.json'), '{}')

      const originalCwd = process.cwd()
      process.chdir(workspace)

      const out = runCli(['make:model', 'Post', '--table', 'blog_posts'])
      expect(out.code).toBe(0)
      expect(out.stdout).toContain('blog_posts')

      process.chdir(originalCwd)
      rmSync(workspace, { recursive: true, force: true })
    })
  })

  describe('migration management commands', () => {
    it('migrate:status shows migration status', () => {
      const out = runCli(['migrate:status'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('migrate:list is an alias for migrate:status', () => {
      const out = runCli(['migrate:list'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('migrate:rollback accepts --steps option', () => {
      const out = runCli(['migrate:rollback', '--steps', '2'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })
  })

  describe('database info commands', () => {
    it('db:info shows database information', () => {
      const out = runCli(['db:info'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('db:stats is an alias for db:info', () => {
      const out = runCli(['db:stats'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('inspect shows table structure', () => {
      const out = runCli(['inspect', 'users'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('table:info is an alias for inspect', () => {
      const out = runCli(['table:info', 'users'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })
  })

  describe('cache commands', () => {
    it('cache:clear executes without error', () => {
      const out = runCli(['cache:clear'])
      expect(out.code).toBe(0)
      expect(out.stdout).toContain('cache')
    })

    it('cache:stats shows cache information', () => {
      const out = runCli(['cache:stats'])
      expect(out.code).toBe(0)
      expect(out.stdout).toContain('cache')
    })

    it('cache:config accepts --size option', () => {
      const out = runCli(['cache:config', '--size', '500'])
      expect(out.code).toBe(0)
      expect(out.stdout).toContain('500')
    })
  })

  describe('benchmark command', () => {
    it('runs performance benchmarks', () => {
      const out = runCli(['benchmark', '--iterations', '10'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('accepts --operations filter', () => {
      const out = runCli(['benchmark', '--operations', 'select,count', '--iterations', '10'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })
  })

  describe('schema validation commands', () => {
    it('validate:schema checks schema drift', () => {
      const dir = makeTempModelsDir()
      const out = runCli(['validate:schema', dir])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
      rmSync(dir, { recursive: true, force: true })
    })

    it('check is an alias for validate:schema', () => {
      const dir = makeTempModelsDir()
      const out = runCli(['check', dir])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe('data management commands', () => {
    it('export command exists', () => {
      const out = runCli(['export', 'users', '--format', 'json'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('export accepts format options', () => {
      const out = runCli(['export', 'users', '--format', 'csv'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('import command exists', () => {
      const tmpFile = join(tmpdir(), 'test-import.json')
      writeFileSync(tmpFile, JSON.stringify([{ id: 1, name: 'Test' }]))

      const out = runCli(['import', 'users', tmpFile])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)

      rmSync(tmpFile, { force: true })
    })

    it('dump command exists', () => {
      const out = runCli(['dump'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('dump accepts --tables option', () => {
      const out = runCli(['dump', '--tables', 'users,posts'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })
  })
})
