/**
 * Type Inference Demonstration
 *
 * Open this file in your IDE to see narrow type inference in action.
 * Hover over variables to see their inferred types.
 */

import { createModel } from '../src/orm'

// Define a model with explicit type fields for narrow inference
const User = createModel({
  name: 'User',
  table: 'users',
  attributes: {
    name: { type: 'string', fillable: true },
    email: { type: 'string', fillable: true, unique: true },
    age: { type: 'number', fillable: true },
    active: { type: 'boolean', fillable: true },
    // Literal union - hover to see: 'admin' | 'user' | 'moderator'
    role: { type: ['admin', 'user', 'moderator'] as const, fillable: true },
    // Another literal union - hover to see: 'active' | 'inactive' | 'pending'
    status: { type: ['active', 'inactive', 'pending'] as const, fillable: true },
  },
} as const)

// --- Type inference examples ---

// 1. Model instance get() returns proper types
const user = User.find(1)
if (user) {
  const name = user.get('name') // Hover: string
  const age = user.get('age') // Hover: number
  const active = user.get('active') // Hover: boolean
  const role = user.get('role') // Hover: 'admin' | 'user' | 'moderator'
  const status = user.get('status') // Hover: 'active' | 'inactive' | 'pending'

  // TypeScript will error on invalid column names:
  // @ts-expect-error - 'invalid' is not a valid column
  user.get('invalid')
}

// 2. pluck() returns typed arrays
const names = User.pluck('name') // Hover: string[]
const ages = User.pluck('age') // Hover: number[]
const roles = User.pluck('role') // Hover: ('admin' | 'user' | 'moderator')[]

// 3. where() only accepts valid columns
User.where('name', 'John') // OK
User.where('role', 'admin') // OK - literal value
User.where('age', 25) // OK - number

// TypeScript will error on invalid columns:
// @ts-expect-error - 'invalid' is not a valid column
User.where('invalid', 'value')

// 4. select() only accepts valid columns
User.select('name', 'email') // OK

// @ts-expect-error - 'invalid' is not a valid column
User.select('invalid')

// 5. orderBy() only accepts valid columns
User.orderBy('name') // OK
User.orderBy('age', 'desc') // OK

// @ts-expect-error - 'invalid' is not a valid column
User.orderBy('invalid')

// 6. Dynamic whereColumn methods work
const UserAny = User as any
UserAny.whereName('John') // Creates where('name', 'John')
UserAny.whereEmail('test@example.com') // Creates where('email', ...)

// 7. create() only accepts fillable attributes
User.create({
  name: 'John',
  email: 'john@example.com',
  age: 25,
  active: true,
  role: 'user',
  status: 'active',
})

console.log('Type demo file - open in IDE to see types on hover')
