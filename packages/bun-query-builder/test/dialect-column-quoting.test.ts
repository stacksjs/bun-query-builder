// Column names MySQL reserves, and the schema that uses them anyway.
//
// `condition`, `uses`, `key`, `groups`, `rank`: ordinary words a domain model
// reaches for, and reserved words in MySQL. Unquoted, each one is a syntax
// error at that point in the statement rather than a bad-column error - so the
// message names the *next* token and sends the reader somewhere else entirely.
// ReviewOS met it as one SELECT failing 167 times in a single suite run.

import { describe, expect, test } from 'bun:test'
import { quoteColumnForDialect } from '../src/client'

describe('quoting a column for the dialect', () => {
  test('wraps a plain identifier on MySQL, so a reserved word parses', () => {
    expect(quoteColumnForDialect('condition', 'mysql')).toBe('`condition`')
    expect(quoteColumnForDialect('key', 'mysql')).toBe('`key`')
    expect(quoteColumnForDialect('uses', 'mysql')).toBe('`uses`')
  })

  test('wraps both halves of a qualified name', () => {
    expect(quoteColumnForDialect('jobs.condition', 'mysql')).toBe('`jobs`.`condition`')
  })

  test('quotes an alias too, since it is the same reserved word', () => {
    // The second shape of this bug, found after the first fix shipped: a select
    // list of `t.condition as condition` still stopped the parser, on the
    // alias.
    expect(quoteColumnForDialect('workflow_version_steps.condition as condition', 'mysql'))
      .toBe('`workflow_version_steps`.`condition` AS `condition`')
    expect(quoteColumnForDialect('name as n', 'mysql')).toBe('`name` AS `n`')
  })

  test('leaves anything that is not a plain identifier exactly as written', () => {
    // Quoting these would break them, which is why the rule is narrow.
    for (const expression of ['*', 'count(*)', 'count(*) as n', 'a.*', '`already`', 'MAX(created_at)', 'MAX(x) as m']) {
      expect(quoteColumnForDialect(expression, 'mysql')).toBe(expression)
    }
  })

  test('leaves Postgres alone, where quoting changes the meaning', () => {
    // A quoted identifier is case-*sensitive* there, so quoting `createdAt`
    // would stop it matching the `createdat` the server actually stored - a
    // fix that breaks a working query.
    expect(quoteColumnForDialect('condition', 'postgres')).toBe('condition')
    expect(quoteColumnForDialect('createdAt', 'postgres')).toBe('createdAt')
  })

  test('covers the MySQL-wire dialects, which have the same reserved words', () => {
    expect(quoteColumnForDialect('condition', 'vitess')).toBe('`condition`')
    expect(quoteColumnForDialect('condition', 'singlestore')).toBe('`condition`')
  })
})
