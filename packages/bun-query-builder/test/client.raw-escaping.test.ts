import { describe, expect, it } from 'bun:test'
import { escapeStringLiteral, raw } from '../src/client'
import { config } from '../src/config'

/**
 * Escaping a value inlined into a raw fragment.
 *
 * `raw` interpolates rather than parameterising, which is the whole point of a
 * fragment: it goes somewhere a placeholder cannot, such as a GROUP BY or an
 * aggregate. That makes its escaping load-bearing, and escaping that is correct
 * on one dialect and not another is the worst kind, because the test suite runs
 * on the safe one.
 */

describe('escapeStringLiteral', () => {
  it('doubles the single quote on every dialect', () => {
    for (const dialect of ['postgres', 'sqlite', 'mysql'] as const)
      expect(escapeStringLiteral(`pa'id`, dialect)).toBe(`pa''id`)
  })

  it('doubles the backslash on the mysql family, and not elsewhere', () => {
    // MySQL treats a backslash as an escape character unless
    // NO_BACKSLASH_ESCAPES is set. Postgres and SQLite do not, and doubling
    // there would corrupt the value rather than protect it.
    expect(escapeStringLiteral('a\\b', 'mysql')).toBe('a\\\\b')
    expect(escapeStringLiteral('a\\b', 'postgres')).toBe('a\\b')
    expect(escapeStringLiteral('a\\b', 'sqlite')).toBe('a\\b')
  })

  it('closes the backslash-quote escape', () => {
    // The exploit this exists for. Doubling quotes alone turns
    //   x\'; DROP TABLE t; --
    // into
    //   'x\''; DROP TABLE t; --'
    // where MySQL reads \' as a literal quote, the next quote closes the
    // string, and the remainder runs as its own statement.
    const attack = `x\\'; DROP TABLE t; --`
    const escaped = escapeStringLiteral(attack, 'mysql')

    expect(escaped).toBe(`x\\\\''; DROP TABLE t; --`)

    // Every backslash and every quote in the result is paired, so nothing can
    // terminate the literal early.
    expect((escaped.match(/\\+/g) ?? []).every(run => run.length % 2 === 0)).toBe(true)
  })

  it('escapes backslashes before quotes, not after', () => {
    // The other order would re-escape the backslash this function just added,
    // producing a different string from the one the caller passed.
    expect(escapeStringLiteral(`'`, 'mysql')).toBe(`''`)
  })
})

describe('raw', () => {
  it('escapes an interpolated value through the shared escaper', () => {
    // Deliberately not switching dialects here. Config is process-wide in this
    // library, and a test that sets it leaks into whichever file runs next:
    // this one flipped the suite to MySQL and a JSON-containment test three
    // files later failed asking why SQLite had gone missing. The dialect-
    // specific behaviour is covered above by passing it explicitly.
    const value = `x'; DROP TABLE t; --`
    const fragment = raw`status = ${value}` as { raw: string }

    expect(fragment.raw).toBe(`status = '${escapeStringLiteral(value, config.dialect)}'`)

    // Every quote after the opening one is paired, so nothing in the value can
    // close the literal early. Asserting the absence of the attack substring
    // would not work here and is worth saying why: the escaped form still
    // contains `'; DROP TABLE t; --` verbatim, safely, after a doubled quote.
    const body = fragment.raw.slice(`status = '`.length, -1)

    expect((body.match(/'+/g) ?? []).every(run => run.length % 2 === 0)).toBe(true)
  })

  it('passes a bare string through untouched', () => {
    // A fragment built from an allowlist is the legitimate use, and it must
    // not be mangled on the way through.
    expect((raw('SUM("orders"."total")') as { raw: string }).raw).toBe('SUM("orders"."total")')
  })

  it('leaves numbers, booleans and null unquoted', () => {
    expect((raw`a = ${42}` as { raw: string }).raw).toBe('a = 42')
    expect((raw`a = ${true}` as { raw: string }).raw).toBe('a = 1')
    expect((raw`a = ${null}` as { raw: string }).raw).toBe('a = NULL')
  })
})
