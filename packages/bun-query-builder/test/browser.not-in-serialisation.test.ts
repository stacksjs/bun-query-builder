/**
 * `whereNotIn` must not serialise identically to `whereIn`.
 * stacksjs/bun-query-builder#1096.
 *
 * `BrowserModelQueryBuilder.buildQueryParams` matched `in` and `not in` in the
 * same branch, so both emitted `column[]=a,b`. An exclusion went out on the
 * wire byte-identical to an inclusion, and the server answered with exactly the
 * rows the caller meant to remove.
 *
 * The idiom is overwhelmingly "exclude banned / deleted / private", so the
 * failure mode is showing the records you meant to hide — with no error, and
 * with a request that looks correct in a network panel.
 *
 * The sibling `BrowserQueryBuilder` already matched `in` alone and let `not in`
 * fall through to the `filter[column][operator]` branch, so this asserts the
 * two builders agree as well as that the exclusion survives.
 *
 * These read the outgoing URL rather than a mock server's interpretation of it:
 * the defect was entirely in what went on the wire.
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

/** The query string of the single request the call produced. */
function sentQuery(): URLSearchParams {
  expect(captured).toHaveLength(1)
  return new URL(captured[0]).searchParams
}

const Widget = createBrowserModel({
  name: 'Nwidget',
  table: 'nwidgets',
  primaryKey: 'id',
  attributes: {
    role: { type: 'string', fillable: true },
    name: { type: 'string', fillable: true },
  },
} as any)

describe('BrowserModelQueryBuilder not-in serialisation (#1096)', () => {
  it('sends an exclusion differently from an inclusion', async () => {
    await (Widget as any).query().whereIn('role', ['banned']).get()
    const inclusion = sentQuery()

    captured = []
    await (Widget as any).query().whereNotIn('role', ['banned']).get()
    const exclusion = sentQuery()

    // The whole bug: these two were identical.
    expect(exclusion.toString()).not.toBe(inclusion.toString())
  })

  it('keeps the inclusion form unchanged', async () => {
    await (Widget as any).query().whereIn('role', ['a', 'b']).get()
    expect(sentQuery().get('role[]')).toBe('a,b')
  })

  it('sends an exclusion under a filter key naming the operator', async () => {
    await (Widget as any).query().whereNotIn('role', ['banned']).get()
    const q = sentQuery()

    // Must not go out as the inclusion form.
    expect(q.get('role[]')).toBeNull()
    expect(q.get('filter[role][not in]')).toBe('banned')
  })

  it('agrees with the sibling BrowserQueryBuilder', async () => {
    await (Widget as any).query().whereNotIn('role', ['banned']).get()
    const model = sentQuery()

    captured = []
    await new BrowserQueryBuilder('nwidgets').whereNotIn('role', ['banned']).get()
    const plain = sentQuery()

    // The two builders serialise the same query the same way. They did not.
    expect(model.get('filter[role][not in]')).toBe(plain.get('filter[role][not in]'))
    expect(model.get('role[]')).toBe(plain.get('role[]'))
  })
})
