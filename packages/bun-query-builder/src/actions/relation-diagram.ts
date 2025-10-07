import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadModels } from '../index'

export interface DiagramOptions {
  dir?: string
  format?: 'mermaid' | 'dot'
  output?: string
  verbose?: boolean
}

/**
 * Generate relationship diagram from models
 */
export async function relationDiagram(options: DiagramOptions = {}): Promise<string> {
  const dir = options.dir || join(process.cwd(), 'app/Models')
  const format = options.format || 'mermaid'

  try {
    const models = await loadModels({ modelsDir: dir })

    if (!models || Object.keys(models).length === 0) {
      console.error('No models found')
      return ''
    }

    let diagram = ''

    if (format === 'mermaid') {
      diagram = generateMermaidDiagram(models)
    }
    else if (format === 'dot') {
      diagram = generateDotDiagram(models)
    }
    else {
      console.error(`Unsupported format: ${format}`)
      return ''
    }

    if (options.output) {
      writeFileSync(options.output, diagram, 'utf8')
      console.log(`✓ Diagram written to: ${options.output}`)
    }
    else {
      console.log(diagram)
    }

    return diagram
  }
  catch (error: any) {
    console.error('Error generating diagram:', error.message)
    throw error
  }
}

/**
 * Generate Mermaid ER diagram
 */
function generateMermaidDiagram(models: Record<string, any>): string {
  const lines: string[] = ['erDiagram']

  // Add entities with attributes
  for (const [modelName, model] of Object.entries(models)) {
    const table = model.table || `${modelName.toLowerCase()}s`
    const attrs = model.attributes || {}

    lines.push(`  ${table} {`)

    // Add attributes
    for (const [attrName, attr] of Object.entries(attrs)) {
      const type = (attr as any).type || 'string'
      const pk = model.primaryKey === attrName ? 'PK' : ''
      const unique = (attr as any).unique ? 'UK' : ''
      const flags = [pk, unique].filter(Boolean).join(',')
      const flagStr = flags ? ` "${flags}"` : ''

      lines.push(`    ${type} ${attrName}${flagStr}`)
    }

    lines.push('  }')
  }

  // Add relationships
  for (const [modelName, model] of Object.entries(models)) {
    const table = model.table || `${modelName.toLowerCase()}s`
    const relations = model.relations || {}

    for (const [relName, rel] of Object.entries(relations)) {
      const relType = (rel as any).type
      const targetModel = (rel as any).model
      const targetTable = models[targetModel]?.table || `${targetModel?.toLowerCase()}s` || 'unknown'

      let cardinality = ''
      if (relType === 'hasOne') {
        cardinality = '||--||'
      }
      else if (relType === 'hasMany') {
        cardinality = '||--o{'
      }
      else if (relType === 'belongsTo') {
        cardinality = '}o--||'
      }
      else if (relType === 'belongsToMany' || relType === 'manyToMany') {
        cardinality = '}o--o{'
      }
      else {
        cardinality = '||--||'
      }

      lines.push(`  ${table} ${cardinality} ${targetTable} : "${relName}"`)
    }
  }

  return lines.join('\n')
}

/**
 * Generate Graphviz DOT diagram
 */
function generateDotDiagram(models: Record<string, any>): string {
  const lines: string[] = [
    'digraph schema {',
    '  rankdir=LR;',
    '  node [shape=record];',
    '',
  ]

  // Add nodes (tables)
  for (const [modelName, model] of Object.entries(models)) {
    const table = model.table || `${modelName.toLowerCase()}s`
    const attrs = model.attributes || {}

    const attrLines: string[] = []
    for (const [attrName, attr] of Object.entries(attrs)) {
      const type = (attr as any).type || 'string'
      const pk = model.primaryKey === attrName ? ' (PK)' : ''
      const unique = (attr as any).unique ? ' (UK)' : ''
      attrLines.push(`${attrName}: ${type}${pk}${unique}`)
    }

    const attrStr = attrLines.join('\\l') + '\\l'
    lines.push(`  ${table} [label="{${table}|${attrStr}}"];`)
  }

  lines.push('')

  // Add edges (relationships)
  for (const [modelName, model] of Object.entries(models)) {
    const table = model.table || `${modelName.toLowerCase()}s`
    const relations = model.relations || {}

    for (const [relName, rel] of Object.entries(relations)) {
      const relType = (rel as any).type
      const targetModel = (rel as any).model
      const targetTable = models[targetModel]?.table || `${targetModel?.toLowerCase()}s` || 'unknown'

      let style = ''
      if (relType === 'hasOne') {
        style = 'arrowhead=none, arrowtail=normal'
      }
      else if (relType === 'hasMany') {
        style = 'arrowhead=crow, arrowtail=none'
      }
      else if (relType === 'belongsTo') {
        style = 'arrowhead=normal, arrowtail=none'
      }
      else if (relType === 'belongsToMany' || relType === 'manyToMany') {
        style = 'arrowhead=crow, arrowtail=crow'
      }

      lines.push(`  ${table} -> ${targetTable} [label="${relName}", ${style}];`)
    }
  }

  lines.push('}')

  return lines.join('\n')
}

export { relationDiagram as generateDiagram }
