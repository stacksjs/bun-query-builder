/**
 * `orWhere` refuses rather than transmitting a disjunction as a conjunction.
 * stacksjs/bun-query-builder#1096 — the half left open by #1108.
 *
 * Both browser builders recorded `boolean: 'or'` on the where list, and
 * `buildQueryParams` never read it. Every recorded where was appended as one
 * more parameter, which any receiving API reads as AND:
 *
 *     .where('role', 'admin').orWhere('role', 'moderator')
 *     -> role=admin&role=moderator
 *
 * So the query returned a superset of the intended rows, with no error and a
 * request that looks correct in a network panel.
 *
 * Throwing is the honest option here. The alternative — inventing a wire
 * spelling like `filter[col][or][]` — would have to be agreed with whatever
 * serves these requests; shipping one unilaterally produces the same silent
 * failure, one layer further away, when the server ignores what it does not
 * recognise.
 *
 * This IS a behaviour break for anyone calling orWhere today. What they have
 * today is already wrong, just quietly, so the break replaces bad rows with a
 * message naming the constraint and the two ways around it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { BrowserQueryBuilder, configureBrowser, createBrowserModel } from '../src/browser'

const realFetch = globalThis.fetch
let captured: string[] = []

beforeEach(() => {
  captured = []
  globalThis.fetch = (async (input: any) => {
    captured.push(typeof input === 'string' ? input : String(input?.url ?? input))
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
  configureBrowser({ baseUrl: 'http://x.test/api' } as any)
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const User = createBrowserModel({
  name: 'User',
  table: 'users',
  traits: { useApi: { uri: 'users' } },
  attributes: { role: { fillable: true }, status: { fillable: true } },
} as any)

describe('BrowserModelQueryBuilder.orWhere is refused (#1096)', () => {
  it('throws instead of recording a term that would be sent as AND', () => {
    expect(() => (User as any).query().where('role', 'admin').orWhere('role', 'moderator'))
      .toThrow(/orWhere\(\) is not supported by this client/)
  })

  it('the message says why, not just no', () => {
    let message = ''
    try {
      (User as any).query().orWhere('role', 'moderator')
    }
    catch (error: any) {
      message = error.message
    }

    // Naming the mechanism is the point: the caller has to know the term would
    // have been read as AND, or the refusal looks arbitrary.
    expect(message).toContain('no spelling for a disjunction')
    expect(message).toContain('AND')
    // And it has to leave them somewhere to go.
    expect(message).toContain('whereIn')
  })

  it('it is a TypeError, matching the other refusals in this codebase', () => {
    expect(() => (User as any).query().orWhere('role', 'moderator')).toThrow(TypeError)
  })

  it('nothing is sent — the throw happens at the call, not at the request', async () => {
    expect(() => (User as any).query().where('role', 'admin').orWhere('role', 'x')).toThrow()
    expect(captured).toEqual([])
  })
})

describe('BrowserQueryBuilder.orWhere is refused too (#1096)', () => {
  it('both builders agree', () => {
    const qb = new BrowserQueryBuilder('users' as any)
    expect(() => (qb as any).where('role', 'admin').orWhere('role', 'moderator'))
      .toThrow(/orWhere\(\) is not supported by this client/)
  })
})

describe('the conjunctive paths are untouched (#1096)', () => {
  it('chained where() still serialises as before', async () => {
    await (User as any).query().where('role', 'admin').where('status', 'active').get()

    expect(captured).toHaveLength(1)
    expect(captured[0]).toContain('role=admin')
    expect(captured[0]).toContain('status=active')
  })

  it('whereIn — the suggested replacement — still works', async () => {
    await (User as any).query().whereIn('role', ['admin', 'moderator']).get()

    expect(captured).toHaveLength(1)
    // The alternatives-as-one-filter form the error message points at.
    expect(decodeURIComponent(captured[0])).toContain('role[]=admin,moderator')
  })
})
