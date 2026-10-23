import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test'

/*
 * Raised from bun:test's 5000ms default, which this file is not slow enough to
 * need and was failing against anyway.
 *
 * Every case here does real I/O — spawns the compiled CLI as a child process — so its duration tracks machine load
 * rather than the code under test. Normally about 295ms per test, 64 of them. Under load these crossed
 * the line and failed at 5001–5242ms, and the failing SET changed from run to
 * run, which is the signature of a budget rather than a bug: the runs that
 * produced them took 126–199s against a ~35s baseline.
 *
 * 30s absorbs that inflation while staying bounded enough that a genuine hang
 * fails instead of stalling CI. It governs hooks as well as test bodies, which
 * matters because a timed-out `beforeAll` fails the whole file rather than one
 * case — that is how one slow run here took out the next file too.
 *
 * Deliberately per-file rather than `--timeout` on the test script: that would
 * raise the budget for all 2552 tests, including the pure unit ones where
 * 5000ms is a useful signal that something is wrong.
 */
setDefaultTimeout(30_000)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deleteMigrationFiles } from '@/actions/migrate'
import pkg from '../package.json'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

// Store the test directory root for CLI path resolution
const TEST_ROOT = resolve(__dirname, '..')
const CLI_PATH = join(TEST_ROOT, 'bin/qbx')

beforeAll(async () => {
  await setupDatabase()
})

afterAll(async () => {
  await deleteMigrationFiles(EXAMPLES_MODELS_PATH, undefined, { dialect: 'postgres' })
})

/**
 * Run the compiled CLI and return its exit code and captured output.
 *
 * One process. This used to be two: it wrote a runner script to a temp dir,
 * spawned Bun to execute it, had that process `Bun.spawnSync` the CLI and write
 * the result to a JSON file, then read the file back and deleted the directory.
 * Every one of the 64 tests here paid a whole extra Bun startup plus a
 * filesystem round-trip for it, under bun:test's default 5000ms budget and with
 * no explicit timeout anywhere in the file.
 *
 * That is what made this the suite's flakiest file. Under load the budget
 * killed the OUTER process mid-flight, so the failure surfaced as
 * `CLI test runner exited null` - a message about the harness, naming neither
 * the command nor the timeout - and `bin/qbx --version` was never the thing
 * that was slow.
 *
 * The indirection bought nothing. It arrived in 8b227d0, the commit that also
 * switched CLI_PATH from `bin/cli.ts` to the compiled `bin/qbx`, with a
 * one-line message and no comment, so it reads as scaffolding for that switch
 * rather than a workaround: `bin/qbx` is a native executable, and node's
 * `spawnSync` runs it directly from inside bun:test without complaint.
 *
 * `status` is null when a signal killed the process, which no longer happens
 * here but would otherwise be reported as a passing exit code by callers that
 * check `[0, 1]`, so it is surfaced rather than coerced.
 */
