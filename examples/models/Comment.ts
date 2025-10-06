import { v } from '@stacksjs/ts-validation'
import { defineModel } from 'bun-query-builder'

const model: {
  readonly name: 'Comment'
  readonly table: 'comments'
  readonly primaryKey: 'id'
  readonly attributes: {
    readonly id: { readonly validation: { readonly rule: ReturnType<typeof v.integer> } }
    readonly post_id: { readonly validation: { readonly rule: ReturnType<typeof v.integer> } }
    readonly user_id: { readonly validation: { readonly rule: ReturnType<typeof v.integer> } }
    readonly content: { readonly validation: { readonly rule: ReturnType<typeof v.text> } }
    readonly created_at: { readonly validation: { readonly rule: ReturnType<typeof v.date> } }
    readonly updated_at: { readonly validation: { readonly rule: ReturnType<typeof v.date> } }
  }
  readonly belongsTo: { readonly Post: 'Post', readonly User: 'User' }
} = defineModel({
  name: 'Comment',
  table: 'comments',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: v.integer() } },
    post_id: { validation: { rule: v.integer() } },
    user_id: { validation: { rule: v.integer() } },
    content: { validation: { rule: v.text() } },
    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },
  },
  belongsTo: { Post: 'Post', User: 'User' } as any,
})

const _default: typeof model = model
export default _default
