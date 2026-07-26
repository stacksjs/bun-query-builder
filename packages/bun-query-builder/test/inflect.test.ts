import { describe, expect, it } from 'bun:test'
import { inflectSingular, singularizerFor, stripTrailingS } from '../src/inflect'

describe('singularization strategies', () => {
  describe('stripTrailingS (default, legacy)', () => {
    it('handles the simple case', () => {
      expect(stripTrailingS('posts')).toBe('post')
      expect(stripTrailingS('users')).toBe('user')
    })

    it('mangles everything else — the reason `inflect` exists', () => {
      expect(stripTrailingS('categories')).toBe('categorie')
      expect(stripTrailingS('addresses')).toBe('addresse')
      expect(stripTrailingS('status')).toBe('statu')
    })
  })

  describe('inflect', () => {
    it('inverts the y -> ies rule', () => {
      expect(inflectSingular('categories')).toBe('category')
      expect(inflectSingular('companies')).toBe('company')
    })

    it('leaves vowel+y plurals alone (day -> days, not daies)', () => {
      expect(inflectSingular('days')).toBe('day')
      expect(inflectSingular('keys')).toBe('key')
    })

    it('inverts the s/x/ch/sh + es rule', () => {
      expect(inflectSingular('addresses')).toBe('address')
      expect(inflectSingular('boxes')).toBe('box')
      expect(inflectSingular('batches')).toBe('batch')
      expect(inflectSingular('dishes')).toBe('dish')
    })

    it('inverts the bare-s rule', () => {
      expect(inflectSingular('posts')).toBe('post')
      expect(inflectSingular('treatment_maps')).toBe('treatment_map')
    })

    it('leaves words that were never plural untouched', () => {
      expect(inflectSingular('status')).toBe('status')
      expect(inflectSingular('bus')).toBe('bus')
      expect(inflectSingular('analysis')).toBe('analysis')
      expect(inflectSingular('data')).toBe('data')
    })

    it('round-trips the built-in pluralization rules', () => {
      // Mirrors toTableName() in orm.ts
      const pluralize = (s: string) => {
        if (s.endsWith('y') && !/[aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`
        if (s.endsWith('s') || s.endsWith('x') || s.endsWith('ch') || s.endsWith('sh')) return `${s}es`
        return `${s}s`
      }
      for (const word of ['post', 'user', 'category', 'company', 'address', 'box', 'batch', 'dish', 'day', 'treatment_map'])
        expect(inflectSingular(pluralize(word))).toBe(word)
    })
  })

  describe('singularizerFor', () => {
    it('defaults to the legacy strip', () => {
      expect(singularizerFor(undefined)('categories')).toBe('categorie')
      expect(singularizerFor('stripTrailingS')('categories')).toBe('categorie')
    })

    it('opts in to inflection', () => {
      expect(singularizerFor('inflect')('categories')).toBe('category')
    })

    it('can be turned off entirely', () => {
      expect(singularizerFor('none')('categories')).toBe('categories')
    })
  })
})
