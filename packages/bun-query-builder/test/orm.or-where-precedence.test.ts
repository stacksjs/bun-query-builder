/**
 * The ORM had the same ungrouped-OR defect as the select builder (#1083),
 * reached by a different route.
 *
 * Unlike the select builder it DID keep a structured term list (`_wheres`, each
 * with a `boolean: 'and' | 'or'`) — it just rendered it flat:
 *
 *     clauses.push(i === 0 ? clause : `${w.boolean.toUpperCase()} ${clause}`)
 *
 * so the grouping was left to SQL's precedence and `.where(a).whereLike(b)
 * .orWhereLike(c)` meant `(a AND b) OR c`. Having the right data structure is
 * not the same as using it; that gap is worth a test of its own, because the
 * next reader will see `_wheres` and assume this case is covered.
 *
 * `update()` and `delete()` share buildWhereClauses, so the mis-grouping was
 * not read-only — a widened WHERE on a DELETE removes rows the filter existed
 * to protect. That half is asserted here too.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { configureOrm, createModel, createTableFromModel, getDatabase } from '../src/orm'

const Row = createModel({
  name: 'PrecRow',
  table: 'prec_rows',
  primaryKey: 'id',
  autoIncrement: true,
  attributes: {
    name: { type: 'string', fillable: true },
    batch: { type: 'integer', fillable: true },
  },
} as const)

describe('ORM orWhere grouping (#1083)', () => {
  beforeAll(() => {
    configureOrm({ database: ':memory:' })
  })

  beforeEach(async () => {
    const db = getDatabase()
    db.run('DROP TABLE IF EXISTS prec_rows')
    await createTableFromModel(Row.getDefinition())
    // 20 rows: ids 1-10 `create_*`, 11-20 `alter_*`; batch 1 for ids <= 5.
    for (let i = 1; i <= 20; i++)
      await Row.create({ name: i <= 10 ? `create_${i}_table` : `alter_${i}_table`, batch: i <= 5 ? 1 : 2 })
  })

  afterAll(() => getDatabase().close())

  it('brackets a trailing OR run', () => {
    const { sql } = Row.query()
      .where('batch', 1)
      .whereLike('name', '%create%')
      .orWhereLike('name', '%alter%')
      .toSql()

    // Was `batch = ? AND name like ? OR name like ?`.
    expect(sql).toContain('batch = ? AND (name like ? OR name like ?)')
  })

  it('returns the bounded rows, not the superset', async () => {
    const rows = await Row.query()
      .where('batch', 1)
      .whereLike('name', '%create%')
      .orWhereLike('name', '%alter%')
      .get()

    // Was 15: every `alter_*` row came back regardless of batch.
    expect(rows.length).toBe(5)
    // Number(): `type: 'integer'` currently generates a TEXT column in
    // createTableFromModel, so this reads back as '1'. Unrelated to #1083 —
    // coerced rather than asserted on, so this test fails for its own reason
    // or not at all.
    expect(rows.every(r => Number(r.get('batch')) === 1)).toBe(true)
  })

  it('brackets a leading OR run against the AND that follows', async () => {
    const rows = await Row.query()
      .where('batch', 1)
      .orWhereLike('name', '%alter%')
      .where('id', '<=', 12)
      .get()

    // `(batch = 1 OR name like '%alter%') AND id <= 12` — ids 1-5 and 11-12.
    expect(rows.map(r => r.get('id'))).toEqual([1, 2, 3, 4, 5, 11, 12])
  })

  it('leaves a two-term OR chain unbracketed', () => {
    const { sql } = Row.query().where('batch', 1).orWhereLike('name', '%alter%').toSql()

    expect(sql).toContain('batch = ? OR name like ?')
    expect(sql).not.toContain('(')
  })

  it('does not emit a leading OR when orWhere is the first term', () => {
    const { sql } = Row.query().orWhere('batch', 1).toSql()

    expect(sql).not.toMatch(/WHERE\s+OR\b/)
    expect(sql).toContain('WHERE batch = ?')
  })

  it('whereGroup still emits one pre-parenthesised term', () => {
    // _addGroup pushes an already-bracketed raw clause; renderWhereTerms must
    // not wrap it a second time.
    const { sql } = Row.query()
      .whereGroup(b => b.where('batch', 1).orWhere('batch', 2))
      .whereLike('name', '%create%')
      .toSql()

    expect(sql).toContain('(batch = ? OR batch = ?) AND name like ?')
    expect(sql).not.toContain('((')
  })

  it('delete() respects the grouping instead of widening', async () => {
    // The dangerous half: buildWhereClauses is shared with delete(), so the
    // flat OR removed rows the filter was meant to protect.
    await Row.query()
      .where('batch', 1)
      .whereLike('name', '%create%')
      .orWhereLike('name', '%alter%')
      .delete()

    const left = await Row.query().get()
    // 15 survive (20 minus the 5 batch-1 create rows). Under the flat OR this
    // deleted 15 and left 5.
    expect(left.length).toBe(15)
  })
})
