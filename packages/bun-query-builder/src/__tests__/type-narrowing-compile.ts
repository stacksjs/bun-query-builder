/**
 * Compile-time type narrowing verification.
 *
 * This file is NOT a test — it's checked with `bun tsc --noEmit`.
 * Lines marked @ts-expect-error MUST fail to compile.
 * Lines without that marker MUST succeed.
 */

import { createModel, type ModelDefinition } from '../orm'

const UserDef = {
  name: 'User',
  table: 'users',
  traits: {
    useUuid: true,
    useTimestamps: true,
  },
  belongsTo: ['Team'] as const,
  hasMany: ['Post'] as const,
  attributes: {
    name: { type: 'string' as const, fillable: true as const },
    email: { type: 'string' as const, fillable: true as const, unique: true as const },
    password: { type: 'string' as const, fillable: true as const, hidden: true as const },
    age: { type: 'number' as const, fillable: true as const },
    role: { type: ['admin', 'user'] as const, fillable: true as const },
    bio: { type: 'string' as const, fillable: false as const, guarded: true as const },
  },
} as const satisfies ModelDefinition

const User = createModel(UserDef)

// ---------------------------------------------------------------
// 1. where() accepts only valid column names
// ---------------------------------------------------------------
User.where('name', 'Alice')           // OK — 'name' is a valid attribute
User.where('email', 'alice@test.com') // OK — 'email' is a valid attribute
User.where('id', 1)                   // OK — 'id' is always a valid column
User.where('uuid', 'xxx')            // OK — 'uuid' exists because useUuid: true
User.where('created_at', 'xxx')      // OK — exists because useTimestamps: true
User.where('age', '>', 18)           // OK — operator overload

// @ts-expect-error — 'invalid_column' is not a valid column
User.where('invalid_column', 'value')

// @ts-expect-error — 'nonexistent' is not a valid column
User.where('nonexistent', 'value')

// ---------------------------------------------------------------
// 2. select() narrows what .get() accepts
// ---------------------------------------------------------------
const narrowed = User.select('name', 'email').first()
if (narrowed) {
  narrowed.get('name')    // OK — 'name' was selected
  narrowed.get('email')   // OK — 'email' was selected

  // @ts-expect-error — 'password' was NOT selected
  narrowed.get('password')

  // @ts-expect-error — 'age' was NOT selected
  narrowed.get('age')

  // @ts-expect-error — 'id' was NOT selected
  narrowed.get('id')
}

// ---------------------------------------------------------------
// 3. Without select(), all columns are accessible
// ---------------------------------------------------------------
const full = User.first()
if (full) {
  full.get('name')        // OK
  full.get('email')       // OK
  full.get('password')    // OK — no select narrowing
  full.get('age')         // OK
  full.get('id')          // OK
  full.get('uuid')        // OK
  full.get('created_at')  // OK
  full.get('updated_at')  // OK

  // @ts-expect-error — 'bogus' is never a valid column
  full.get('bogus')
}

// ---------------------------------------------------------------
// 4. create() accepts only fillable fields
// ---------------------------------------------------------------
User.create({ name: 'test', email: 'test@test.com' })  // OK — fillable fields
User.create({ name: 'test', email: 'test@test.com', age: 30 })  // OK

// ---------------------------------------------------------------
// 5. toJSON() excludes hidden fields
// ---------------------------------------------------------------
const user = User.first()
if (user) {
  const json = user.toJSON()
  json.name   // OK — not hidden
  json.email  // OK — not hidden

  // @ts-expect-error — 'password' is hidden
  json.password
}

// ---------------------------------------------------------------
// 6. with() accepts only valid relation names
// ---------------------------------------------------------------
User.with('team')    // OK — belongsTo: ['Team'] → lowercase 'team'
User.with('post')    // OK — hasMany: ['Post'] → lowercase 'post'

// @ts-expect-error — 'order' is not a declared relation
User.with('order')

// @ts-expect-error — 'Team' (uppercase) is not valid, must be lowercase
User.with('Team')

// ---------------------------------------------------------------
// 7. set() only accepts attribute keys (not system fields)
// ---------------------------------------------------------------
if (user) {
  user.set('name', 'New Name')    // OK — attribute key
  user.set('email', 'new@test.com')  // OK

  // @ts-expect-error — 'id' is not an attribute key (it's a system field)
  user.set('id', 999)

  // @ts-expect-error — 'uuid' is not an attribute key
  user.set('uuid', 'xxx')
}

// ---------------------------------------------------------------
// 8. Enum types narrow correctly
// ---------------------------------------------------------------
if (user) {
  const role = user.get('role')
  // role should be 'admin' | 'user'
  const check: 'admin' | 'user' = role  // OK — type matches
}

// ---------------------------------------------------------------
// 9. No useUuid/useTimestamps → those columns don't exist
// ---------------------------------------------------------------
const MinimalDef = {
  name: 'Minimal',
  table: 'minimals',
  attributes: {
    value: { type: 'string' as const, fillable: true as const },
  },
} as const satisfies ModelDefinition

const Minimal = createModel(MinimalDef)
const m = Minimal.first()
if (m) {
  m.get('value')  // OK
  m.get('id')     // OK — id always exists

  // @ts-expect-error — no useUuid trait, so 'uuid' is not a valid column
  m.get('uuid')

  // @ts-expect-error — no useTimestamps trait, so 'created_at' is not valid
  m.get('created_at')
}

// ---------------------------------------------------------------
// 10. select() on model static also narrows
// ---------------------------------------------------------------
const selected = User.select('name', 'age')

// @ts-expect-error — 'email' was not selected, can't select it
User.select('name', 'invalid_col')
