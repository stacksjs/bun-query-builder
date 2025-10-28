import { v } from '@stacksjs/ts-validation'
import { defineModel } from '../../packages/bun-query-builder/src'

const model = defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  hasMany: { posts: 'Post' },
  attributes: {
    id: { validation: { rule: v.integer() } },
    email: { unique: true, validation: { rule: v.string() } },
    name: { validation: { rule: v.string() } },
    age: { default: 0, validation: { rule: v.string() } },
    role: { validation: { rule: v.string() } },
    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },
  },
})

export default model