function runCli(args: string[]): { code: number | null, stdout: string, stderr: string } {
  const out = spawnSync(CLI_PATH, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env },
  })

  // ENOENT means nobody built the CLI. Worth separating from a non-zero exit:
  // `bun run test` builds first, a bare `bun test` does not.
  if (out.error)
    throw new Error(`CLI did not run (${CLI_PATH}): ${out.error.message}. Run \`bun run build\`.`)

  if (out.signal)
    throw new Error(`CLI was killed by ${out.signal}: ${args.join(' ')}`)

  return {
    code: out.status,
    stdout: (out.stdout ?? '').trim(),
    stderr: (out.stderr ?? '').trim(),
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
      expect(existsSync(modelPath)).toBe(true)

      const content = readFileSync(modelPath, 'utf8')
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

  describe('migrate:generate command', () => {
    it('generates migration from models directory', () => {
      const dir = makeTempModelsDir()
      const out = runCli(['migrate:generate', dir, '--dialect', 'postgres'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
      rmSync(dir, { recursive: true, force: true })
    })

    it('accepts --apply option', () => {
      const dir = makeTempModelsDir()
      const out = runCli(['migrate:generate', dir, '--dialect', 'postgres', '--apply'])
      expect([0, 1]).toContain(out.code)
      rmSync(dir, { recursive: true, force: true })
    })

    it('accepts --full option', () => {
      const dir = makeTempModelsDir()
      const out = runCli(['migrate:generate', dir, '--full'])
      expect([0, 1]).toContain(out.code)
      rmSync(dir, { recursive: true, force: true })
    })

    it('accepts different dialects', () => {
      const dir = makeTempModelsDir()
      const dialects = ['postgres', 'mysql', 'sqlite']

      for (const dialect of dialects) {
        const out = runCli(['migrate:generate', dir, '--dialect', dialect])
        expect([0, 1]).toContain(out.code)
      }

      rmSync(dir, { recursive: true, force: true })
    })
  })

  describe('db:wipe command', () => {
    it('executes with --force flag', () => {
      const out = runCli(['db:wipe', '--force'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('accepts --verbose option', () => {
      const out = runCli(['db:wipe', '--force', '--verbose'])
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('accepts --dialect option', () => {
      const out = runCli(['db:wipe', '--force', '--dialect', 'postgres'])
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('handles different dialects', () => {
      const dialects = ['postgres', 'mysql', 'sqlite']

      for (const dialect of dialects) {
        const out = runCli(['db:wipe', '--force', '--dialect', dialect])
        expect([0, 1]).toContain(out.code)
      }
    })
  })

  describe('db:optimize command', () => {
    it('executes basic optimization', () => {
      const out = runCli(['db:optimize'])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('accepts --aggressive option', () => {
      const out = runCli(['db:optimize', '--aggressive'])
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('accepts --tables option', () => {
      const out = runCli(['db:optimize', '--tables', 'users,posts'])
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('accepts --verbose option', () => {
      const out = runCli(['db:optimize', '--verbose'])
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('accepts --dialect option', () => {
      const out = runCli(['db:optimize', '--dialect', 'postgres'])
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })

    it('combines multiple options', () => {
      const out = runCli(['db:optimize', '--aggressive', '--tables', 'users', '--verbose'])
      expect([0, 1]).toContain(out.code)
      expect(typeof out.stdout).toBe('string')
    })
  })

  describe('model:show command', () => {
    it('displays model information', () => {
      const workspace = join(tmpdir(), `qb-modelshow-${Date.now()}`)
      mkdirSync(join(workspace, 'app/Models'), { recursive: true })

      // Create a comprehensive model file
      const modelContent = `export default {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  timestamps: true,
  softDeletes: true,
  attributes: {
    id: { type: 'number' },
    name: { type: 'string', required: true },
    email: { type: 'string', unique: true }
  },
  relations: {
    posts: { type: 'hasMany', model: 'Post' }
  },
  scopes: {
    active: (qb) => qb.where({ active: true })
  },
  indexes: [
    { name: 'email_idx', columns: ['email'], unique: true }
  ]
}`
      writeFileSync(join(workspace, 'app/Models/User.ts'), modelContent)

      const originalCwd = process.cwd()
      process.chdir(workspace)

      const out = runCli(['model:show', 'User'])
      // May fail but should not crash
      expect([0, 1]).toContain(out.code)
      if (out.code === 0) {
        expect(out.stdout).toContain('User')
      }

      process.chdir(originalCwd)
      rmSync(workspace, { recursive: true, force: true })
    })

    it('accepts --json option', () => {
      const workspace = join(tmpdir(), `qb-modelshow-json-${Date.now()}`)
      mkdirSync(join(workspace, 'app/Models'), { recursive: true })

      const modelContent = `export default {
  name: 'Product',
  table: 'products',
  primaryKey: 'id',
  attributes: {
    id: { type: 'number' },
    name: { type: 'string' }
  }
}`
      writeFileSync(join(workspace, 'app/Models/Product.ts'), modelContent)

      const originalCwd = process.cwd()
      process.chdir(workspace)

      const out = runCli(['model:show', 'Product', '--json'])
      expect([0, 1]).toContain(out.code)

      process.chdir(originalCwd)
      rmSync(workspace, { recursive: true, force: true })
    })

    it('accepts --dir option', () => {
      const workspace = join(tmpdir(), `qb-modelshow-dir-${Date.now()}`)
      const modelsDir = join(workspace, 'custom/models')
      mkdirSync(modelsDir, { recursive: true })

      const modelContent = `export default {
  name: 'Category',
  table: 'categories',
  attributes: { id: { type: 'number' } }
}`
      writeFileSync(join(modelsDir, 'Category.ts'), modelContent)

      const out = runCli(['model:show', 'Category', '--dir', modelsDir])
      expect([0, 1]).toContain(out.code)

      rmSync(workspace, { recursive: true, force: true })
    })

    it('handles non-existent model gracefully', () => {
      const workspace = join(tmpdir(), `qb-modelshow-notfound-${Date.now()}`)
      mkdirSync(join(workspace, 'app/Models'), { recursive: true })

      const originalCwd = process.cwd()
      process.chdir(workspace)

      const out = runCli(['model:show', 'NonExistentModel'])
      expect([0, 1]).toContain(out.code)
      if (out.code === 1 || out.stderr) {
        expect(out.stdout + out.stderr).toContain('not found')
      }

      process.chdir(originalCwd)
      rmSync(workspace, { recursive: true, force: true })
    })
  })

  describe('query:explain-all command', () => {
    it('analyzes SQL files in directory', () => {
      const tmpDir = join(tmpdir(), `qb-explain-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })

      // Create multiple SQL files
      writeFileSync(join(tmpDir, 'query1.sql'), 'SELECT * FROM users WHERE active = true')
      writeFileSync(join(tmpDir, 'query2.sql'), 'SELECT COUNT(*) FROM posts')
      writeFileSync(join(tmpDir, 'query3.sql'), 'SELECT u.*, p.title FROM users u JOIN posts p ON p.user_id = u.id')

      const out = runCli(['query:explain-all', tmpDir])
      // May fail without DB but should not crash
      expect([0, 1]).toContain(out.code)

      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('analyzes single SQL file', () => {
      const tmpDir = join(tmpdir(), `qb-explain-single-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })

      const sqlFile = join(tmpDir, 'single.sql')
      writeFileSync(sqlFile, 'SELECT 1 as test')

      const out = runCli(['query:explain-all', sqlFile])
      expect([0, 1]).toContain(out.code)

      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('accepts --verbose option', () => {
      const tmpDir = join(tmpdir(), `qb-explain-verbose-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(join(tmpDir, 'test.sql'), 'SELECT 1')

      const out = runCli(['query:explain-all', tmpDir, '--verbose'])
      expect([0, 1]).toContain(out.code)

      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('accepts --json option', () => {
      const tmpDir = join(tmpdir(), `qb-explain-json-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })
      writeFileSync(join(tmpDir, 'test.sql'), 'SELECT 1')

      const out = runCli(['query:explain-all', tmpDir, '--json'])
      expect([0, 1]).toContain(out.code)

      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('handles empty directory gracefully', () => {
      const tmpDir = join(tmpdir(), `qb-explain-empty-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })

      const out = runCli(['query:explain-all', tmpDir])
      expect([0, 1]).toContain(out.code)
      if (out.code === 0) {
        expect(out.stdout).toContain('No .sql files found')
      }

      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('handles directory with non-SQL files', () => {
      const tmpDir = join(tmpdir(), `qb-explain-mixed-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })

      writeFileSync(join(tmpDir, 'test.txt'), 'not sql')
      writeFileSync(join(tmpDir, 'data.json'), '{}')
      writeFileSync(join(tmpDir, 'query.sql'), 'SELECT 1')

      const out = runCli(['query:explain-all', tmpDir])
      expect([0, 1]).toContain(out.code)

      rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('relation:diagram command', () => {
    it('generates mermaid diagram', () => {
      const dir = makeTempModelsDir()
      const out = runCli(['relation:diagram', '--dir', dir])
      // May fail but should not crash
      expect([0, 1]).toContain(out.code)
      rmSync(dir, { recursive: true, force: true })
    })

    it('generates dot diagram', () => {
      const dir = makeTempModelsDir()
      const out = runCli(['relation:diagram', '--dir', dir, '--format', 'dot'])
      expect([0, 1]).toContain(out.code)
      rmSync(dir, { recursive: true, force: true })
    })

    it('writes to output file', () => {
      const dir = makeTempModelsDir()
      const outputFile = join(tmpdir(), `diagram-${Date.now()}.mmd`)

      const out = runCli(['relation:diagram', '--dir', dir, '--output', outputFile])
      expect([0, 1]).toContain(out.code)

      // Clean up
      rmSync(dir, { recursive: true, force: true })
      if (existsSync(outputFile)) {
        rmSync(outputFile, { force: true })
      }
    })

    it('accepts --verbose option', () => {
      const dir = makeTempModelsDir()
      const out = runCli(['relation:diagram', '--dir', dir, '--verbose'])
      expect([0, 1]).toContain(out.code)
      rmSync(dir, { recursive: true, force: true })
    })

    it('generates diagram with different formats and options', () => {
      const dir = makeTempModelsDir()

      // Test mermaid with output
      const mermaidOut = join(tmpdir(), `schema-${Date.now()}.mmd`)
      const out1 = runCli(['relation:diagram', '--dir', dir, '--format', 'mermaid', '--output', mermaidOut])
      expect([0, 1]).toContain(out1.code)

      // Test dot with output
      const dotOut = join(tmpdir(), `schema-${Date.now()}.dot`)
      const out2 = runCli(['relation:diagram', '--dir', dir, '--format', 'dot', '--output', dotOut])
      expect([0, 1]).toContain(out2.code)

      // Clean up
      rmSync(dir, { recursive: true, force: true })
      if (existsSync(mermaidOut))
        rmSync(mermaidOut, { force: true })
      if (existsSync(dotOut))
        rmSync(dotOut, { force: true })
    })

    it('handles models with relations', () => {
      const workspace = join(tmpdir(), `qb-diagram-relations-${Date.now()}`)
      mkdirSync(workspace, { recursive: true })

      // Create models with relations
      const userModel = `export default {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: { id: { type: 'number' }, name: { type: 'string' } },
  relations: {
    posts: { type: 'hasMany', model: 'Post' },
    profile: { type: 'hasOne', model: 'Profile' }
  }
}`
      const postModel = `export default {
  name: 'Post',
  table: 'posts',
  primaryKey: 'id',
  attributes: { id: { type: 'number' }, user_id: { type: 'number' } },
  relations: {
    author: { type: 'belongsTo', model: 'User' }
  }
}`

      writeFileSync(join(workspace, 'User.ts'), userModel)
      writeFileSync(join(workspace, 'Post.ts'), postModel)

      const out = runCli(['relation:diagram', '--dir', workspace])
      expect([0, 1]).toContain(out.code)

      rmSync(workspace, { recursive: true, force: true })
    })
  })
})
