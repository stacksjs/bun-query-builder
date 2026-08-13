// The faker a factory is handed, against the faker it is written for.
//
// Model factories in this ecosystem are written in the faker-js dialect, and
// `@stacksjs/ts-faker` is a smaller, differently-spelled surface. Handing a
// factory the raw instance is `arrayElement is not a function` at seed time -
// in the one code path nobody runs until they are setting up a new environment,
// which is the worst possible moment to discover it.
//
// So the cases below are the translations, and the reason each exists is a
// call somebody has already written.

import { describe, expect, test } from 'bun:test'
import { createFakerCompatLayer } from '../src/faker-compat'

/** A stand-in for ts-faker: the shape, not the data. */
function underlying() {
  return {
    string: {
      alpha: (options?: { length?: number }) => 'a'.repeat(options?.length ?? 1),
      alphanumeric: (options?: { length?: number }) => 'x'.repeat(options?.length ?? 1),
      numeric: (options?: { length?: number }) => '7'.repeat(options?.length ?? 1),
      hexadecimal: (options?: { length?: number }) => 'f'.repeat(options?.length ?? 1),
      uuid: () => 'uuid-from-underlying',
    },
    number: {
      int: (options?: { min?: number, max?: number }) => options?.max ?? 0,
      float: () => 1.23456,
    },
    random: { boolean: () => true },
    address: { city: () => 'Underlying City' },
    company: { catchphrase: () => 'a flattened catchphrase', bs: () => 'a buzz phrase' },
    vehicle: { registration: () => 'REG 123' },
    lorem: { word: () => 'lorem' },
  }
}

describe('the surface factories are written against', () => {
  test('helpers.arrayElement exists, which is the one ts-faker has no answer for', () => {
    // The most-used faker-js helper by a distance: every enum-valued factory in
    // the ecosystem calls it, and without it every one of them throws.
    const faker = createFakerCompatLayer(underlying())
    const chosen = faker.helpers.arrayElement(['draft', 'published', 'archived'])

    expect(['draft', 'published', 'archived']).toContain(chosen)
  })

  test('arrayElements and shuffle return the members they were given', () => {
    const faker = createFakerCompatLayer(underlying())

    expect(faker.helpers.arrayElements(['a', 'b', 'c'], 2)).toHaveLength(2)
    expect([...faker.helpers.shuffle(['a', 'b', 'c'])].sort()).toEqual(['a', 'b', 'c'])
  })

  test('slugify, because a factory for a slug column is a factory somebody writes', () => {
    expect(createFakerCompatLayer(underlying()).helpers.slugify('Hello There World')).toBe('hello-there-world')
  })

  test('a bare length is an options object, not a silently ignored argument', () => {
    // `faker.string.alphanumeric(12)` passed straight through returns ts-faker's
    // default length, so the column gets a one-character string and nothing
    // reports anything.
    const faker = createFakerCompatLayer(underlying())

    expect(faker.string.alphanumeric(12)).toHaveLength(12)
    expect(faker.string.alpha(4)).toBe('aaaa')
    expect(faker.string.hexadecimal(6)).toHaveLength(6)
    expect(faker.string.alphanumeric({ length: 3 })).toHaveLength(3)
  })

  test('a bare number to number.int is a maximum, the way faker-js reads it', () => {
    // Reading it as a minimum would produce ids that climb forever.
    expect(createFakerCompatLayer(underlying()).number.int(100)).toBe(100)
  })

  test('fractionDigits rounds, since ts-faker has no equivalent', () => {
    const faker = createFakerCompatLayer(underlying())

    expect(faker.number.float({ min: 1, max: 2, fractionDigits: 2 })).toBe(1.23)
    expect(faker.number.float({ min: 1, max: 2 })).toBe(1.23456)
  })

  test('datatype still works, because half the factories ever written use it', () => {
    const faker = createFakerCompatLayer(underlying())

    expect(faker.datatype.number({ min: 1, max: 9 })).toBe(9)
    expect(typeof faker.datatype.uuid()).toBe('string')
    expect(faker.datatype.string(5)).toHaveLength(5)
    expect(faker.datatype.boolean()).toBe(true)
  })

  test('and datatype.boolean honours a probability rather than ignoring it', () => {
    const faker = createFakerCompatLayer(underlying())

    expect(faker.datatype.boolean({ probability: 1 })).toBe(true)
    expect(faker.datatype.boolean({ probability: 0 })).toBe(false)
  })

  test('location is address, which is what faker-js renamed it to', () => {
    expect(createFakerCompatLayer(underlying()).location.city()).toBe('Underlying City')
  })

  test('a camelCase method finds its flattened twin', () => {
    // ts-faker spells multi-word methods in one lowercase run. Listing every
    // pair by hand would go stale on its next release, so the proxy tries the
    // flattened form for any miss.
    const faker = createFakerCompatLayer(underlying())

    expect(faker.company.catchPhrase()).toBe('a flattened catchphrase')
    expect(faker.company.buzzPhrase()).toBe('a buzz phrase')
    expect(faker.vehicle.vrm()).toBe('REG 123')
  })

  test('anything not translated is passed through untouched', () => {
    // The wrapper adapts; it does not stand between a factory and the generator
    // it asked for.
    expect(createFakerCompatLayer(underlying()).lorem.word()).toBe('lorem')
  })

  test('and a module that does not exist is undefined rather than a crash', () => {
    expect(createFakerCompatLayer({}).helpers.arrayElement(['only'])).toBe('only')
    expect(createFakerCompatLayer({} as any).nothing).toBeUndefined()
  })
})
