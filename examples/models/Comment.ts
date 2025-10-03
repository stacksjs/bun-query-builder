import { v } from '@stacksjs/ts-validation'
import { defineModel } from '@/index'

const model: {
  readonly name: 'Comment'
  readonly table: 'comments'
  readonly primaryKey: 'id'
  readonly attributes: {
    readonly id: { readonly validation: { readonly rule: ReturnType<typeof v.integer> } }
    readonly post_id: { readonly validation: { readonly rule: ReturnType<typeof v.integer> } }
    readonly author: { readonly validation: { readonly rule: ReturnType<typeof v.string> } }
    readonly body: { readonly validation: { readonly rule: ReturnType<typeof v.text> } }
    readonly created_at: { readonly validation: { readonly rule: ReturnType<typeof v.date> } }
  }
  readonly belongsTo: { readonly Post: 'Post' }
} = defineModel({
  name: 'Comment',
  table: 'comments',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: v.integer() } },
    post_id: { validation: { rule: v.integer() } },
    author: { validation: { rule: v.string() } },
    body: { validation: { rule: v.text() } },
    created_at: { validation: { rule: v.date() } },
  },
  belongsTo: { Post: 'Post' } as any,
})

const _default: typeof model = model
export default _default
