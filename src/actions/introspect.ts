import { buildDatabaseSchema, loadModels } from '../index'

export interface IntrospectOptions {
  verbose?: boolean
}

export function introspect(dir: string, _opts: IntrospectOptions = {}) {
  const models = loadModels({ modelsDir: dir })
  const schema = buildDatabaseSchema(models)

  console.log(JSON.stringify(schema, null, 2))

  return { models, schema }
}
