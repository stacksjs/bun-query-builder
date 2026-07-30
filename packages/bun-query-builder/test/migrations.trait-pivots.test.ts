import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan } from '../src/migrations'

describe('trait migration tables', () => {
  const plan = buildMigrationPlan({
    Post: {
      name: 'Post',
      table: 'posts',
      attributes: {},
      traits: {
        taggable: true,
        categorizable: true,
      },
    },
  } as any, { dialect: 'sqlite' })

  function table(name: string) {
    return plan.tables.find(candidate => candidate.table === name)
  }

  it('uses the canonical plural taxonomy tables', () => {
    expect(table('taggable')).toBeUndefined()
    expect(table('categorizable')).toBeUndefined()

    const taggables = table('taggables')
    expect(taggables).toBeDefined()
    expect(taggables?.columns.find(column => column.name === 'taggable_id')?.isNullable).toBe(true)
    expect(taggables?.indexes).toContainEqual({
      name: 'taggables_type_slug_unique',
      columns: ['taggable_type', 'slug'],
      type: 'unique',
    })

    const categorizables = table('categorizables')
    expect(categorizables).toBeDefined()
    expect(categorizables?.columns.some(column => column.name === 'is_active')).toBe(true)
    expect(categorizables?.columns.some(column => column.name === 'categorizable_type')).toBe(true)
  })

  it('emits timestamped polymorphic pivots with owner uniqueness', () => {
    const tagPivot = table('taggable_models')
    expect(tagPivot?.columns.some(column => column.name === 'updated_at')).toBe(true)
    expect(tagPivot?.columns.find(column => column.name === 'tag_id')?.references?.table).toBe('taggables')
    expect(tagPivot?.indexes).toContainEqual({
      name: 'taggable_models_owner_unique',
      columns: ['tag_id', 'taggable_id', 'taggable_type'],
      type: 'unique',
    })

    const categoryPivot = table('categorizable_models')
    expect(categoryPivot?.columns.some(column => column.name === 'updated_at')).toBe(true)
    expect(categoryPivot?.columns.find(column => column.name === 'category_id')?.references?.table).toBe('categorizables')
    expect(categoryPivot?.indexes).toContainEqual({
      name: 'categorizable_models_owner_unique',
      columns: ['category_id', 'categorizable_id', 'categorizable_type'],
      type: 'unique',
    })
  })
})
