import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteMigrationFiles, generateMigration } from '../src/actions/migrate'
import { buildMigrationPlan, hashMigrationPlan } from '../src/migrations'
import { defineModels } from '../src/schema'

/**
 * Comprehensive tests for the model snapshot system.
 *
 * The snapshot system stores the migration plan as JSON after each migration,
 * enabling incremental migrations that only include changes since the last run.
 */
describe('migrations - snapshot system', () => {
  let testWorkspace: string
  let modelsDir: string
  let snapshotDir: string

  beforeEach(() => {
    // Create a unique temporary workspace for each test
    testWorkspace = join(tmpdir(), `qb-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    modelsDir = join(testWorkspace, 'app', 'Models')
    snapshotDir = join(testWorkspace, '.qb')

    mkdirSync(modelsDir, { recursive: true })

    // Create a package.json so the workspace is detected
    writeFileSync(join(testWorkspace, 'package.json'), '{}')
  })

  afterEach(() => {
    // Clean up the temporary workspace
    try {
      rmSync(testWorkspace, { recursive: true, force: true })
    }
    catch {
      // Ignore cleanup errors
    }
  })

  // Helper to create a model file
  function createModelFile(name: string, content: string) {
    writeFileSync(join(modelsDir, `${name}.ts`), content)
  }

  // Helper to get snapshot path
  function getSnapshotPath(dialect: string = 'postgres'): string {
    return join(snapshotDir, `model-snapshot.${dialect}.json`)
  }

  // Helper to read snapshot
  function readSnapshot(dialect: string = 'postgres'): any {
    const path = getSnapshotPath(dialect)
    if (!existsSync(path))
      return null
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  // Helper to write a custom snapshot
  function writeSnapshot(content: any, dialect: string = 'postgres') {
    mkdirSync(snapshotDir, { recursive: true })
    writeFileSync(getSnapshotPath(dialect), JSON.stringify(content, null, 2))
  }

  describe('snapshot file creation', () => {
    it('creates snapshot file after first migration', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })

        expect(result.hasChanges).toBe(true)
        expect(existsSync(getSnapshotPath())).toBe(true)

        const snapshot = readSnapshot()
        expect(snapshot).not.toBeNull()
        expect(snapshot.plan).toBeDefined()
        expect(snapshot.plan.dialect).toBe('postgres')
        expect(snapshot.plan.tables).toBeArray()
        expect(snapshot.hash).toBeDefined()
        expect(snapshot.updatedAt).toBeDefined()
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('creates separate snapshot files for different dialects', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            name: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        await generateMigration(modelsDir, { dialect: 'postgres' })
        await generateMigration(modelsDir, { dialect: 'mysql' })
        await generateMigration(modelsDir, { dialect: 'sqlite' })

        expect(existsSync(getSnapshotPath('postgres'))).toBe(true)
        expect(existsSync(getSnapshotPath('mysql'))).toBe(true)
        expect(existsSync(getSnapshotPath('sqlite'))).toBe(true)

        const pgSnapshot = readSnapshot('postgres')
        const mySnapshot = readSnapshot('mysql')
        const sqSnapshot = readSnapshot('sqlite')

        expect(pgSnapshot.plan.dialect).toBe('postgres')
        expect(mySnapshot.plan.dialect).toBe('mysql')
        expect(sqSnapshot.plan.dialect).toBe('sqlite')
      }
      finally {
        process.chdir(originalCwd)
      }
    })
  })

  describe('incremental migrations', () => {
    it('generates no changes when models unchanged', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First migration - creates tables
        const first = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(first.hasChanges).toBe(true)
        expect(first.sql).toContain('CREATE TABLE')

        // Second migration - no changes
        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(false)
        expect(second.sql.toLowerCase()).toContain('no changes')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('detects new table additions', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First migration
        await generateMigration(modelsDir, { dialect: 'postgres' })

        // Add a new model
        createModelFile('Post', `
          export default {
            name: 'Post',
            table: 'posts',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              title: { validation: { rule: {} } },
              user_id: { validation: { rule: {} } },
            },
          }
        `)

        // Second migration - should only create posts table
        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(true)
        expect(second.sql).toContain('CREATE TABLE "posts"')
        // Should NOT re-create users table
        expect(second.sql).not.toContain('CREATE TABLE "users"')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('detects new column additions', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First migration
        await generateMigration(modelsDir, { dialect: 'postgres' })

        // Update model with new column
        createModelFile('User', `
          export default {
            name: 'User',
            table: 'users',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              email: { validation: { rule: {} } },
              name: { validation: { rule: {} } },
              created_at: { validation: { rule: {} } },
            },
          }
        `)

        // Second migration - should ADD columns
        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(true)
        expect(second.sql).toContain('ALTER TABLE')
        expect(second.sql).toContain('ADD COLUMN')
        expect(second.sql).toContain('"name"')
        expect(second.sql).toContain('"created_at"')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('detects column removals', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
            phone: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First migration
        await generateMigration(modelsDir, { dialect: 'postgres' })

        // Remove phone column
        createModelFile('User', `
          export default {
            name: 'User',
            table: 'users',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              email: { validation: { rule: {} } },
            },
          }
        `)

        // Second migration - should DROP column
        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(true)
        expect(second.sql).toContain('DROP COLUMN')
        expect(second.sql).toContain('"phone"')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('detects table removals', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)
      createModelFile('Post', `
        export default {
          name: 'Post',
          table: 'posts',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First migration
        await generateMigration(modelsDir, { dialect: 'postgres' })

        // Remove Post model
        rmSync(join(modelsDir, 'Post.ts'))

        // Second migration - should DROP posts table
        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(true)
        expect(second.sql).toContain('DROP TABLE')
        expect(second.sql).toContain('"posts"')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('detects index additions and removals', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
          indexes: [
            { name: 'email_idx', columns: ['email'] },
          ],
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First migration
        await generateMigration(modelsDir, { dialect: 'postgres' })

        // Add new index, remove old one
        createModelFile('User', `
          export default {
            name: 'User',
            table: 'users',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              email: { validation: { rule: {} } },
              created_at: { validation: { rule: {} } },
            },
            indexes: [
              { name: 'created_at_idx', columns: ['created_at'] },
            ],
          }
        `)

        // Second migration
        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(true)
        // Should drop old index and create new one
        expect(second.sql).toContain('DROP INDEX')
        expect(second.sql).toContain('email_idx')
        expect(second.sql).toContain('CREATE INDEX')
        expect(second.sql).toContain('created_at_idx')
      }
      finally {
        process.chdir(originalCwd)
      }
    })
  })

  describe('edge cases and error handling', () => {
    it('handles corrupt snapshot file gracefully', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // Write a corrupt snapshot
        mkdirSync(snapshotDir, { recursive: true })
        writeFileSync(getSnapshotPath(), 'not valid json {{{')

        // Should still work - treats as no previous state
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(result.hasChanges).toBe(true)
        expect(result.sql).toContain('CREATE TABLE')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('handles empty snapshot file gracefully', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // Write an empty snapshot
        mkdirSync(snapshotDir, { recursive: true })
        writeFileSync(getSnapshotPath(), '')

        // Should still work
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(result.hasChanges).toBe(true)
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('handles snapshot with wrong structure gracefully', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // Write snapshot with wrong structure
        writeSnapshot({ foo: 'bar', notAPlan: true })

        // Should treat as no previous state
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(result.hasChanges).toBe(true)
        expect(result.sql).toContain('CREATE TABLE')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('full migration ignores existing snapshot', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First migration
        await generateMigration(modelsDir, { dialect: 'postgres' })

        // Full migration should recreate everything
        const full = await generateMigration(modelsDir, { dialect: 'postgres', full: true })
        expect(full.hasChanges).toBe(true)
        expect(full.sql).toContain('CREATE TABLE "users"')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('supports legacy snapshot format', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First generate to see what the plan looks like
        const _initialResult = await generateMigration(modelsDir, { dialect: 'postgres', full: true })

        // Delete the snapshot and write it back in legacy format (tables at root level, not wrapped in { plan: ... })
        const _snapshotPath = getSnapshotPath()
        const snapshot = readSnapshot()
        // Legacy format: the plan IS the root object, not wrapped in { plan: ... }
        writeSnapshot(snapshot.plan)

        // Should recognize legacy format - no changes expected
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(result.sql.toLowerCase()).toContain('no changes')
      }
      finally {
        process.chdir(originalCwd)
      }
    })
  })

  describe('column modification detection', () => {
    it('detects unique flag changes', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        await generateMigration(modelsDir, { dialect: 'postgres' })

        // Make email unique
        createModelFile('User', `
          export default {
            name: 'User',
            table: 'users',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              email: { unique: true, validation: { rule: {} } },
            },
          }
        `)

        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(true)
        // Should detect the unique flag change
        expect(second.sql.toLowerCase()).toMatch(/alter|unique|index/)
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('detects default value changes', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            status: { default: 'active', validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        await generateMigration(modelsDir, { dialect: 'postgres' })

        // Change default value
        createModelFile('User', `
          export default {
            name: 'User',
            table: 'users',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              status: { default: 'pending', validation: { rule: {} } },
            },
          }
        `)

        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(true)
        expect(second.sql).toContain('ALTER')
      }
      finally {
        process.chdir(originalCwd)
      }
    })
  })

  describe('snapshot hash consistency', () => {
    it('hash is deterministic for same plan', () => {
      const models = defineModels({
        User: {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
        },
      })

      const plan1 = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const plan2 = buildMigrationPlan(models as any, { dialect: 'postgres' })

      expect(hashMigrationPlan(plan1)).toBe(hashMigrationPlan(plan2))
    })

    it('hash changes when plan changes', () => {
      const models1 = defineModels({
        User: {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        },
      })

      const models2 = defineModels({
        User: {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
        },
      })

      const plan1 = buildMigrationPlan(models1 as any, { dialect: 'postgres' })
      const plan2 = buildMigrationPlan(models2 as any, { dialect: 'postgres' })

      expect(hashMigrationPlan(plan1)).not.toBe(hashMigrationPlan(plan2))
    })

    it('hash stored in snapshot matches plan hash', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })
        const snapshot = readSnapshot()

        expect(snapshot.hash).toBe(hashMigrationPlan(result.plan))
      }
      finally {
        process.chdir(originalCwd)
      }
    })
  })

  describe('cleanup and reset', () => {
    it('deleteMigrationFiles removes snapshot file', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(existsSync(getSnapshotPath())).toBe(true)

        await deleteMigrationFiles(modelsDir, testWorkspace, { dialect: 'postgres' })
        expect(existsSync(getSnapshotPath())).toBe(false)
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('deleteMigrationFiles removes dialect-specific snapshot', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        await generateMigration(modelsDir, { dialect: 'postgres' })
        await generateMigration(modelsDir, { dialect: 'mysql' })

        expect(existsSync(getSnapshotPath('postgres'))).toBe(true)
        expect(existsSync(getSnapshotPath('mysql'))).toBe(true)

        // Delete only postgres
        await deleteMigrationFiles(modelsDir, testWorkspace, { dialect: 'postgres' })

        expect(existsSync(getSnapshotPath('postgres'))).toBe(false)
        expect(existsSync(getSnapshotPath('mysql'))).toBe(true)
      }
      finally {
        process.chdir(originalCwd)
      }
    })
  })

  describe('complex migration scenarios', () => {
    it('handles multiple model changes in sequence', async () => {
      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // Step 1: Create User model
        createModelFile('User', `
          export default {
            name: 'User',
            table: 'users',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              email: { validation: { rule: {} } },
            },
          }
        `)

        const step1 = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(step1.hasChanges).toBe(true)
        expect(step1.sql).toContain('CREATE TABLE "users"')

        // Step 2: Add Post model
        createModelFile('Post', `
          export default {
            name: 'Post',
            table: 'posts',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              title: { validation: { rule: {} } },
              user_id: { validation: { rule: {} } },
            },
          }
        `)

        const step2 = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(step2.hasChanges).toBe(true)
        expect(step2.sql).toContain('CREATE TABLE "posts"')
        expect(step2.sql).not.toContain('CREATE TABLE "users"')

        // Step 3: Add column to User, modify Post
        createModelFile('User', `
          export default {
            name: 'User',
            table: 'users',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              email: { validation: { rule: {} } },
              name: { validation: { rule: {} } },
            },
          }
        `)
        createModelFile('Post', `
          export default {
            name: 'Post',
            table: 'posts',
            primaryKey: 'id',
            attributes: {
              id: { validation: { rule: {} } },
              title: { validation: { rule: {} } },
              content: { validation: { rule: {} } },
              user_id: { validation: { rule: {} } },
            },
          }
        `)

        const step3 = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(step3.hasChanges).toBe(true)
        expect(step3.sql).toContain('ADD COLUMN')
        expect(step3.sql).toContain('"name"')
        expect(step3.sql).toContain('"content"')

        // Step 4: No changes
        const step4 = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(step4.hasChanges).toBe(false)

        // Step 5: Remove Post model
        rmSync(join(modelsDir, 'Post.ts'))

        const step5 = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(step5.hasChanges).toBe(true)
        expect(step5.sql).toContain('DROP TABLE')
        expect(step5.sql).toContain('"posts"')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('handles traits (timestamps, soft deletes)', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } },
          },
          traits: {
            useTimestamps: true,
            useSoftDeletes: true,
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(result.hasChanges).toBe(true)

        // Should include timestamp and soft delete columns
        expect(result.sql).toContain('created_at')
        expect(result.sql).toContain('updated_at')
        expect(result.sql).toContain('deleted_at')

        // Verify they're in the snapshot
        const snapshot = readSnapshot()
        const usersTable = snapshot.plan.tables.find((t: any) => t.table === 'users')
        const columnNames = usersTable.columns.map((c: any) => c.name)
        expect(columnNames).toContain('created_at')
        expect(columnNames).toContain('updated_at')
        expect(columnNames).toContain('deleted_at')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('handles foreign key relationships', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
          },
        }
      `)
      createModelFile('Post', `
        export default {
          name: 'Post',
          table: 'posts',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            user_id: { validation: { rule: {} } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(result.hasChanges).toBe(true)

        // Should detect and create foreign key
        expect(result.sql).toContain('FOREIGN KEY')
        expect(result.sql).toContain('REFERENCES')

        // Verify FK is in the snapshot
        const snapshot = readSnapshot()
        const postsTable = snapshot.plan.tables.find((t: any) => t.table === 'posts')
        const userIdColumn = postsTable.columns.find((c: any) => c.name === 'user_id')
        expect(userIdColumn.references).toBeDefined()
        expect(userIdColumn.references.table).toBe('users')
      }
      finally {
        process.chdir(originalCwd)
      }
    })
  })
})
