import { v } from '@/examples/validation'
import { defineModel } from '@/index'

const model: {
  readonly name: 'Post'
  readonly table: 'posts'
  readonly primaryKey: 'id'
  readonly attributes: {
    readonly id: { readonly validation: { readonly rule: ReturnType<typeof v.integer> } }
    readonly user_id: { readonly validation: { readonly rule: ReturnType<typeof v.integer> } }
    readonly title: { readonly validation: { readonly rule: ReturnType<typeof v.string> } }
    readonly body: { readonly validation: { readonly rule: ReturnType<typeof v.text> } }
    readonly published: { readonly validation: { readonly rule: ReturnType<typeof v.boolean> } }
    readonly created_at: { readonly validation: { readonly rule: ReturnType<typeof v.date> } }
    readonly updated_at: { readonly validation: { readonly rule: ReturnType<typeof v.date> } }
  }
  readonly belongsTo: { readonly User: 'User' }
} = defineModel({
  name: 'Post',
  table: 'posts',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: v.integer() } },
    user_id: { validation: { rule: v.integer() } },
    title: { validation: { rule: v.string() } },
    body: { validation: { rule: v.text() } },
    roles: { validation: { rule: v.enum(['admin', 'member', 'guest'] as const) } },
    published: { validation: { rule: v.boolean() } },
    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },
  },
  belongsTo: { User: 'User' } as any,
})

const _default: typeof model = model
export default _default
