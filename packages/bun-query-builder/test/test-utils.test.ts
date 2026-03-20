/**
 * Tests for the test utility helpers themselves.
 * Ensures temp dir management and file helpers work correctly.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  createTempDir,
  createTestDir,
  createTestFile,
  removeTempDir,
  withTempDir,
  withTempDirSync,
} from './test-utils'

describe('createTempDir / removeTempDir', () => {
  test('creates a directory that exists', () => {
    const dir = createTempDir('qb-test-utils-')
    expect(existsSync(dir)).toBe(true)
    removeTempDir(dir)
  })

  test('removeTempDir deletes the directory', () => {
    const dir = createTempDir('qb-test-utils-')
    expect(existsSync(dir)).toBe(true)
    removeTempDir(dir)
    expect(existsSync(dir)).toBe(false)
  })

  test('removeTempDir is safe to call on non-existent dir', () => {
    expect(() => removeTempDir('/nonexistent/path')).not.toThrow()
  })

  test('creates dirs with custom prefix', () => {
    const dir = createTempDir('qb-custom-prefix-')
    expect(dir).toContain('qb-custom-prefix-')
    removeTempDir(dir)
  })
})

describe('withTempDir', () => {
  test('provides a temp dir to the callback', async () => {
    let capturedDir = ''
    await withTempDir('qb-with-', async (dir) => {
      capturedDir = dir
      expect(existsSync(dir)).toBe(true)
    })
    expect(existsSync(capturedDir)).toBe(false)
  })

  test('cleans up even when callback throws', async () => {
    let capturedDir = ''
    try {
      await withTempDir('qb-throw-', async (dir) => {
        capturedDir = dir
        throw new Error('test error')
      })
    }
    catch {
      // expected
    }
    expect(existsSync(capturedDir)).toBe(false)
  })

  test('returns the callback return value', async () => {
    const result = await withTempDir('qb-return-', async () => 42)
    expect(result).toBe(42)
  })
})

describe('withTempDirSync', () => {
  test('provides a temp dir synchronously', () => {
    let capturedDir = ''
    withTempDirSync('qb-sync-', (dir) => {
      capturedDir = dir
      expect(existsSync(dir)).toBe(true)
    })
    expect(existsSync(capturedDir)).toBe(false)
  })

  test('cleans up even when callback throws synchronously', () => {
    let capturedDir = ''
    try {
      withTempDirSync('qb-sync-throw-', (dir) => {
        capturedDir = dir
        throw new Error('sync error')
      })
    }
    catch {
      // expected
    }
    expect(existsSync(capturedDir)).toBe(false)
  })
})

describe('createTestFile', () => {
  test('creates a file with content', () => {
    const dir = createTempDir('qb-file-')
    const path = createTestFile(dir, 'hello.txt', 'world')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('world')
    removeTempDir(dir)
  })

  test('creates intermediate directories', () => {
    const dir = createTempDir('qb-nested-')
    const path = createTestFile(dir, 'a/b/c/deep.txt', 'deep content')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('deep content')
    removeTempDir(dir)
  })

  test('creates seeder-like file structure', () => {
    const dir = createTempDir('qb-seeder-')
    createTestFile(dir, 'database/seeders/UserSeeder.ts', 'export default class UserSeeder {}')
    expect(existsSync(join(dir, 'database/seeders/UserSeeder.ts'))).toBe(true)
    removeTempDir(dir)
  })
})

describe('createTestDir', () => {
  test('creates nested directories', () => {
    const dir = createTempDir('qb-mkdir-')
    const nested = createTestDir(dir, 'a/b/c')
    expect(existsSync(nested)).toBe(true)
    removeTempDir(dir)
  })
})

describe('withTempDir + file helpers integration', () => {
  test('full workflow: create dir, add files, verify, auto-cleanup', async () => {
    let dirPath = ''
    await withTempDir('qb-integration-', async (dir) => {
      dirPath = dir

      createTestFile(dir, 'package.json', '{"name":"test"}')
      createTestFile(dir, 'database/seeders/UserSeeder.ts', 'export default class {}')
      createTestDir(dir, 'database/migrations')

      expect(existsSync(join(dir, 'package.json'))).toBe(true)
      expect(existsSync(join(dir, 'database/seeders/UserSeeder.ts'))).toBe(true)
      expect(existsSync(join(dir, 'database/migrations'))).toBe(true)
    })

    expect(existsSync(dirPath)).toBe(false)
  })
})
