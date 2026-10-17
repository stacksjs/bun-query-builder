import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { buildSchemaMeta, clearModelRegistry, config, configureOrm, createModel, createTableFromModel, registerModel } from '../src'
import { buildMigrationPlan } from '../src/migrations'
import type { InferRelationNames, ModelDefinition } from '../src/orm'

const Person = { name: 'NamedPerson', table: 'named_people', attributes: { label: { type: 'string', fillable: true } } } as const satisfies ModelDefinition
const Note = {
  name: 'NamedNote', table: 'named_notes',
  belongsTo: [
    { model: 'NamedPerson', foreignKey: 'author_id' },
    { model: 'NamedPerson', foreignKey: 'closed_by_id', relationName: 'closedBy', onDelete: 'set null' },
  ],
  attributes: {
    title: { type: 'string', fillable: true },
    author_id: { type: 'number', fillable: true },
    closed_by_id: { type: 'number', fillable: true, nullable: true },
  },
} as const satisfies ModelDefinition
const named: InferRelationNames<typeof Note> = 'closedBy'
const original: InferRelationNames<typeof Note> = 'namedperson'
const People = createModel(Person)
const Notes = createModel(Note)
const database = new Database(':memory:')
const previous = config.dialect

beforeAll(async () => {
  config.dialect = 'sqlite'
  clearModelRegistry()
  configureOrm({ database })
  registerModel(Person.name, People)
  registerModel(Note.name, Notes)
  await createTableFromModel(Person)
  await createTableFromModel(Note)
  const author = await People.create({ label: 'author' })
  const closer = await People.create({ label: 'closer' })
  await Notes.create({ title: 'closed', author_id: author.id, closed_by_id: closer.id })
  await Notes.create({ title: 'open', author_id: author.id, closed_by_id: null })
})
afterAll(() => {
  database.close()
  configureOrm({ database: ':memory:' })
  config.dialect = previous
  clearModelRegistry()
})

test('distinct aliases of the same model use their own foreign keys', async () => {
  const note = await Notes.where('title', 'closed').with(original, named).firstOrFail()
  expect(note.getRelation(original)?.get('label')).toBe('author')
  expect(note.getRelation(named)?.get('label')).toBe('closer')
})

test('an optional named relation remains null without changing its foreign key', async () => {
  const note = await Notes.where('title', 'open').with(named).firstOrFail()
  expect(note.getRelation(named)).toBeNull()
})

test('query metadata retains both the model name and the named target', () => {
  const meta = buildSchemaMeta({ NamedPerson: Person, NamedNote: Note })
  expect(meta.relations?.named_notes.belongsTo).toEqual({ NamedPerson: 'NamedPerson', closedBy: 'NamedPerson' })
})

test('migration foreign keys retain explicit columns and target tables', () => {
  const plan = buildMigrationPlan({ NamedPerson: Person, NamedNote: Note }, { dialect: 'sqlite' })
  const columns = plan.tables.find(table => table.table === 'named_notes')!.columns
  expect(columns.find(column => column.name === 'author_id')?.references?.table).toBe('named_people')
  expect(columns.find(column => column.name === 'closed_by_id')?.references?.table).toBe('named_people')
  expect(columns.some(column => column.name === 'closed_by_id_id')).toBe(false)
})
