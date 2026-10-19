/**
 * `hidden: true` across the serialization boundary —
 * stacksjs/bun-query-builder#1182.
 *
 * `toJSON()` redacted and `toArray()`, written directly beneath it, did not:
 *
 *   toJSON()  {"id":1,"email":"a@b.c"}
 *   toArray() {"id":1,"email":"a@b.c","password":"bcrypt$hash","api_token":"sk_live_abc"}
 *
 * Two serializers side by side with opposite behaviour. This API takes its
 * names from Eloquent, where `toArray()` applies `$hidden` and `toJSON()` is
 * defined in terms of it, so the expectation someone arrives with is the wrong
 * one — they reach for `toArray()` in a response serializer and ship the hash.
 *
 * `toJSON()` now delegates to `toArray()`, so the two cannot drift again.
 */

import { describe, expect, it } from 'bun:test'
import { createModel } from '../src/orm'

function user(): any {
  const User: any = createModel({
    name: 'User',
    table: 'users',
    primaryKey: 'id',
    attributes: {
      id: { validation: { rule: {} } },
      email: { validation: { rule: {} } },
      password: { validation: { rule: {} }, hidden: true },
      api_token: { validation: { rule: {} }, hidden: true },
    },
  } as any)
  return User.make({ id: 1, email: 'a@b.c', password: 'bcrypt$hash', api_token: 'sk_live_abc' })
}

describe('hidden attributes are redacted when serialized (#1182)', () => {
  it('toArray() drops them, which is the regression', () => {
    const out = user().toArray()
    expect(out.password).toBeUndefined()
    expect(out.api_token).toBeUndefined()
    // Still a usable snapshot of everything else.
    expect(out.id).toBe(1)
    expect(out.email).toBe('a@b.c')
  })

  it('toJSON() drops them too, and agrees with toArray()', () => {
    const u = user()
    expect(JSON.stringify(u.toJSON())).toBe(JSON.stringify(u.toArray()))
  })

  it('JSON.stringify of the model drops them', () => {
    const encoded = JSON.stringify(user())
    expect(encoded).not.toContain('bcrypt')
    expect(encoded).not.toContain('sk_live')
  })

  it('neither serializer leaks the secret as a substring', () => {
    // Blunt, but it is the property that actually matters at a response
    // boundary: the value must not appear anywhere in the payload.
    for (const payload of [JSON.stringify(user().toArray()), JSON.stringify(user().toJSON())]) {
      expect(payload).not.toContain('bcrypt$hash')
      expect(payload).not.toContain('sk_live_abc')
    }
  })

  it('getAttributes() still returns everything, deliberately', () => {
    // The raw accessor: dirty-tracking and diffing need the whole row. It is
    // documented as unredacted, which is the difference between this and the
    // toArray() bug.
    const attrs = user().getAttributes()
    expect(attrs.password).toBe('bcrypt$hash')
  })
})

describe('redaction reaches eager-loaded relations (#1182)', () => {
  it('a related model is serialized through the same filter', () => {
    // toArray() recurses with toArray(), so before the fix an eager-loaded
    // relation carried the related model's secrets into the parent payload —
    // the same propagation shape as #1093.
    const parent = user()
    parent._relations = { author: user(), readers: [user(), user()] }

    const out: any = parent.toArray()
    expect(out.author.password).toBeUndefined()
    expect(out.readers[0].password).toBeUndefined()
    expect(JSON.stringify(out)).not.toContain('bcrypt$hash')
  })
})
