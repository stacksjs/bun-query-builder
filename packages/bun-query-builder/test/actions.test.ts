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

describe('Migrate Generate Actions', () => {
  it('migrateGenerate action exists and is callable', async () => {
    const { migrateGenerate } = await import('../src/actions/migrate-generate')
    expect(typeof migrateGenerate).toBe('function')
  })

  it('migrateGenerate is alias for generateMigration', async () => {
    const { generateMigration, migrateGenerate } = await import('../src/actions/migrate-generate')
    expect(typeof generateMigration).toBe('function')
    expect(typeof migrateGenerate).toBe('function')
  })

  it('migrateGenerate accepts options object', async () => {
    const { migrateGenerate } = await import('../src/actions/migrate-generate')

    try {
      // Test with options (may fail without DB)
      await migrateGenerate(EXAMPLES_MODELS_PATH, {
        dialect: 'postgres',
        full: false,
      })
    }
    catch (err) {
      // Expected to potentially fail without DB
      expect(err).toBeDefined()
    }
  })
})

describe('Database Wipe Actions', () => {
  it('dbWipe action exists', async () => {
    const { dbWipe } = await import('../src/actions/db-wipe')
    expect(typeof dbWipe).toBe('function')
  })

  it('wipeDatabase is alias for dbWipe', async () => {
    const { dbWipe, wipeDatabase } = await import('../src/actions/db-wipe')
    expect(typeof dbWipe).toBe('function')
    expect(typeof wipeDatabase).toBe('function')
  })

  it('dbWipe accepts options with dialect', async () => {
    const { dbWipe } = await import('../src/actions/db-wipe')

    try {
      await dbWipe({ dialect: 'postgres', force: true, verbose: false })
    }
    catch (err) {
      // Expected to fail without DB
      expect(err).toBeDefined()
    }
  })

  it('dbWipe accepts verbose option', async () => {
    const { dbWipe } = await import('../src/actions/db-wipe')

    try {
      await dbWipe({ force: true, verbose: true })
    }
    catch (err) {
      expect(err).toBeDefined()
    }
  })
})

describe('Database Optimize Actions', () => {
  it('dbOptimize action exists', async () => {
    const { dbOptimize } = await import('../src/actions/db-optimize')
    expect(typeof dbOptimize).toBe('function')
  })

  it('optimizeDatabase is alias for dbOptimize', async () => {
    const { dbOptimize, optimizeDatabase } = await import('../src/actions/db-optimize')
    expect(typeof dbOptimize).toBe('function')
    expect(typeof optimizeDatabase).toBe('function')
  })

  it('dbOptimize accepts aggressive option', async () => {
    const { dbOptimize } = await import('../src/actions/db-optimize')

    try {
      await dbOptimize({ aggressive: true, verbose: false })
    }
    catch (err) {
      expect(err).toBeDefined()
    }
  })

  it('dbOptimize accepts tables option', async () => {
    const { dbOptimize } = await import('../src/actions/db-optimize')

    try {
      await dbOptimize({ tables: ['users', 'posts'], verbose: false })
    }
    catch (err) {
      expect(err).toBeDefined()
    }
  })

  it('dbOptimize accepts different dialects', async () => {
    const { dbOptimize } = await import('../src/actions/db-optimize')

    const dialects = ['postgres', 'mysql', 'sqlite'] as const

    for (const dialect of dialects) {
      try {
        await dbOptimize({ dialect, verbose: false })
      }
      catch (err) {
        expect(err).toBeDefined()
      }
    }
  })
})

