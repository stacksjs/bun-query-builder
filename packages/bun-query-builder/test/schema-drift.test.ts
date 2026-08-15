/**
 * Schema drift: the database says one thing, the models say another.
 *
 * Written from two bugs that reached a live site. In both, `migrate` reported
 * "nothing to migrate — your database is already up to date" on every run,
 * because the runner only asks which migration FILES have not executed. It
 * never asks whether the database resembles the models.
 *
 *   - a JSON column sat in `varchar(255)`, so a large payload was refused
 *   - a money column sat in `integer`, so 99.5 stored as 100
 *
 * Neither could be repaired by deploying a corrected migration set, because
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that exists. The
 * schema was wrong, silently, until somebody compared a written number with the
 * one that came back.
 *
 * Most of these test what must NOT be reported. An audit that cries about
 * `int4` versus `integer` teaches people to ignore it, and then it may as well
 * not exist.
 */
import { describe, expect, it } from 'bun:test'
import { familyOfDeclared, familyOfSqlType, formatSchemaDrift, satisfies } from '../src/actions/schema-drift'
import type { SchemaDrift } from '../src/actions/schema-drift'

describe('familyOfSqlType', () => {
  it.each([
    ['character varying(255)', 'varchar'],
    ['varchar(80)', 'varchar'],
    ['nvarchar(40)', 'varchar'],
    ['text', 'text'],
    ['longtext', 'text'],
    ['citext', 'text'],
    ['integer', 'integer'],
    ['int4', 'integer'],
    ['bigint', 'integer'],
    ['bigserial', 'integer'],
    ['smallint', 'integer'],
    ['real', 'fractional'],
    ['float4', 'fractional'],
    ['float8', 'fractional'],
    ['int2', 'integer'],
    ['int8', 'integer'],
    ['double precision', 'fractional'],
    ['numeric(10,2)', 'fractional'],
    ['decimal', 'fractional'],
    ['money', 'fractional'],
    ['boolean', 'boolean'],
    ['bool', 'boolean'],
    ['jsonb', 'json'],
    ['timestamp with time zone', 'date'],
    ['date', 'date'],
    ['bytea', 'binary'],
  ])('reads %s as %s', (sqlType, expected) => {
    expect(familyOfSqlType(sqlType)).toBe(expected as any)
  })

  it('reads tinyint(1) as boolean, not integer', () => {
    // MySQL's boolean. Classifying it as an integer would report every boolean
    // column in a MySQL database as drift.
    expect(familyOfSqlType('tinyint(1)')).toBe('boolean')
    expect(familyOfSqlType('tinyint')).toBe('integer')
  })

  it('does not read `character varying` as text', () => {
    // The substring `char` appears in both. Getting this wrong would hide the
    // exact bug the audit exists for.
    expect(familyOfSqlType('character varying(255)')).toBe('varchar')
  })

  it('returns other for something it does not recognise', () => {
    expect(familyOfSqlType('geography(Point,4326)')).toBe('other')
    expect(familyOfSqlType('')).toBe('other')
  })
})

describe('satisfies', () => {
  it('flags text declared but varchar in the database', () => {
    // Bug one: a serialised report in varchar(255).
    expect(satisfies('text', 'varchar')).toBe(false)
  })

  it('flags fractional declared but integer in the database', () => {
    // Bug two: 99.5 stored as 100.
    expect(satisfies('fractional', 'integer')).toBe(false)
  })

  it('accepts a widening, because nothing is lost', () => {
    expect(satisfies('varchar', 'text')).toBe(true)
    expect(satisfies('integer', 'fractional')).toBe(true)
  })

  it('accepts an exact match', () => {
    for (const family of ['text', 'varchar', 'integer', 'fractional', 'boolean', 'date', 'json'] as const)
      expect(satisfies(family, family)).toBe(true)
  })

  it('stays quiet when either side is unclassifiable', () => {
    // SQLite reports very little and custom types are common. Unknown is not
    // evidence of drift, and guessing here produces noise.
    expect(satisfies('other', 'integer')).toBe(true)
    expect(satisfies('text', 'other')).toBe(true)
  })

  it('flags a boolean column holding something else', () => {
    expect(satisfies('boolean', 'varchar')).toBe(false)
  })
})

describe('familyOfDeclared', () => {
  it('groups the numeric types by whether they hold fractions', () => {
    expect(familyOfDeclared('integer')).toBe('integer')
    expect(familyOfDeclared('bigint')).toBe('integer')
    expect(familyOfDeclared('float')).toBe('fractional')
    expect(familyOfDeclared('double')).toBe('fractional')
    expect(familyOfDeclared('decimal')).toBe('fractional')
  })

  it('separates text from string, which is the whole point', () => {
    expect(familyOfDeclared('text')).toBe('text')
    expect(familyOfDeclared('string')).toBe('varchar')
  })
})

describe('formatSchemaDrift', () => {
  const clean: SchemaDrift = { missingTables: [], missingColumns: [], typeMismatches: [], clean: true }

  it('says nothing when there is nothing to say', () => {
    expect(formatSchemaDrift(clean)).toBe('')
  })

  it('names the column, what it is, and what was declared', () => {
    const report = formatSchemaDrift({
      ...clean,
      clean: false,
      typeMismatches: [{ table: 'events', column: 'value', expected: 'fractional', actual: 'integer', actualSqlType: 'integer' }],
    })

    expect(report).toContain('events.value')
    expect(report).toContain('integer')
    expect(report).toContain('fractional')
  })

  it('says migrations will not fix it', () => {
    // The reader's first instinct is to run migrate again. It will report
    // success and change nothing, so the message has to say so.
    const report = formatSchemaDrift({ ...clean, clean: false, missingTables: ['events'] })

    expect(report).toContain('will NOT fix this')
  })

  it('truncates a long list rather than printing hundreds of lines', () => {
    const report = formatSchemaDrift({
      ...clean,
      clean: false,
      typeMismatches: Array.from({ length: 25 }, (_, index) => ({
        table: 't', column: `c${index}`, expected: 'text', actual: 'varchar', actualSqlType: 'varchar(255)',
      })),
    })

    expect(report).toContain('more')
    expect(report.split('\n').length).toBeLessThan(25)
  })
})
