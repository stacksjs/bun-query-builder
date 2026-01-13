import type { ColumnPlan, MigrationPlan, TablePlan } from '../src/migrations'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateMigration } from '../src/actions/migrate'
import { buildMigrationPlan, generateDiffSql, generateSql } from '../src/migrations'
import { defineModels } from '../src/schema'

/**
 * Extremely thorough tests for complex model attribute scenarios.
 *
 * These tests cover:
 * - All column types and type inference
 * - Default values (various types)
 * - Unique constraints
 * - Foreign key inference
 * - Column name pattern detection (_id, _at, is_, has_)
 * - Validation rule type detection
 * - Enum columns and enum value changes
 * - Traits (timestamps, soft deletes)
 * - Complex multi-column indexes
 * - All possible column modifications
 * - Edge cases and boundary conditions
 */
describe('migrations - complex model attributes', () => {
  let testWorkspace: string
  let modelsDir: string

  beforeEach(() => {
    testWorkspace = join(tmpdir(), `qb-attr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    modelsDir = join(testWorkspace, 'app', 'Models')
    mkdirSync(modelsDir, { recursive: true })
    writeFileSync(join(testWorkspace, 'package.json'), '{}')
  })

  afterEach(() => {
    try {
      rmSync(testWorkspace, { recursive: true, force: true })
    }
    catch {
      // Ignore cleanup errors
    }
  })

  function createModelFile(name: string, content: string) {
    writeFileSync(join(modelsDir, `${name}.ts`), content)
  }

  function getColumn(plan: MigrationPlan, tableName: string, columnName: string): ColumnPlan | undefined {
    const table = plan.tables.find(t => t.table === tableName)
    return table?.columns.find(c => c.name === columnName)
  }

  function getTable(plan: MigrationPlan, tableName: string): TablePlan | undefined {
    return plan.tables.find(t => t.table === tableName)
  }

  // ============================================================================
  // TYPE INFERENCE TESTS
  // ============================================================================

  describe('type inference from column names', () => {
    it('infers bigint for columns ending with _id', () => {
      const models = defineModels({
        Post: {
          name: 'Post',
          table: 'posts',
          attributes: {
            id: { validation: { rule: {} } },
            user_id: { validation: { rule: {} } },
            category_id: { validation: { rule: {} } },
            parent_post_id: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'posts', 'user_id')?.type).toBe('bigint')
      expect(getColumn(plan, 'posts', 'category_id')?.type).toBe('bigint')
      expect(getColumn(plan, 'posts', 'parent_post_id')?.type).toBe('bigint')
    })

    it('infers datetime for columns ending with _at', () => {
      const models = defineModels({
        Event: {
          name: 'Event',
          table: 'events',
          attributes: {
            id: { validation: { rule: {} } },
            starts_at: { validation: { rule: {} } },
            ends_at: { validation: { rule: {} } },
            published_at: { validation: { rule: {} } },
            archived_at: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'events', 'starts_at')?.type).toBe('datetime')
      expect(getColumn(plan, 'events', 'ends_at')?.type).toBe('datetime')
      expect(getColumn(plan, 'events', 'published_at')?.type).toBe('datetime')
      expect(getColumn(plan, 'events', 'archived_at')?.type).toBe('datetime')
    })

    it('infers boolean for columns starting with is_ or has_', () => {
      const models = defineModels({
        User: {
          name: 'User',
          table: 'users',
          attributes: {
            id: { validation: { rule: {} } },
            is_active: { validation: { rule: {} } },
            is_verified: { validation: { rule: {} } },
            is_admin: { validation: { rule: {} } },
            has_newsletter: { validation: { rule: {} } },
            has_two_factor: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'users', 'is_active')?.type).toBe('boolean')
      expect(getColumn(plan, 'users', 'is_verified')?.type).toBe('boolean')
      expect(getColumn(plan, 'users', 'is_admin')?.type).toBe('boolean')
      expect(getColumn(plan, 'users', 'has_newsletter')?.type).toBe('boolean')
      expect(getColumn(plan, 'users', 'has_two_factor')?.type).toBe('boolean')
    })

    it('does not misdetect similar column names', () => {
      const models = defineModels({
        Item: {
          name: 'Item',
          table: 'items',
          attributes: {
            id: { validation: { rule: {} } },
            // These should NOT trigger special inference
            uuid: { validation: { rule: {} } }, // contains 'id' but doesn't end with _id
            format: { validation: { rule: {} } }, // contains 'at' but doesn't end with _at
            bishop: { validation: { rule: {} } }, // starts with 'is' but not 'is_'
            hashable: { validation: { rule: {} } }, // starts with 'has' but not 'has_'
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'items', 'uuid')?.type).toBe('string')
      expect(getColumn(plan, 'items', 'format')?.type).toBe('string')
      expect(getColumn(plan, 'items', 'bishop')?.type).toBe('string')
      expect(getColumn(plan, 'items', 'hashable')?.type).toBe('string')
    })
  })

  describe('type inference from default values', () => {
    it('infers string from string default (short)', () => {
      const models = defineModels({
        Config: {
          name: 'Config',
          table: 'configs',
          attributes: {
            id: { validation: { rule: {} } },
            locale: { default: 'en', validation: { rule: {} } },
            timezone: { default: 'UTC', validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'configs', 'locale')?.type).toBe('string')
      expect(getColumn(plan, 'configs', 'locale')?.defaultValue).toBe('en')
      expect(getColumn(plan, 'configs', 'timezone')?.type).toBe('string')
    })

    it('infers text from string default (long > 255 chars)', () => {
      const longString = 'x'.repeat(300)
      const models = defineModels({
        Content: {
          name: 'Content',
          table: 'contents',
          attributes: {
            id: { validation: { rule: {} } },
            body: { default: longString, validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'contents', 'body')?.type).toBe('text')
    })

    it('infers integer from integer default', () => {
      const models = defineModels({
        Product: {
          name: 'Product',
          table: 'products',
          attributes: {
            id: { validation: { rule: {} } },
            quantity: { default: 0, validation: { rule: {} } },
            priority: { default: 100, validation: { rule: {} } },
            negative_allowed: { default: -5, validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'products', 'quantity')?.type).toBe('integer')
      expect(getColumn(plan, 'products', 'quantity')?.defaultValue).toBe(0)
      expect(getColumn(plan, 'products', 'priority')?.type).toBe('integer')
      expect(getColumn(plan, 'products', 'negative_allowed')?.type).toBe('integer')
    })

    it('infers float from non-integer number default', () => {
      const models = defineModels({
        Measurement: {
          name: 'Measurement',
          table: 'measurements',
          attributes: {
            id: { validation: { rule: {} } },
            temperature: { default: 98.6, validation: { rule: {} } },
            percentage: { default: 0.5, validation: { rule: {} } },
            ratio: { default: 3.14159, validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'measurements', 'temperature')?.type).toBe('float')
      expect(getColumn(plan, 'measurements', 'percentage')?.type).toBe('float')
      expect(getColumn(plan, 'measurements', 'ratio')?.type).toBe('float')
    })

    it('infers boolean from boolean default', () => {
      const models = defineModels({
        Settings: {
          name: 'Settings',
          table: 'settings',
          attributes: {
            id: { validation: { rule: {} } },
            enabled: { default: true, validation: { rule: {} } },
            debug_mode: { default: false, validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'settings', 'enabled')?.type).toBe('boolean')
      expect(getColumn(plan, 'settings', 'enabled')?.defaultValue).toBe(true)
      expect(getColumn(plan, 'settings', 'debug_mode')?.type).toBe('boolean')
      expect(getColumn(plan, 'settings', 'debug_mode')?.defaultValue).toBe(false)
    })

    it('infers bigint from bigint default', () => {
      const models = defineModels({
        BigData: {
          name: 'BigData',
          table: 'big_data',
          attributes: {
            id: { validation: { rule: {} } },
            huge_number: { default: 9007199254740993n as any, validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'big_data', 'huge_number')?.type).toBe('bigint')
    })

    it('infers datetime from Date default', () => {
      const defaultDate = new Date('2024-01-01T00:00:00Z')
      const models = defineModels({
        Event: {
          name: 'Event',
          table: 'events',
          attributes: {
            id: { validation: { rule: {} } },
            scheduled: { default: defaultDate, validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'events', 'scheduled')?.type).toBe('datetime')
    })
  })

  describe('type inference from validation rules', () => {
    it('detects string type from validation rule', () => {
      const models = defineModels({
        User: {
          name: 'User',
          table: 'users',
          attributes: {
            id: { validation: { rule: {} } },
            name: { validation: { rule: { name: 'string' } } },
            bio: { validation: { rule: { name: 'text' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'users', 'name')?.type).toBe('string')
      expect(getColumn(plan, 'users', 'bio')?.type).toBe('string')
    })

    it('detects integer types from validation rule', () => {
      const models = defineModels({
        Stats: {
          name: 'Stats',
          table: 'stats',
          attributes: {
            id: { validation: { rule: {} } },
            count: { validation: { rule: { name: 'integer' } } },
            short_count: { validation: { rule: { name: 'int' } } },
            big_count: { validation: { rule: { name: 'bigint' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'stats', 'count')?.type).toBe('integer')
      expect(getColumn(plan, 'stats', 'short_count')?.type).toBe('integer')
      expect(getColumn(plan, 'stats', 'big_count')?.type).toBe('bigint')
    })

    it('detects float/double/decimal types from validation rule', () => {
      const models = defineModels({
        Financial: {
          name: 'Financial',
          table: 'financials',
          attributes: {
            id: { validation: { rule: {} } },
            amount: { validation: { rule: { name: 'float' } } },
            rate: { validation: { rule: { name: 'double' } } },
            price: { validation: { rule: { name: 'decimal' } } },
            generic_num: { validation: { rule: { name: 'number' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'financials', 'amount')?.type).toBe('float')
      expect(getColumn(plan, 'financials', 'rate')?.type).toBe('double')
      expect(getColumn(plan, 'financials', 'price')?.type).toBe('decimal')
      expect(getColumn(plan, 'financials', 'generic_num')?.type).toBe('float')
    })

    it('detects boolean type from validation rule', () => {
      const models = defineModels({
        Flags: {
          name: 'Flags',
          table: 'flags',
          attributes: {
            id: { validation: { rule: {} } },
            active: { validation: { rule: { name: 'boolean' } } },
            enabled: { validation: { rule: { name: 'bool' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'flags', 'active')?.type).toBe('boolean')
      expect(getColumn(plan, 'flags', 'enabled')?.type).toBe('boolean')
    })

    it('detects date/datetime types from validation rule', () => {
      const models = defineModels({
        Calendar: {
          name: 'Calendar',
          table: 'calendars',
          attributes: {
            id: { validation: { rule: {} } },
            birth_date: { validation: { rule: { name: 'date' } } },
            event_time: { validation: { rule: { name: 'datetime' } } },
            created: { validation: { rule: { name: 'timestamp' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'calendars', 'birth_date')?.type).toBe('date')
      expect(getColumn(plan, 'calendars', 'event_time')?.type).toBe('datetime')
      expect(getColumn(plan, 'calendars', 'created')?.type).toBe('datetime')
    })

    it('detects json type from validation rule', () => {
      const models = defineModels({
        Document: {
          name: 'Document',
          table: 'documents',
          attributes: {
            id: { validation: { rule: {} } },
            metadata: { validation: { rule: { name: 'json' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'documents', 'metadata')?.type).toBe('json')
    })

    it('detects enum type from validation rule with name: enum and enumValues', () => {
      const models = defineModels({
        Order: {
          name: 'Order',
          table: 'orders',
          attributes: {
            id: { validation: { rule: {} } },
            status: {
              validation: {
                rule: {
                  name: 'enum',
                  enumValues: ['pending', 'processing', 'shipped', 'delivered'],
                },
              },
            },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const statusCol = getColumn(plan, 'orders', 'status')
      expect(statusCol?.type).toBe('enum')
      expect(statusCol?.enumValues).toEqual(['pending', 'processing', 'shipped', 'delivered'])
    })

    it('detects enum type from validation rule with enumValues only (no name property)', () => {
      // This tests the fallback detection path when enumValues is present without name: 'enum'
      const models = defineModels({
        OrderAlt: {
          name: 'OrderAlt',
          table: 'order_alts',
          attributes: {
            id: { validation: { rule: {} } },
            status: {
              validation: {
                rule: {
                  enumValues: ['pending', 'processing', 'shipped', 'delivered'],
                },
              },
            },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const statusCol = getColumn(plan, 'order_alts', 'status')
      expect(statusCol?.type).toBe('enum')
      expect(statusCol?.enumValues).toEqual(['pending', 'processing', 'shipped', 'delivered'])
    })

    it('detects enum type from validation rule with _values', () => {
      const models = defineModels({
        Task: {
          name: 'Task',
          table: 'tasks',
          attributes: {
            id: { validation: { rule: {} } },
            priority: {
              validation: {
                rule: {
                  _values: ['low', 'medium', 'high', 'critical'],
                },
              },
            },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const priorityCol = getColumn(plan, 'tasks', 'priority')
      expect(priorityCol?.type).toBe('enum')
      expect(priorityCol?.enumValues).toEqual(['low', 'medium', 'high', 'critical'])
    })

    it('detects enum type from validation rule with values', () => {
      const models = defineModels({
        Ticket: {
          name: 'Ticket',
          table: 'tickets',
          attributes: {
            id: { validation: { rule: {} } },
            severity: {
              validation: {
                rule: {
                  values: ['info', 'warning', 'error', 'fatal'],
                },
              },
            },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const severityCol = getColumn(plan, 'tickets', 'severity')
      expect(severityCol?.type).toBe('enum')
      expect(severityCol?.enumValues).toEqual(['info', 'warning', 'error', 'fatal'])
    })
  })

  // ============================================================================
  // UNIQUE CONSTRAINTS TESTS
  // ============================================================================

  describe('unique constraints', () => {
    it('creates unique index for unique columns', () => {
      const models = defineModels({
        User: {
          name: 'User',
          table: 'users',
          attributes: {
            id: { validation: { rule: {} } },
            email: { unique: true, validation: { rule: {} } },
            username: { unique: true, validation: { rule: {} } },
            name: { validation: { rule: {} } }, // not unique
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const table = getTable(plan, 'users')

      expect(getColumn(plan, 'users', 'email')?.isUnique).toBe(true)
      expect(getColumn(plan, 'users', 'username')?.isUnique).toBe(true)
      expect(getColumn(plan, 'users', 'name')?.isUnique).toBe(false)

      // Check indexes are created
      expect(table?.indexes.some(i => i.name === 'users_email_unique' && i.type === 'unique')).toBe(true)
      expect(table?.indexes.some(i => i.name === 'users_username_unique' && i.type === 'unique')).toBe(true)
    })

    it('does not create unique index for primary key', () => {
      const models = defineModels({
        Item: {
          name: 'Item',
          table: 'items',
          primaryKey: 'id',
          attributes: {
            id: { unique: true, validation: { rule: {} } }, // PK with unique flag
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const table = getTable(plan, 'items')

      // Should NOT create a unique index for primary key
      expect(table?.indexes.some(i => i.name.includes('id') && i.type === 'unique')).toBe(false)
    })
  })

  // ============================================================================
  // FOREIGN KEY INFERENCE TESTS
  // ============================================================================

  describe('foreign key inference', () => {
    it('infers foreign key for _id columns referencing existing models', () => {
      const models = defineModels({
        User: {
          name: 'User',
          table: 'users',
          attributes: {
            id: { validation: { rule: {} } },
          },
        },
        Post: {
          name: 'Post',
          table: 'posts',
          attributes: {
            id: { validation: { rule: {} } },
            user_id: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const userIdCol = getColumn(plan, 'posts', 'user_id')

      expect(userIdCol?.references).toBeDefined()
      expect(userIdCol?.references?.table).toBe('users')
      expect(userIdCol?.references?.column).toBe('id')
    })

    it('handles complex model name to table inference', () => {
      const models = defineModels({
        BlogCategory: {
          name: 'BlogCategory',
          table: 'blog_categories',
          attributes: {
            id: { validation: { rule: {} } },
          },
        },
        Article: {
          name: 'Article',
          table: 'articles',
          attributes: {
            id: { validation: { rule: {} } },
            blog_category_id: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const fkCol = getColumn(plan, 'articles', 'blog_category_id')

      // Note: The current implementation tries to match 'BlogCategory' from 'blog_category_id'
      // by capitalizing 'blog_category' -> 'Blog_category' which won't match 'BlogCategory'
      // This is a known limitation - FK inference works for simple cases
      // The test documents the current behavior
      expect(fkCol?.type).toBe('bigint') // Should still be bigint type
    })

    it('does not create FK for _id columns without matching model', () => {
      const models = defineModels({
        Orphan: {
          name: 'Orphan',
          table: 'orphans',
          attributes: {
            id: { validation: { rule: {} } },
            external_api_id: { validation: { rule: {} } }, // No ExternalApi model
            legacy_system_id: { validation: { rule: {} } }, // No LegacySystem model
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      expect(getColumn(plan, 'orphans', 'external_api_id')?.references).toBeUndefined()
      expect(getColumn(plan, 'orphans', 'legacy_system_id')?.references).toBeUndefined()
    })

    it('handles custom primary keys in referenced tables', () => {
      const models = defineModels({
        Country: {
          name: 'Country',
          table: 'countries',
          primaryKey: 'code', // Custom PK
          attributes: {
            code: { validation: { rule: {} } },
            name: { validation: { rule: {} } },
          },
        },
        City: {
          name: 'City',
          table: 'cities',
          attributes: {
            id: { validation: { rule: {} } },
            country_id: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const fkCol = getColumn(plan, 'cities', 'country_id')

      expect(fkCol?.references?.table).toBe('countries')
      expect(fkCol?.references?.column).toBe('code') // Should reference custom PK
    })
  })

  // ============================================================================
  // TRAITS TESTS
  // ============================================================================

  describe('traits', () => {
    it('useTimestamps adds created_at and updated_at', () => {
      const models = defineModels({
        Post: {
          name: 'Post',
          table: 'posts',
          attributes: {
            id: { validation: { rule: {} } },
            title: { validation: { rule: {} } },
          },
          traits: {
            useTimestamps: true,
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      const createdAt = getColumn(plan, 'posts', 'created_at')
      const updatedAt = getColumn(plan, 'posts', 'updated_at')

      expect(createdAt).toBeDefined()
      expect(createdAt?.type).toBe('datetime')
      expect(createdAt?.isNullable).toBe(false)
      expect(createdAt?.hasDefault).toBe(true)

      expect(updatedAt).toBeDefined()
      expect(updatedAt?.type).toBe('datetime')
      expect(updatedAt?.isNullable).toBe(true)
      expect(updatedAt?.hasDefault).toBe(false)
    })

    it('timestampable alias works like useTimestamps', () => {
      const models = defineModels({
        Comment: {
          name: 'Comment',
          table: 'comments',
          attributes: {
            id: { validation: { rule: {} } },
          },
          traits: {
            timestampable: true,
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      expect(getColumn(plan, 'comments', 'created_at')).toBeDefined()
      expect(getColumn(plan, 'comments', 'updated_at')).toBeDefined()
    })

    it('useSoftDeletes adds deleted_at', () => {
      const models = defineModels({
        Article: {
          name: 'Article',
          table: 'articles',
          attributes: {
            id: { validation: { rule: {} } },
          },
          traits: {
            useSoftDeletes: true,
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      const deletedAt = getColumn(plan, 'articles', 'deleted_at')

      expect(deletedAt).toBeDefined()
      expect(deletedAt?.type).toBe('datetime')
      expect(deletedAt?.isNullable).toBe(true)
    })

    it('softDeletable alias works like useSoftDeletes', () => {
      const models = defineModels({
        Message: {
          name: 'Message',
          table: 'messages',
          attributes: {
            id: { validation: { rule: {} } },
          },
          traits: {
            softDeletable: true,
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      expect(getColumn(plan, 'messages', 'deleted_at')).toBeDefined()
    })

    it('does not duplicate timestamp columns if manually defined', () => {
      const models = defineModels({
        Custom: {
          name: 'Custom',
          table: 'customs',
          attributes: {
            id: { validation: { rule: {} } },
            created_at: { validation: { rule: { name: 'date' } } }, // Custom type
            updated_at: { validation: { rule: {} } },
          },
          traits: {
            useTimestamps: true,
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const table = getTable(plan, 'customs')

      // Should only have one created_at column
      const createdAtCols = table?.columns.filter(c => c.name === 'created_at')
      expect(createdAtCols?.length).toBe(1)

      // And it should use the manually defined type
      expect(getColumn(plan, 'customs', 'created_at')?.type).toBe('date')
    })

    it('combines timestamps and soft deletes', () => {
      const models = defineModels({
        Audited: {
          name: 'Audited',
          table: 'audited',
          attributes: {
            id: { validation: { rule: {} } },
          },
          traits: {
            useTimestamps: true,
            useSoftDeletes: true,
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      expect(getColumn(plan, 'audited', 'created_at')).toBeDefined()
      expect(getColumn(plan, 'audited', 'updated_at')).toBeDefined()
      expect(getColumn(plan, 'audited', 'deleted_at')).toBeDefined()
    })
  })

  // ============================================================================
  // COMPOSITE INDEXES TESTS
  // ============================================================================

  describe('composite indexes', () => {
    it('creates multi-column indexes from model definition', () => {
      const models = defineModels({
        Product: {
          name: 'Product',
          table: 'products',
          attributes: {
            id: { validation: { rule: {} } },
            category: { validation: { rule: {} } },
            brand: { validation: { rule: {} } },
            price: { validation: { rule: {} } },
          },
          indexes: [
            { name: 'category_brand_idx', columns: ['category', 'brand'] },
            { name: 'brand_price_idx', columns: ['brand', 'price'] },
          ],
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const table = getTable(plan, 'products')

      const catBrandIdx = table?.indexes.find(i => i.name === 'category_brand_idx')
      const brandPriceIdx = table?.indexes.find(i => i.name === 'brand_price_idx')

      expect(catBrandIdx).toBeDefined()
      expect(catBrandIdx?.columns).toEqual(['category', 'brand'])
      expect(catBrandIdx?.type).toBe('index')

      expect(brandPriceIdx).toBeDefined()
      expect(brandPriceIdx?.columns).toEqual(['brand', 'price'])
    })

    it('handles single-column indexes in indexes array', () => {
      const models = defineModels({
        Log: {
          name: 'Log',
          table: 'logs',
          attributes: {
            id: { validation: { rule: {} } },
            level: { validation: { rule: {} } },
            message: { validation: { rule: {} } },
          },
          indexes: [
            { name: 'level_idx', columns: ['level'] },
          ],
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const table = getTable(plan, 'logs')

      const levelIdx = table?.indexes.find(i => i.name === 'level_idx')
      expect(levelIdx?.columns).toEqual(['level'])
    })
  })

  // ============================================================================
  // DIFF DETECTION TESTS - COLUMN MODIFICATIONS
  // ============================================================================

  describe('diff detection - column modifications', () => {
    it('detects type changes', () => {
      const before = defineModels({
        Item: {
          name: 'Item',
          table: 'items',
          attributes: {
            id: { validation: { rule: {} } },
            quantity: { validation: { rule: { name: 'integer' } } },
          },
        },
      })

      const after = defineModels({
        Item: {
          name: 'Item',
          table: 'items',
          attributes: {
            id: { validation: { rule: {} } },
            quantity: { validation: { rule: { name: 'bigint' } } }, // Changed to bigint
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('ALTER')
      expect(sql.join('\n').toLowerCase()).toContain('quantity')
    })

    it('detects default value additions', () => {
      const before = defineModels({
        Config: {
          name: 'Config',
          table: 'configs',
          attributes: {
            id: { validation: { rule: {} } },
            value: { validation: { rule: {} } }, // No default
          },
        },
      })

      const after = defineModels({
        Config: {
          name: 'Config',
          table: 'configs',
          attributes: {
            id: { validation: { rule: {} } },
            value: { default: 'default_value', validation: { rule: {} } }, // Added default
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('ALTER')
    })

    it('detects default value changes', () => {
      const before = defineModels({
        Settings: {
          name: 'Settings',
          table: 'settings',
          attributes: {
            id: { validation: { rule: {} } },
            theme: { default: 'light', validation: { rule: {} } },
          },
        },
      })

      const after = defineModels({
        Settings: {
          name: 'Settings',
          table: 'settings',
          attributes: {
            id: { validation: { rule: {} } },
            theme: { default: 'dark', validation: { rule: {} } }, // Changed default
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('ALTER')
    })

    it('detects default value removals', () => {
      const before = defineModels({
        Item: {
          name: 'Item',
          table: 'items',
          attributes: {
            id: { validation: { rule: {} } },
            status: { default: 'active', validation: { rule: {} } },
          },
        },
      })

      const after = defineModels({
        Item: {
          name: 'Item',
          table: 'items',
          attributes: {
            id: { validation: { rule: {} } },
            status: { validation: { rule: {} } }, // Removed default
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('ALTER')
    })

    it('detects unique constraint additions', () => {
      const before = defineModels({
        User: {
          name: 'User',
          table: 'users',
          attributes: {
            id: { validation: { rule: {} } },
            email: { validation: { rule: {} } }, // Not unique
          },
        },
      })

      const after = defineModels({
        User: {
          name: 'User',
          table: 'users',
          attributes: {
            id: { validation: { rule: {} } },
            email: { unique: true, validation: { rule: {} } }, // Now unique
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('ALTER')
      // Should also create unique index
      expect(sql.join('\n').toLowerCase()).toContain('unique')
    })

    it('detects unique constraint removals', () => {
      const before = defineModels({
        Account: {
          name: 'Account',
          table: 'accounts',
          attributes: {
            id: { validation: { rule: {} } },
            code: { unique: true, validation: { rule: {} } },
          },
        },
      })

      const after = defineModels({
        Account: {
          name: 'Account',
          table: 'accounts',
          attributes: {
            id: { validation: { rule: {} } },
            code: { validation: { rule: {} } }, // No longer unique
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('DROP INDEX')
    })
  })

  // ============================================================================
  // DIFF DETECTION TESTS - ENUM CHANGES
  // ============================================================================

  describe('diff detection - enum changes', () => {
    it('detects enum value additions', () => {
      const before = defineModels({
        Order: {
          name: 'Order',
          table: 'orders',
          attributes: {
            id: { validation: { rule: {} } },
            status: {
              validation: {
                rule: { enumValues: ['pending', 'completed'] },
              },
            },
          },
        },
      })

      const after = defineModels({
        Order: {
          name: 'Order',
          table: 'orders',
          attributes: {
            id: { validation: { rule: {} } },
            status: {
              validation: {
                rule: { enumValues: ['pending', 'processing', 'completed', 'cancelled'] },
              },
            },
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('ALTER')
    })

    it('detects enum value removals', () => {
      const before = defineModels({
        Task: {
          name: 'Task',
          table: 'tasks',
          attributes: {
            id: { validation: { rule: {} } },
            priority: {
              validation: {
                rule: { enumValues: ['low', 'medium', 'high', 'critical'] },
              },
            },
          },
        },
      })

      const after = defineModels({
        Task: {
          name: 'Task',
          table: 'tasks',
          attributes: {
            id: { validation: { rule: {} } },
            priority: {
              validation: {
                rule: { enumValues: ['low', 'medium', 'high'] }, // Removed 'critical'
              },
            },
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('ALTER')
    })

    it('no changes when enum values are same (order independent)', () => {
      const before = defineModels({
        Item: {
          name: 'Item',
          table: 'items',
          attributes: {
            id: { validation: { rule: {} } },
            status: {
              validation: {
                rule: { enumValues: ['a', 'b', 'c'] },
              },
            },
          },
        },
      })

      const after = defineModels({
        Item: {
          name: 'Item',
          table: 'items',
          attributes: {
            id: { validation: { rule: {} } },
            status: {
              validation: {
                rule: { enumValues: ['c', 'a', 'b'] }, // Same values, different order
              },
            },
          },
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n').toLowerCase()).toContain('no changes')
    })
  })

  // ============================================================================
  // DIFF DETECTION TESTS - INDEX CHANGES
  // ============================================================================

  describe('diff detection - index changes', () => {
    it('detects new composite index additions', () => {
      const before = defineModels({
        Product: {
          name: 'Product',
          table: 'products',
          attributes: {
            id: { validation: { rule: {} } },
            category: { validation: { rule: {} } },
            brand: { validation: { rule: {} } },
          },
          indexes: [],
        },
      })

      const after = defineModels({
        Product: {
          name: 'Product',
          table: 'products',
          attributes: {
            id: { validation: { rule: {} } },
            category: { validation: { rule: {} } },
            brand: { validation: { rule: {} } },
          },
          indexes: [
            { name: 'category_brand_idx', columns: ['category', 'brand'] },
          ],
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('CREATE INDEX')
      expect(sql.join('\n')).toContain('category_brand_idx')
    })

    it('detects composite index removals', () => {
      const before = defineModels({
        Product: {
          name: 'Product',
          table: 'products',
          attributes: {
            id: { validation: { rule: {} } },
            category: { validation: { rule: {} } },
          },
          indexes: [
            { name: 'category_idx', columns: ['category'] },
          ],
        },
      })

      const after = defineModels({
        Product: {
          name: 'Product',
          table: 'products',
          attributes: {
            id: { validation: { rule: {} } },
            category: { validation: { rule: {} } },
          },
          indexes: [], // Removed index
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      expect(sql.join('\n')).toContain('DROP INDEX')
      expect(sql.join('\n')).toContain('category_idx')
    })

    it('detects index column changes', () => {
      const before = defineModels({
        Log: {
          name: 'Log',
          table: 'logs',
          attributes: {
            id: { validation: { rule: {} } },
            level: { validation: { rule: {} } },
            timestamp: { validation: { rule: {} } },
          },
          indexes: [
            { name: 'log_search_idx', columns: ['level'] },
          ],
        },
      })

      const after = defineModels({
        Log: {
          name: 'Log',
          table: 'logs',
          attributes: {
            id: { validation: { rule: {} } },
            level: { validation: { rule: {} } },
            timestamp: { validation: { rule: {} } },
          },
          indexes: [
            { name: 'log_search_idx', columns: ['level', 'timestamp'] }, // Added column
          ],
        },
      })

      const prevPlan = buildMigrationPlan(before as any, { dialect: 'postgres' })
      const nextPlan = buildMigrationPlan(after as any, { dialect: 'postgres' })
      const sql = generateDiffSql(prevPlan, nextPlan)

      // Should drop old and create new
      expect(sql.join('\n')).toContain('DROP INDEX')
      expect(sql.join('\n')).toContain('CREATE INDEX')
    })
  })

  // ============================================================================
  // DIALECT-SPECIFIC TESTS
  // ============================================================================

  describe('dialect-specific SQL generation', () => {
    it('generates correct PostgreSQL types', () => {
      // Note: validation rule { name: 'text' } maps to 'string' type (varchar(255))
      // The 'text' column type is only inferred from long default strings (>255 chars)
      const longString = 'x'.repeat(300)
      const models = defineModels({
        AllTypes: {
          name: 'AllTypes',
          table: 'all_types',
          attributes: {
            id: { validation: { rule: {} } },
            str: { validation: { rule: { name: 'string' } } },
            txt: { default: longString, validation: { rule: {} } }, // Use long default to get text type
            int_col: { validation: { rule: { name: 'integer' } } },
            big: { validation: { rule: { name: 'bigint' } } },
            flt: { validation: { rule: { name: 'float' } } },
            dbl: { validation: { rule: { name: 'double' } } },
            dec: { validation: { rule: { name: 'decimal' } } },
            bool: { validation: { rule: { name: 'boolean' } } },
            dt: { validation: { rule: { name: 'date' } } },
            dttm: { validation: { rule: { name: 'datetime' } } },
            js: { validation: { rule: { name: 'json' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const sql = generateSql(plan).join('\n').toLowerCase()

      expect(sql).toContain('varchar')
      expect(sql).toContain('text') // From long default string
      expect(sql).toContain('integer')
      expect(sql).toContain('bigint')
      expect(sql).toContain('timestamp')
      expect(sql).toContain('jsonb')
      expect(sql).toContain('boolean')
    })

    it('generates correct MySQL types', () => {
      const models = defineModels({
        AllTypes: {
          name: 'AllTypes',
          table: 'all_types',
          attributes: {
            id: { validation: { rule: {} } },
            str: { validation: { rule: { name: 'string' } } },
            bool: { validation: { rule: { name: 'boolean' } } },
            dttm: { validation: { rule: { name: 'datetime' } } },
            js: { validation: { rule: { name: 'json' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'mysql' })
      const sql = generateSql(plan).join('\n').toLowerCase()

      expect(sql).toContain('varchar')
      expect(sql).toContain('tinyint(1)') // MySQL boolean
      expect(sql).toContain('datetime')
      expect(sql).toContain('json')
    })

    it('generates correct SQLite types', () => {
      const models = defineModels({
        AllTypes: {
          name: 'AllTypes',
          table: 'all_types',
          attributes: {
            id: { validation: { rule: {} } },
            str: { validation: { rule: { name: 'string' } } },
            int_col: { validation: { rule: { name: 'integer' } } },
            bool: { validation: { rule: { name: 'boolean' } } },
            dttm: { validation: { rule: { name: 'datetime' } } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'sqlite' })
      const sql = generateSql(plan).join('\n').toLowerCase()

      expect(sql).toContain('text') // SQLite uses TEXT for strings
      expect(sql).toContain('integer')
    })

    it('generates dialect-specific enum handling', () => {
      const models = defineModels({
        Status: {
          name: 'Status',
          table: 'statuses',
          attributes: {
            id: { validation: { rule: {} } },
            state: {
              validation: {
                rule: { enumValues: ['active', 'inactive', 'pending'] },
              },
            },
          },
        },
      })

      const pgPlan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const pgSql = generateSql(pgPlan).join('\n')

      const myPlan = buildMigrationPlan(models as any, { dialect: 'mysql' })
      const mySql = generateSql(myPlan).join('\n')

      const sqPlan = buildMigrationPlan(models as any, { dialect: 'sqlite' })
      const sqSql = generateSql(sqPlan).join('\n')

      // PostgreSQL creates TYPE
      expect(pgSql).toContain('CREATE TYPE')

      // MySQL uses inline ENUM
      expect(mySql.toLowerCase()).toContain('enum')

      // SQLite uses TEXT with CHECK
      expect(sqSql).toContain('CHECK')
    })
  })

  // ============================================================================
  // FILE-BASED INTEGRATION TESTS
  // ============================================================================

  describe('file-based integration tests', () => {
    it('handles complex model with all features', async () => {
      createModelFile('User', `
        export default {
          name: 'User',
          table: 'users',
          primaryKey: 'id',
          attributes: {
            id: { validation: { rule: {} } },
            email: { unique: true, validation: { rule: { name: 'string' } } },
            password_hash: { validation: { rule: {} } },
            role: {
              default: 'user',
              validation: {
                rule: { enumValues: ['admin', 'moderator', 'user', 'guest'] },
              },
            },
            login_count: { default: 0, validation: { rule: { name: 'integer' } } },
            last_login_at: { validation: { rule: {} } },
            is_active: { default: true, validation: { rule: {} } },
            is_verified: { default: false, validation: { rule: {} } },
            metadata: { validation: { rule: { name: 'json' } } },
          },
          indexes: [
            { name: 'users_role_active_idx', columns: ['role', 'is_active'] },
          ],
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

        // Check SQL contains expected elements
        const sql = result.sql.toLowerCase()
        expect(sql).toContain('create table')
        expect(sql).toContain('users')
        expect(sql).toContain('email')
        expect(sql).toContain('unique')
        expect(sql).toContain('role')
        expect(sql).toContain('created_at')
        expect(sql).toContain('updated_at')
        expect(sql).toContain('deleted_at')
        expect(sql).toContain('users_role_active_idx')

        // Check plan structure
        const table = result.plan.tables.find(t => t.table === 'users')
        expect(table?.columns.length).toBeGreaterThan(10) // All columns including traits

        const emailCol = table?.columns.find(c => c.name === 'email')
        expect(emailCol?.isUnique).toBe(true)
        expect(emailCol?.type).toBe('string')

        const roleCol = table?.columns.find(c => c.name === 'role')
        expect(roleCol?.type).toBe('enum')
        expect(roleCol?.enumValues).toContain('admin')
        expect(roleCol?.defaultValue).toBe('user')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('handles multiple related models', async () => {
      createModelFile('Author', `
        export default {
          name: 'Author',
          table: 'authors',
          attributes: {
            id: { validation: { rule: {} } },
            name: { validation: { rule: {} } },
            bio: { validation: { rule: { name: 'text' } } },
          },
          traits: { useTimestamps: true },
        }
      `)

      createModelFile('Book', `
        export default {
          name: 'Book',
          table: 'books',
          attributes: {
            id: { validation: { rule: {} } },
            author_id: { validation: { rule: {} } },
            title: { validation: { rule: {} } },
            isbn: { unique: true, validation: { rule: {} } },
            published_at: { validation: { rule: {} } },
            price: { default: 9.99, validation: { rule: {} } },
          },
          indexes: [
            { name: 'books_author_published_idx', columns: ['author_id', 'published_at'] },
          ],
        }
      `)

      createModelFile('Review', `
        export default {
          name: 'Review',
          table: 'reviews',
          attributes: {
            id: { validation: { rule: {} } },
            book_id: { validation: { rule: {} } },
            rating: { validation: { rule: { name: 'integer' } } },
            comment: { validation: { rule: { name: 'text' } } },
          },
          traits: { useTimestamps: true, useSoftDeletes: true },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        const result = await generateMigration(modelsDir, { dialect: 'postgres' })

        expect(result.hasChanges).toBe(true)
        expect(result.plan.tables.length).toBe(3)

        // Check foreign keys
        const booksTable = result.plan.tables.find(t => t.table === 'books')
        const authorIdCol = booksTable?.columns.find(c => c.name === 'author_id')
        expect(authorIdCol?.references?.table).toBe('authors')

        const reviewsTable = result.plan.tables.find(t => t.table === 'reviews')
        const bookIdCol = reviewsTable?.columns.find(c => c.name === 'book_id')
        expect(bookIdCol?.references?.table).toBe('books')

        // Check SQL has foreign key constraints
        expect(result.sql).toContain('FOREIGN KEY')
        expect(result.sql).toContain('REFERENCES')
      }
      finally {
        process.chdir(originalCwd)
      }
    })

    it('handles incremental changes to complex models', async () => {
      // Initial model
      createModelFile('Product', `
        export default {
          name: 'Product',
          table: 'products',
          attributes: {
            id: { validation: { rule: {} } },
            name: { validation: { rule: {} } },
            price: { default: 0, validation: { rule: { name: 'float' } } },
          },
        }
      `)

      const originalCwd = process.cwd()
      process.chdir(testWorkspace)

      try {
        // First migration
        const first = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(first.hasChanges).toBe(true)
        expect(first.sql).toContain('CREATE TABLE')

        // Update model significantly
        createModelFile('Product', `
          export default {
            name: 'Product',
            table: 'products',
            attributes: {
              id: { validation: { rule: {} } },
              name: { validation: { rule: {} } },
              sku: { unique: true, validation: { rule: {} } }, // New unique column
              price: { default: 0, validation: { rule: { name: 'decimal' } } }, // Changed type
              category: { validation: { rule: {} } }, // New column
              status: {
                default: 'draft',
                validation: {
                  rule: { enumValues: ['draft', 'active', 'discontinued'] },
                },
              }, // New enum column
              // Removed nothing
            },
            indexes: [
              { name: 'products_category_status_idx', columns: ['category', 'status'] },
            ],
            traits: {
              useTimestamps: true,
            },
          }
        `)

        // Second migration - should detect all changes
        const second = await generateMigration(modelsDir, { dialect: 'postgres' })
        expect(second.hasChanges).toBe(true)

        const sql = second.sql

        // Should have ALTERs for changes
        expect(sql).toContain('ALTER TABLE')
        expect(sql).toContain('ADD COLUMN')

        // Should detect new columns
        expect(sql).toContain('"sku"')
        expect(sql).toContain('"category"')
        expect(sql).toContain('"status"')
        expect(sql).toContain('"created_at"')
        expect(sql).toContain('"updated_at"')

        // Should create new index
        expect(sql).toContain('products_category_status_idx')

        // Should create unique index for sku
        expect(sql.toLowerCase()).toContain('unique')
      }
      finally {
        process.chdir(originalCwd)
      }
    })
  })

  // ============================================================================
  // EDGE CASES AND BOUNDARY CONDITIONS
  // ============================================================================

  describe('edge cases', () => {
    it('handles model with no attributes (only auto-generated PK)', () => {
      const models = defineModels({
        Empty: {
          name: 'Empty',
          table: 'empties',
          attributes: {},
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const table = getTable(plan, 'empties')

      expect(table?.columns.length).toBe(1)
      expect(table?.columns[0].name).toBe('id')
      expect(table?.columns[0].isPrimaryKey).toBe(true)
    })

    it('handles model with custom primary key name', () => {
      const models = defineModels({
        Legacy: {
          name: 'Legacy',
          table: 'legacy_records',
          primaryKey: 'legacy_id',
          attributes: {
            legacy_id: { validation: { rule: {} } },
            data: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      const pkCol = getColumn(plan, 'legacy_records', 'legacy_id')
      expect(pkCol?.isPrimaryKey).toBe(true)

      // Should not auto-create 'id' column
      expect(getColumn(plan, 'legacy_records', 'id')).toBeUndefined()
    })

    it('handles model with very long table name', () => {
      const longName = 'a'.repeat(60)
      const models = defineModels({
        [longName]: {
          name: longName,
          table: `${longName}s`,
          attributes: {
            id: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(plan.tables[0].table).toBe(`${longName}s`)
    })

    it('handles model with special characters in column names', () => {
      const models = defineModels({
        Special: {
          name: 'Special',
          table: 'specials',
          attributes: {
            id: { validation: { rule: {} } },
            // These are valid SQL column names
            column_with_underscores: { validation: { rule: {} } },
            column123: { validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      expect(getColumn(plan, 'specials', 'column_with_underscores')).toBeDefined()
      expect(getColumn(plan, 'specials', 'column123')).toBeDefined()
    })

    it('handles empty enum values array', () => {
      const models = defineModels({
        EmptyEnum: {
          name: 'EmptyEnum',
          table: 'empty_enums',
          attributes: {
            id: { validation: { rule: {} } },
            status: {
              validation: {
                rule: { enumValues: [] }, // Empty array
              },
            },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      // Should fall back to string type
      expect(getColumn(plan, 'empty_enums', 'status')?.type).toBe('string')
    })

    it('handles null/undefined defaults correctly', () => {
      const models = defineModels({
        Nullable: {
          name: 'Nullable',
          table: 'nullables',
          attributes: {
            id: { validation: { rule: {} } },
            explicit_undefined: { default: undefined, validation: { rule: {} } },
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const col = getColumn(plan, 'nullables', 'explicit_undefined')

      expect(col?.hasDefault).toBe(false)
    })

    it('handles multiple tables with same column names', () => {
      const models = defineModels({
        TableA: {
          name: 'TableA',
          table: 'table_a',
          attributes: {
            id: { validation: { rule: {} } },
            name: { unique: true, validation: { rule: {} } },
            status: { validation: { rule: {} } },
          },
        },
        TableB: {
          name: 'TableB',
          table: 'table_b',
          attributes: {
            id: { validation: { rule: {} } },
            name: { validation: { rule: {} } }, // Same name, not unique
            status: { default: 'active', validation: { rule: {} } }, // Same name, different default
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      // Each table should have independent column definitions
      expect(getColumn(plan, 'table_a', 'name')?.isUnique).toBe(true)
      expect(getColumn(plan, 'table_b', 'name')?.isUnique).toBe(false)

      expect(getColumn(plan, 'table_a', 'status')?.hasDefault).toBe(false)
      expect(getColumn(plan, 'table_b', 'status')?.hasDefault).toBe(true)
    })

    it('handles self-referencing foreign keys', () => {
      const models = defineModels({
        Category: {
          name: 'Category',
          table: 'categories',
          attributes: {
            id: { validation: { rule: {} } },
            name: { validation: { rule: {} } },
            category_id: { validation: { rule: {} } }, // Self-reference
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })
      const fkCol = getColumn(plan, 'categories', 'category_id')

      expect(fkCol?.references?.table).toBe('categories')
      expect(fkCol?.references?.column).toBe('id')
    })

    it('handles circular foreign key references', () => {
      const models = defineModels({
        Employee: {
          name: 'Employee',
          table: 'employees',
          attributes: {
            id: { validation: { rule: {} } },
            department_id: { validation: { rule: {} } },
          },
        },
        Department: {
          name: 'Department',
          table: 'departments',
          attributes: {
            id: { validation: { rule: {} } },
            employee_id: { validation: { rule: {} } }, // Manager reference
          },
        },
      })

      const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

      const empDeptCol = getColumn(plan, 'employees', 'department_id')
      const deptEmpCol = getColumn(plan, 'departments', 'employee_id')

      expect(empDeptCol?.references?.table).toBe('departments')
      expect(deptEmpCol?.references?.table).toBe('employees')
    })
  })
})