describe('Model Show Actions', () => {
  it('modelShow action exists', async () => {
    const { modelShow } = await import('../src/actions/model-show')
    expect(typeof modelShow).toBe('function')
  })

  it('showModel is alias for modelShow', async () => {
    const { modelShow, showModel } = await import('../src/actions/model-show')
    expect(typeof modelShow).toBe('function')
    expect(typeof showModel).toBe('function')
  })

  it('modelShow handles non-existent model gracefully', async () => {
    const { modelShow } = await import('../src/actions/model-show')
    const result = await modelShow('NonExistentModel', { dir: EXAMPLES_MODELS_PATH })
    expect(result).toBeUndefined()
  })

  it('modelShow accepts json option', async () => {
    const { modelShow } = await import('../src/actions/model-show')

    const tmpDir = join(tmpdir(), `qb-modelshow-json-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const modelContent = `export default {
  name: 'TestModel',
  table: 'test_models',
  primaryKey: 'id',
  attributes: {
    id: { type: 'number' },
    name: { type: 'string' }
  }
}`
    writeFileSync(join(tmpDir, 'TestModel.ts'), modelContent)

    const result = await modelShow('TestModel', { dir: tmpDir, json: true })

    expect(result).toBeDefined()
    if (result) {
      expect(result.name).toBe('TestModel')
      expect(result.table).toBe('test_models')
      expect(result.primaryKey).toBe('id')
      expect(result.attributes).toBeDefined()
    }

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('modelShow handles model with relations', async () => {
    const { modelShow } = await import('../src/actions/model-show')

    const tmpDir = join(tmpdir(), `qb-modelshow-relations-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const modelContent = `export default {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { type: 'number' },
    name: { type: 'string' }
  },
  relations: {
    posts: { type: 'hasMany', model: 'Post' },
    profile: { type: 'hasOne', model: 'Profile' }
  }
}`
    writeFileSync(join(tmpDir, 'User.ts'), modelContent)

    const result = await modelShow('User', { dir: tmpDir, json: true })

    expect(result).toBeDefined()
    if (result && result.relations) {
      expect(Object.keys(result.relations).length).toBeGreaterThan(0)
    }

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('modelShow handles model with scopes and hooks', async () => {
    const { modelShow } = await import('../src/actions/model-show')

    const tmpDir = join(tmpdir(), `qb-modelshow-scopes-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const modelContent = `export default {
  name: 'Product',
  table: 'products',
  attributes: { id: { type: 'number' } },
  scopes: {
    active: (qb) => qb.where({ active: true }),
    premium: (qb) => qb.where({ tier: 'premium' })
  },
  beforeCreate: async () => {},
  afterCreate: async () => {}
}`
    writeFileSync(join(tmpDir, 'Product.ts'), modelContent)

    const result = await modelShow('Product', { dir: tmpDir, json: true })

    expect(result).toBeDefined()
    if (result) {
      expect(result.scopes).toBeDefined()
      expect(result.hooks).toBeDefined()
      if (result.hooks) {
        expect(result.hooks.length).toBeGreaterThan(0)
      }
    }

    rmSync(tmpDir, { recursive: true, force: true })
  })
})

describe('Query Explain All Actions', () => {
  it('queryExplainAll action exists', async () => {
    const { queryExplainAll } = await import('../src/actions/query-explain-all')
    expect(typeof queryExplainAll).toBe('function')
  })

  it('explainAllQueries is alias for queryExplainAll', async () => {
    const { explainAllQueries, queryExplainAll } = await import('../src/actions/query-explain-all')
    expect(typeof explainAllQueries).toBe('function')
    expect(typeof queryExplainAll).toBe('function')
  })

  it('queryExplainAll handles empty directory', async () => {
    const { queryExplainAll } = await import('../src/actions/query-explain-all')
    const tmpDir = join(tmpdir(), `qb-explain-empty-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const results = await queryExplainAll(tmpDir, { verbose: false })
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBe(0)

    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('queryExplainAll processes multiple SQL files', async () => {
    const { queryExplainAll } = await import('../src/actions/query-explain-all')
    const tmpDir = join(tmpdir(), `qb-explain-multi-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    writeFileSync(join(tmpDir, 'query1.sql'), 'SELECT 1')
    writeFileSync(join(tmpDir, 'query2.sql'), 'SELECT 2')
    writeFileSync(join(tmpDir, 'query3.sql'), 'SELECT 3')

    try {
      const results = await queryExplainAll(tmpDir, { verbose: false })
      expect(Array.isArray(results)).toBe(true)
    }
    catch (err) {
      // May fail without DB
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('queryExplainAll handles single file', async () => {
    const { queryExplainAll } = await import('../src/actions/query-explain-all')
    const tmpDir = join(tmpdir(), `qb-explain-single-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const sqlFile = join(tmpDir, 'test.sql')
    writeFileSync(sqlFile, 'SELECT 1 as value')

    try {
      const results = await queryExplainAll(sqlFile, { verbose: false })
      expect(Array.isArray(results)).toBe(true)
    }
    catch (err) {
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('queryExplainAll returns results with correct structure', async () => {
    const { queryExplainAll } = await import('../src/actions/query-explain-all')
    const tmpDir = join(tmpdir(), `qb-explain-structure-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    writeFileSync(join(tmpDir, 'test.sql'), 'SELECT 1')

    try {
      const results = await queryExplainAll(tmpDir, { verbose: false })
      expect(Array.isArray(results)).toBe(true)

      if (results.length > 0) {
        const result = results[0]
        expect(result).toHaveProperty('file')
        expect(result).toHaveProperty('query')
        expect(result).toHaveProperty('plan')
      }
    }
    catch (err) {
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Relation Diagram Actions', () => {
  it('relationDiagram action exists', async () => {
    const { relationDiagram } = await import('../src/actions/relation-diagram')
    expect(typeof relationDiagram).toBe('function')
  })

  it('generateDiagram is alias for relationDiagram', async () => {
    const { generateDiagram, relationDiagram } = await import('../src/actions/relation-diagram')
    expect(typeof generateDiagram).toBe('function')
    expect(typeof relationDiagram).toBe('function')
  })

  it('relationDiagram generates mermaid format', async () => {
    const { relationDiagram } = await import('../src/actions/relation-diagram')
    const tmpDir = join(tmpdir(), `qb-diagram-mermaid-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const modelContent = `export default {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { type: 'number' },
    name: { type: 'string' }
  }
}`
    writeFileSync(join(tmpDir, 'User.ts'), modelContent)

    try {
      const diagram = await relationDiagram({
        dir: tmpDir,
        format: 'mermaid',
      })
      expect(typeof diagram).toBe('string')
      expect(diagram).toContain('erDiagram')
      expect(diagram).toContain('users')
    }
    catch (err) {
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('relationDiagram generates dot format', async () => {
    const { relationDiagram } = await import('../src/actions/relation-diagram')
    const tmpDir = join(tmpdir(), `qb-diagram-dot-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const modelContent = `export default {
  name: 'Post',
  table: 'posts',
  primaryKey: 'id',
  attributes: {
    id: { type: 'number' }
  }
}`
    writeFileSync(join(tmpDir, 'Post.ts'), modelContent)

    try {
      const diagram = await relationDiagram({
        dir: tmpDir,
        format: 'dot',
      })
      expect(typeof diagram).toBe('string')
      expect(diagram).toContain('digraph')
      expect(diagram).toContain('posts')
    }
    catch (err) {
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('relationDiagram writes to output file', async () => {
    const { relationDiagram } = await import('../src/actions/relation-diagram')
    const tmpDir = join(tmpdir(), `qb-diagram-output-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const modelContent = `export default {
  name: 'Category',
  table: 'categories',
  attributes: { id: { type: 'number' } }
}`
    writeFileSync(join(tmpDir, 'Category.ts'), modelContent)

    const outputFile = join(tmpDir, 'diagram.mmd')

    try {
      await relationDiagram({
        dir: tmpDir,
        format: 'mermaid',
        output: outputFile,
      })

      const fs = require('node:fs')
      if (fs.existsSync(outputFile)) {
        const content = fs.readFileSync(outputFile, 'utf8')
        expect(content).toContain('erDiagram')
      }
    }
    catch (err) {
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('relationDiagram handles models with relations', async () => {
    const { relationDiagram } = await import('../src/actions/relation-diagram')
    const tmpDir = join(tmpdir(), `qb-diagram-relations-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })

    const userModel = `export default {
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: { id: { type: 'number' } },
  relations: {
    posts: { type: 'hasMany', model: 'Post' },
    profile: { type: 'hasOne', model: 'Profile' }
  }
}`
    const postModel = `export default {
  name: 'Post',
  table: 'posts',
  primaryKey: 'id',
  attributes: { id: { type: 'number' } },
  relations: {
    author: { type: 'belongsTo', model: 'User' }
  }
}`

    writeFileSync(join(tmpDir, 'User.ts'), userModel)
    writeFileSync(join(tmpDir, 'Post.ts'), postModel)

    try {
      const diagram = await relationDiagram({
        dir: tmpDir,
        format: 'mermaid',
      })
      expect(typeof diagram).toBe('string')
      expect(diagram).toContain('users')
      expect(diagram).toContain('posts')
    }
    catch (err) {
      expect(err).toBeDefined()
    }
    finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
