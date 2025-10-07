import { readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

export interface ModelShowOptions {
  dir?: string
  verbose?: boolean
  json?: boolean
}

export interface ModelDetails {
  name: string
  table: string
  primaryKey: string
  attributes: Record<string, any>
  relations?: Record<string, any>
  scopes?: Record<string, any>
  hooks?: string[]
  indexes?: any[]
  timestamps?: boolean
  softDeletes?: boolean
}

/**
 * Show detailed information about a specific model
 */
export async function modelShow(modelName: string, options: ModelShowOptions = {}): Promise<ModelDetails | void> {
  const dir = options.dir || join(process.cwd(), 'app/Models')

  try {
    // Load the model file
    const files = readdirSync(dir)
    const modelFile = files.find((f) => {
      const name = f.replace(extname(f), '')
      return name.toLowerCase() === modelName.toLowerCase()
    })

    if (!modelFile) {
      console.error(`Model "${modelName}" not found in ${dir}`)
      console.log(`Available models: ${files.filter(f => ['.ts', '.js'].includes(extname(f))).map(f => f.replace(extname(f), '')).join(', ')}`)
      return
    }

    const modelPath = join(dir, modelFile)
    const module = await import(modelPath)
    const model = module.default || module[Object.keys(module)[0]]

    if (!model || !model.name) {
      console.error(`Invalid model file: ${modelFile}`)
      return
    }

    const details: ModelDetails = {
      name: model.name,
      table: model.table || `${model.name.toLowerCase()}s`,
      primaryKey: model.primaryKey || 'id',
      attributes: model.attributes || {},
      relations: model.relations,
      scopes: model.scopes,
      indexes: model.indexes,
      timestamps: model.timestamps !== false,
      softDeletes: model.softDeletes === true,
    }

    // Collect hooks
    const hooks: string[] = []
    if (model.beforeCreate)
      hooks.push('beforeCreate')
    if (model.afterCreate)
      hooks.push('afterCreate')
    if (model.beforeUpdate)
      hooks.push('beforeUpdate')
    if (model.afterUpdate)
      hooks.push('afterUpdate')
    if (model.beforeDelete)
      hooks.push('beforeDelete')
    if (model.afterDelete)
      hooks.push('afterDelete')

    if (hooks.length > 0) {
      details.hooks = hooks
    }

    if (options.json) {
      console.log(JSON.stringify(details, null, 2))
      return details
    }

    // Pretty print
    console.log(`\n📦 Model: ${details.name}`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`Table:       ${details.table}`)
    console.log(`Primary Key: ${details.primaryKey}`)
    console.log(`Timestamps:  ${details.timestamps ? '✓' : '✗'}`)
    console.log(`Soft Deletes: ${details.softDeletes ? '✓' : '✗'}`)

    // Attributes
    console.log(`\n📋 Attributes (${Object.keys(details.attributes).length}):`)
    for (const [name, attr] of Object.entries(details.attributes)) {
      const type = attr.type || 'string'
      const required = attr.required ? '(required)' : ''
      const unique = attr.unique ? '(unique)' : ''
      const defaultVal = attr.default !== undefined ? `= ${JSON.stringify(attr.default)}` : ''
      console.log(`  • ${name}: ${type} ${required} ${unique} ${defaultVal}`.trim())
    }

    // Relations
    if (details.relations && Object.keys(details.relations).length > 0) {
      console.log(`\n🔗 Relations (${Object.keys(details.relations).length}):`)
      for (const [name, rel] of Object.entries(details.relations)) {
        const type = (rel as any).type || 'unknown'
        const target = (rel as any).model || (rel as any).table || 'unknown'
        console.log(`  • ${name}: ${type} → ${target}`)
      }
    }

    // Scopes
    if (details.scopes && Object.keys(details.scopes).length > 0) {
      console.log(`\n🔍 Scopes (${Object.keys(details.scopes).length}):`)
      for (const scope of Object.keys(details.scopes)) {
        console.log(`  • ${scope}()`)
      }
    }

    // Hooks
    if (details.hooks && details.hooks.length > 0) {
      console.log(`\n🪝 Hooks (${details.hooks.length}):`)
      for (const hook of details.hooks) {
        console.log(`  • ${hook}`)
      }
    }

    // Indexes
    if (details.indexes && details.indexes.length > 0) {
      console.log(`\n📇 Indexes (${details.indexes.length}):`)
      for (const idx of details.indexes) {
        const columns = Array.isArray(idx.columns) ? idx.columns.join(', ') : idx.columns
        const unique = idx.unique ? '(unique)' : ''
        console.log(`  • ${idx.name || 'unnamed'}: [${columns}] ${unique}`.trim())
      }
    }

    console.log()

    return details
  }
  catch (error: any) {
    console.error(`Error loading model "${modelName}":`, error.message)
    throw error
  }
}

export { modelShow as showModel }
