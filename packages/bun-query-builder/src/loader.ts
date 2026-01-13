import type { ModelDefinition, ModelRecord } from './schema'
import { readdirSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import process from 'node:process'

export interface LoadModelsOptions {
  cwd?: string
  modelsDir: string
}

export async function loadModels(options: LoadModelsOptions): Promise<ModelRecord> {
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

    // Use cache-busting query parameter to ensure fresh import
    // This is necessary because dynamic import() caches modules by path
    const cacheBuster = `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
    const mod = await import(`${full}${cacheBuster}`)
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
