/**
 * Compile-time: which columns a write may set to null.
 *
 * NOT executed - checked by `bun --bun tsc`. Lines marked @ts-expect-error
 * MUST fail to compile; every other line MUST compile.
 *
 * The rule is the migration generator's (`migrations.ts`):
 * `nullable ?? !(required ?? validator.required())`. A column created without
 * NOT NULL accepts null on create/update, because null is how a write clears
 * it. A column created NOT NULL rejects it. Found in an app whose model had
 * `cwd: { validation: { rule: schema.string().max(1024) } }` - a nullable
 * column, per its own migration - and `Conversation.create({ cwd: null })`
 * failed to typecheck.
 */

import { schema } from '@stacksjs/ts-validation'
import { createModel, type ModelDefinition } from '../orm'

const ConversationDef = {
  name: 'Conversation',
  table: 'conversations',
  attributes: {
    chatGuid: { fillable: true as const, validation: { rule: schema.string().required().max(255) } },
    cwd: { fillable: true as const, validation: { rule: schema.string().max(1024) } },
    lastActiveAt: { fillable: true as const, validation: { rule: schema.number() } },
    forcedRequired: { fillable: true as const, required: true as const, validation: { rule: schema.string() } },
    forcedNullable: { fillable: true as const, required: false as const, validation: { rule: schema.string().required() } },
    explicitNotNull: { fillable: true as const, nullable: false as const, validation: { rule: schema.string() } },
  },
} as const satisfies ModelDefinition

const RunDef = {
  name: 'Run',
  table: 'runs',
  belongsTo: ['Conversation'],
  attributes: {
    prompt: { fillable: true as const, validation: { rule: schema.string().required() } },
    costCents: { fillable: true as const, validation: { rule: schema.number() } },
  },
} as const satisfies ModelDefinition

const Conversation = createModel(ConversationDef)
const Run = createModel(RunDef)

async function writes(): Promise<void> {
  // Unrequired validator: the migration makes the column nullable, so null clears it.
  await Conversation.create({ chatGuid: 'g', cwd: null, lastActiveAt: null })
  await Conversation.create({ chat_guid: 'g', last_active_at: null })
  await Conversation.update(1, { cwd: null })

  // `.required()`: NOT NULL.
  // @ts-expect-error chatGuid is created NOT NULL
  await Conversation.create({ chatGuid: null })
  // @ts-expect-error the snake_case spelling is the same column
  await Conversation.create({ chat_guid: null })

  // The attribute's own `required` / `nullable` beat the validator, as in the migration.
  // @ts-expect-error required: true
  await Conversation.create({ forcedRequired: null })
  await Conversation.create({ forcedNullable: null })
  // @ts-expect-error nullable: false
  await Conversation.create({ explicitNotNull: null })

  // belongsTo FK: both spellings, and null detaches.
  await Run.create({ prompt: 'p', conversation_id: 1 })
  await Run.create({ prompt: 'p', conversationId: 1 })
  await Run.create({ prompt: 'p', conversationId: null, costCents: null })
  // @ts-expect-error still a number
  await Run.create({ prompt: 'p', conversationId: 'one' })
  // @ts-expect-error prompt is required
  await Run.create({ prompt: null })
}

void writes
