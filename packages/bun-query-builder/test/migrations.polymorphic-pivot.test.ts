/**
 * A declared `belongsToMany` pivot must not constrain a polymorphic column.
 *
 * The main loop already knows this: `taggable_id` beside `taggable_type` points
 * at whichever table that row's type names, so no single-table foreign key can
 * be correct. The inline-pivot builder did not, and referenced the related
 * model's table unconditionally.
 *
 * What that produced, in a real application: a constraint on
 * `taggable_models.taggable_id` against `posts`, because `posts` is what the
 * `taggable_type` column happened to default to. Tagging a post worked; tagging
 * anything else was rejected by the database, naming a table the model never
 * mentions.
 */

import { describe, expect, it } from 'bun:test'
import { buildMigrationPlan } from '../src/migrations'
import { defineModels } from '../src/schema'

function columnOf(plan: any, table: string, column: string) {
  return plan.tables.find((entry: any) => entry.table === table)?.columns.find((entry: any) => entry.name === column)
}

function build(pivot: any, relatedKey = 'taggable_id') {
  const models = defineModels({
    Post: { name: 'Post', table: 'posts', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    Taggable: { name: 'Taggable', table: 'taggables', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
    Tag: {
      name: 'Tag',
      table: 'tags',
      primaryKey: 'id',
      attributes: { id: { validation: { rule: {} } } },
      belongsToMany: {
        taggables: {
          model: 'Taggable',
          table: 'taggable_models',
          foreignKey: 'tag_id',
          relatedKey,
          pivot,
        },
      },
    },
  } as any)

  return buildMigrationPlan(models as any, { dialect: 'postgres' })
}

describe('inline pivot foreign keys', () => {
  it('leaves a polymorphic id column unconstrained', () => {
    const plan = build({
      columns: { taggable_type: { default: 'posts' } },
      uniques: [['tag_id', 'taggable_id', 'taggable_type']],
    })

    expect(columnOf(plan, 'taggable_models', 'taggable_id').references).toBeUndefined()
  })

  /** The non-polymorphic half of the same pivot still gets its key. */
  it('still constrains the parent side', () => {
    const plan = build({
      columns: { taggable_type: { default: 'posts' } },
      uniques: [['tag_id', 'taggable_id', 'taggable_type']],
    })

    expect(columnOf(plan, 'taggable_models', 'tag_id').references).toEqual({ table: 'tags', column: 'id' })
  })

  /** Without a `_type` sibling there is nothing polymorphic, and the key belongs. */
  it('constrains an ordinary pivot as before', () => {
    const plan = build({ timestamps: true }, 'taggable_id')

    expect(columnOf(plan, 'taggable_models', 'taggable_id').references).toEqual({ table: 'taggables', column: 'id' })
    expect(columnOf(plan, 'taggable_models', 'tag_id').references).toEqual({ table: 'tags', column: 'id' })
  })

  /** The rule is about the pair, not about the name: a polymorphic parent side counts too. */
  it('leaves a polymorphic parent column unconstrained', () => {
    const models = defineModels({
      Post: { name: 'Post', table: 'posts', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
      Thing: { name: 'Thing', table: 'things', primaryKey: 'id', attributes: { id: { validation: { rule: {} } } } },
      Owner: {
        name: 'Owner',
        table: 'owners',
        primaryKey: 'id',
        attributes: { id: { validation: { rule: {} } } },
        belongsToMany: {
          things: {
            model: 'Thing',
            table: 'ownable_things',
            foreignKey: 'ownable_id',
            relatedKey: 'thing_id',
            pivot: { columns: { ownable_type: { default: 'posts' } } },
          },
        },
      },
    } as any)

    const plan = buildMigrationPlan(models as any, { dialect: 'postgres' })

    expect(columnOf(plan, 'ownable_things', 'ownable_id').references).toBeUndefined()
    expect(columnOf(plan, 'ownable_things', 'thing_id').references).toEqual({ table: 'things', column: 'id' })
  })

  /** No `ADD CONSTRAINT` should reach the SQL either, not just the plan. */
  it('emits no foreign key statement for the polymorphic column', () => {
    const plan = build({
      columns: { taggable_type: { default: 'posts' } },
      uniques: [['tag_id', 'taggable_id', 'taggable_type']],
    })

    const sql = JSON.stringify(plan)

    expect(sql).not.toContain('"taggable_id","references"')
  })
})
