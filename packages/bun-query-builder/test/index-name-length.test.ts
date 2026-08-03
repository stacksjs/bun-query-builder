/**
 * Index names the database will actually store.
 *
 * Postgres truncates any identifier over 63 bytes, silently, with a notice
 * nobody reads. The database then holds a name the model never declared, so the
 * next diff looks for the declared name, does not find it, and proposes
 * creating it - on every run, forever. That is what "drop and recreate this
 * index, unchanged, every time" looks like from the outside.
 */

import { describe, expect, it } from 'bun:test'
import { boundIdentifier, MAX_IDENTIFIER_LENGTH, qualifiedIndexName } from '../src/drivers/index-name'

/** The name that surfaced this, from a real polymorphic pivot. */
const LONG = 'categorizable_models_category_id_categorizable_id_categorizable_type_unique'

describe('boundIdentifier', () => {
  it('leaves a name that fits exactly as it is', () => {
    expect(boundIdentifier('issues_repo_number_index')).toBe('issues_repo_number_index')
  })

  it('leaves a name of exactly the limit alone', () => {
    const name = 'x'.repeat(MAX_IDENTIFIER_LENGTH)

    expect(boundIdentifier(name)).toBe(name)
  })

  it('brings a longer name within the limit', () => {
    expect(boundIdentifier(LONG).length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH)
  })

  /** The same index must shorten to the same thing, or the churn comes back. */
  it('is deterministic', () => {
    expect(boundIdentifier(LONG)).toBe(boundIdentifier(LONG))
  })

  /** Two names sharing a long prefix must not collapse onto one another. */
  it('separates names that differ only past the cut', () => {
    const a = `${'a'.repeat(70)}_one_unique`
    const b = `${'a'.repeat(70)}_two_unique`

    expect(boundIdentifier(a)).not.toBe(boundIdentifier(b))
  })

  it('keeps the readable front of the name', () => {
    expect(boundIdentifier(LONG)).toStartWith('categorizable_models_category_id')
  })

  it('respects a different limit, for a dialect with one', () => {
    expect(boundIdentifier(LONG, 30).length).toBeLessThanOrEqual(30)
  })
})

describe('qualifiedIndexName', () => {
  it('prefixes an unqualified name with its table', () => {
    expect(qualifiedIndexName('issues', 'repo_number_index')).toBe('issues_repo_number_index')
  })

  /** A model may declare either spelling for the same index. */
  it('leaves an already-qualified name alone', () => {
    expect(qualifiedIndexName('issues', 'issues_repo_number_index')).toBe('issues_repo_number_index')
  })

  it('bounds the result, however it was spelled', () => {
    expect(qualifiedIndexName('categorizable_models', LONG).length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH)
  })

  /**
   * The whole point: the diff compares what the model declares against what the
   * database reports, and those only agree if one function produced both.
   */
  it('gives the same answer for both spellings of one index', () => {
    const fromModel = qualifiedIndexName('categorizable_models', 'category_id_categorizable_id_categorizable_type_unique')
    const fromDatabase = qualifiedIndexName('categorizable_models', LONG)

    expect(fromModel).toBe(fromDatabase)
  })

  it('is stable when applied twice', () => {
    const once = qualifiedIndexName('categorizable_models', LONG)

    expect(qualifiedIndexName('categorizable_models', once)).toBe(once)
  })
})
