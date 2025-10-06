import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/**
 * Find workspace root by looking for package.json
 */
function findWorkspaceRoot(startPath: string): string {
  let currentPath = startPath

  while (currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, 'package.json'))) {
      return currentPath
    }
    currentPath = dirname(currentPath)
  }

  return process.cwd()
}

export interface MakeModelOptions {
  table?: string
  dir?: string
  timestamps?: boolean
}

/**
 * Generate a new model file
 */
export async function makeModel(name: string, options: MakeModelOptions = {}): Promise<void> {
  const workspaceRoot = findWorkspaceRoot(process.cwd())
  const modelsDir = options.dir || join(workspaceRoot, 'app/Models')

  // Ensure models directory exists
  if (!existsSync(modelsDir)) {
    mkdirSync(modelsDir, { recursive: true })
    console.log(`-- Created models directory: ${modelsDir}`)
  }

  // Normalize the model name
  const className = name.charAt(0).toUpperCase() + name.slice(1)
  const tableName = options.table || `${name.toLowerCase()}s`
  const fileName = `${className}.ts`
  const filePath = join(modelsDir, fileName)

  if (existsSync(filePath)) {
    console.error(`-- Model already exists: ${filePath}`)
    throw new Error(`Model already exists: ${filePath}`)
  }

  const includeTimestamps = options.timestamps !== false

  const timestampFields = includeTimestamps
    ? `    created_at: { validation: { rule: v.date() } },
    updated_at: { validation: { rule: v.date() } },`
    : ''

  const template = `import { v } from '@stacksjs/ts-validation'
import { defineModel } from 'bun-query-builder'

const model = defineModel({
  name: '${className}',
  table: '${tableName}',
  primaryKey: 'id',
  attributes: {
    id: { validation: { rule: v.integer() } },
${timestampFields}
    // Add your model attributes here
    // Example:
    // name: { validation: { rule: v.string() } },
    // email: { unique: true, validation: { rule: v.string().email() } },
    // age: { default: 0, validation: { rule: v.number().min(0) } },
  },
})

export default model
`

  writeFileSync(filePath, template)
  console.log(`-- ✓ Created model: ${filePath}`)
  console.log(`-- Table: ${tableName}`)
}
