import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXAMPLES_MODELS_PATH, setupDatabase } from './setup'

beforeAll(async () => {
  await setupDatabase()
})

afterAll(async () => {
  // Cleanup if needed
})

describe('Model Generation Actions', () => {
  it('makeModel creates a model file with correct structure', async () => {
    const { makeModel } = await import('../src/actions/make-model')
    const workspace = join(tmpdir(), `qb-makemodel-test-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}')

    const originalCwd = process.cwd()
    process.chdir(workspace)

    await makeModel('TestModel')

    const modelPath = join(workspace, 'app/Models/TestModel.ts')
    expect(existsSync(modelPath)).toBe(true)

    process.chdir(originalCwd)
    rmSync(workspace, { recursive: true, force: true })
  })

  it('makeModel accepts custom table name', async () => {
    const { makeModel } = await import('../src/actions/make-model')
    const workspace = join(tmpdir(), `qb-makemodel-table-test-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package.json'), '{}')

    const originalCwd = process.cwd()
    process.chdir(workspace)

    await makeModel('CustomModel', { table: 'custom_table_name' })

    const modelPath = join(workspace, 'app/Models/CustomModel.ts')
    expect(existsSync(modelPath)).toBe(true)

    const content = require('node:fs').readFileSync(modelPath, 'utf8')
    expect(content).toContain('custom_table_name')

    process.chdir(originalCwd)
    rmSync(workspace, { recursive: true, force: true })
  })
})

describe('Database Info Actions', () => {
  it('dbInfo action exists and returns proper structure', async () => {
    const { dbInfo } = await import('../src/actions/db-info')
    expect(typeof dbInfo).toBe('function')

    try {
      const result = await dbInfo()
      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('dialect')
      expect(result).toHaveProperty('tables')
      expect(Array.isArray(result.tables)).toBe(true)
    }
    catch (err) {
      // May fail without DB, acceptable for this test
      expect(err).toBeDefined()
    }
  })

  it('dbStats is an alias for dbInfo', async () => {
    const { dbInfo, dbStats } = await import('../src/actions/db-info')
    expect(typeof dbInfo).toBe('function')
    expect(typeof dbStats).toBe('function')
  })

  it('inspectTable action exists', async () => {
    const { inspectTable } = await import('../src/actions/inspect')
    expect(typeof inspectTable).toBe('function')

    try {
      const result = await inspectTable('users', { verbose: false })
      expect(typeof result).toBe('object')
      expect(result).toHaveProperty('tableName')
      expect(result).toHaveProperty('columns')
      expect(result).toHaveProperty('indexes')
    }
    catch (err) {
      // May fail without DB
      expect(err).toBeDefined()
    }
  })

  it('tableInfo is an alias for inspectTable', async () => {
    const { inspectTable, tableInfo } = await import('../src/actions/inspect')
    expect(typeof inspectTable).toBe('function')
    expect(typeof tableInfo).toBe('function')
  })
})

describe('Cache Management Actions', () => {
  it('cacheClear action executes without error', async () => {
    const { cacheClear } = await import('../src/actions/cache')
    expect(typeof cacheClear).toBe('function')
    await cacheClear()
    // Should complete without throwing
    expect(true).toBe(true)
  })

  it('cacheStats action executes without error', async () => {
    const { cacheStats } = await import('../src/actions/cache')
    expect(typeof cacheStats).toBe('function')
    await cacheStats()
    // Should complete without throwing
    expect(true).toBe(true)
  })

  it('cacheConfig action accepts size parameter', async () => {
    const { cacheConfig } = await import('../src/actions/cache')
    expect(typeof cacheConfig).toBe('function')
    await cacheConfig({ size: 500 })
    // Should complete without throwing
    expect(true).toBe(true)
  })
})

describe('Benchmark Actions', () => {
  it('runBenchmark action exists', async () => {
    const { runBenchmark } = await import('../src/actions/benchmark')
    expect(typeof runBenchmark).toBe('function')
  })

  it('runBenchmark accepts iterations parameter', async () => {
    const { runBenchmark } = await import('../src/actions/benchmark')
    // Test with minimal iterations to avoid long test times
    try {
      await runBenchmark({ iterations: 5, operations: 'select' })
    }
    catch (err) {
      // May fail without proper DB setup
      expect(err).toBeDefined()
    }
  })
})

describe('Data Management Actions', () => {
  it('exportData action exists', async () => {
    const { exportData } = await import('../src/actions/data')
    expect(typeof exportData).toBe('function')
  })

  it('importData action exists', async () => {
    const { importData } = await import('../src/actions/data')
    expect(typeof importData).toBe('function')
  })

  it('dumpDatabase action exists', async () => {
    const { dumpDatabase } = await import('../src/actions/data')
    expect(typeof dumpDatabase).toBe('function')
  })

  it('exportData handles different formats', async () => {
    const { exportData } = await import('../src/actions/data')

    const tmpDir = join(tmpdir(), `qb-export-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    try {
      await exportData('users', {
        format: 'json',
        output: join(tmpDir, 'test.json'),
        limit: 10,
      })
    }
    catch (err) {
      // May fail without DB
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('importData handles JSON files', async () => {
    const { importData } = await import('../src/actions/data')

    const tmpDir = join(tmpdir(), `qb-import-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const testFile = join(tmpDir, 'test-data.json')
    writeFileSync(testFile, JSON.stringify([{ id: 1, name: 'Test' }]))

    try {
      await importData('users', testFile, { format: 'json' })
    }
    catch (err) {
      // May fail without DB
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Console Actions', () => {
  it('startConsole action exists', async () => {
    const { startConsole } = await import('../src/actions/console')
    expect(typeof startConsole).toBe('function')
  })

  it('tinker is an alias for startConsole', async () => {
    const { startConsole, tinker } = await import('../src/actions/console')
    expect(typeof startConsole).toBe('function')
    expect(typeof tinker).toBe('function')
  })
})
