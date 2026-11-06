/**
 * A column named after a MySQL reserved word (`when`, `repeat`, `order`) must be
 * quoted wherever the model builder writes it into a statement.
 *
 * The client layer already quoted columns for MySQL, but the model builder only
 * snake-cased them, so `Todo.where('when', 'today')` went out as
 * `WHERE when = ?` and MySQL answered with a syntax error that named neither
 * the model nor the column. SQLite and Postgres reject `when` too (`near
 * "when": syntax error`), so their reserved words are quoted as well, and only
 * those: quoting an ordinary name there would make it case-sensitive.
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
    // The table is back-quoted too since #1207 — MySQL quotes every plain
    // identifier, tables included, so `order` or `user` works as a table name.
    expect(sql).toContain('SELECT `title`, `when` FROM `rc_todos`')
    expect(sql).toContain('`when` = ?')
    expect(sql).toContain('`repeat` IN')
    expect(sql).toContain('ORDER BY `when` ASC')
    expect(sql).not.toMatch(/[^`]\bwhen\b[^`]/)
  })

  it('quotes both sides of table.column', () => {
    config.dialect = 'mysql' as any
    expect(Todo.orderBy('rc_todos.when').toSql().sql).toContain('ORDER BY `rc_todos`.`when` ASC')
  })

  it('quotes only the reserved words on SQLite and Postgres', () => {
    for (const name of ['sqlite', 'postgres']) {
      config.dialect = name as any
      const { sql } = Todo.where('when', 'today').where('title', 'x').orderBy('repeat').toSql()
      expect(sql).toContain('"when" = ?')
      expect(sql).toContain('title = ?')
      expect(sql).toContain('ORDER BY repeat ASC')
      expect(sql).not.toContain('`')
    }
  })

  it('quotes a reserved table.column part by part on SQLite', () => {
    config.dialect = 'sqlite' as any
    expect(Todo.orderBy('rc_todos.when').toSql().sql).toContain('ORDER BY rc_todos."when" ASC')
  })

  it('writes a reserved column into INSERT and UPDATE on SQLite', async () => {
    config.dialect = 'sqlite' as any
    const db = new Database(':memory:', { create: true })
    db.run('CREATE TABLE rc_todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, "when" TEXT, repeat TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)')
    configureOrm({ database: db })
    const row = await Todo.create({ title: 'a', when: 'today', repeat: 'daily' })
    await Todo.where('id', row.id).update({ when: 'someday' })
    expect((await Todo.find(row.id)).get('when')).toBe('someday')
  })
})
