import type { ModelDefinition, ModelRecord } from './schema'
import { readdirSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import process from 'node:process'

export interface LoadModelsOptions {
  cwd?: string
  modelsDir: string
}

export async function loadModels(options: LoadModelsOptions): ModelRecord {
  const cwd = options.cwd ?? process.cwd()
  const dir = options.modelsDir.startsWith('/') ? options.modelsDir : `${cwd}/${options.modelsDir}`

  const result: ModelRecord = {}

  const entries = readdirSync(dir)
  for (const entry of entries) {
    const full = `${dir}/${entry}`
    const st = statSync(full)
    if (st.isDirectory())
      continue
    const ext = extname(full)
    if (!['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'].includes(ext))
      continue

    const mod = await import(full)
    const def: ModelDefinition = mod.default ?? mod
    const fileName = basename(entry, ext)
    const name = def.name ?? fileName
    result[name] = {
      ...def,
      name,
    }
  }

  return result
}
