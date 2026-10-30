/**
 * A column named after a MySQL reserved word (`when`, `repeat`, `order`) must be
 * quoted wherever the model builder writes it into a statement.
 *
 * The client layer already quoted columns for MySQL, but the model builder only
 * snake-cased them, so `Todo.where('when', 'today')` went out as
 * `WHERE when = ?` and MySQL answered with a syntax error that named neither
 * the model nor the column. Postgres and SQLite must stay unquoted: quoting
 * makes a name case-sensitive there.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { clearModelRegistry, configureOrm, createModel } from '../src'
import { config } from '../src/config'

let dialect: string
let Todo: any

beforeEach(() => {
  clearModelRegistry()
  dialect = config.dialect
  configureOrm({ database: new Database(':memory:', { create: true }) })
  Todo = createModel({
    name: 'Rctodo',
    table: 'rc_todos',
    primaryKey: 'id',
    autoIncrement: true,
    traits: { useSoftDeletes: true },
    attributes: {
      title: { type: 'string', fillable: true },
      when: { type: 'string', fillable: true },
      repeat: { type: 'string', fillable: true },
    },
  } as any)
})

afterEach(() => { config.dialect = dialect as any })

describe('MySQL reserved-word columns', () => {
  it('quotes them in WHERE, ORDER BY and the select list', () => {
    config.dialect = 'mysql' as any
    const { sql } = Todo.where('when', 'today').whereIn('repeat', ['daily']).orderBy('when').select('title', 'when').toSql()
    expect(sql).toContain('SELECT `title`, `when` FROM rc_todos')
    expect(sql).toContain('`when` = ?')
    expect(sql).toContain('`repeat` IN')
    expect(sql).toContain('ORDER BY `when` ASC')
    expect(sql).not.toMatch(/[^`]\bwhen\b[^`]/)
  })

  it('quotes both sides of table.column', () => {
    config.dialect = 'mysql' as any
    expect(Todo.orderBy('rc_todos.when').toSql().sql).toContain('ORDER BY `rc_todos`.`when` ASC')
  })

  it('leaves SQLite and Postgres identifiers unquoted', () => {
    for (const name of ['sqlite', 'postgres']) {
      config.dialect = name as any
      const { sql } = Todo.where('when', 'today').orderBy('repeat').toSql()
      expect(sql).toContain('when = ?')
      expect(sql).not.toContain('`')
    }
  })
})
