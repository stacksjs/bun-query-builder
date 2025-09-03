import { defineModel } from 'bun-query-builder'
import { v } from '../validation'

const model = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: v.integer() } },
    email: { unique: true, validation: { rule: v.string() } },
    name: { validation: { rule: v.string() } },
    role: { validation: { rule: v.enum(['admin', 'member', 'guest'] as const) } },
    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },
  },
})

export default model
