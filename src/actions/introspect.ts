import { buildDatabaseSchema, loadModels } from '../index'

export interface IntrospectOptions {
  verbose?: boolean
}

export async function introspect(dir: string, _opts: IntrospectOptions = {}) {
  const models = await loadModels({ modelsDir: dir })
  const schema = buildDatabaseSchema(models)

  console.log(JSON.stringify(schema, null, 2))

  return { models, schema }
}
