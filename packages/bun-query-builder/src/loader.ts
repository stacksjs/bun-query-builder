import type { ModelDefinition, ModelRecord } from './schema'
import { readdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import process from 'node:process'

export interface LoadModelsOptions {
  cwd?: string
  modelsDir: string
}

const MODEL_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

/**
 * Whether a file in the models directory is worth importing.
 *
 * `index.ts` barrels and `_helpers.ts` partials live in model directories all
 * the time, and importing them registered a "model" named `index` — an entry
 * with no attributes that the schema builder went on to emit a table for.
 */
function isModelFile(name: string): boolean {
  const ext = extname(name)
  if (!MODEL_EXTENSIONS.has(ext))
    return false
  const base = basename(name, ext)
  if (base.startsWith('_') || base === 'index')
    return false
  // `Model.d.ts` is a declaration file, not a model.
  return !base.endsWith('.d')
}

/**
 * Whether an imported default export actually describes a model.
 *
 * A file exporting something else — a helper, a constant — used to be
 * registered under its filename and travel through the rest of the pipeline
 * as a table.
 */
function isModelDefinition(def: unknown): def is ModelDefinition {
  if (!def || typeof def !== 'object')
    return false
  const d = def as { name?: unknown, table?: unknown }
  return typeof d.name === 'string' || typeof d.table === 'string'
}

/** Every model file under `dir`, depth-first, in a stable order. */
function collectModelFiles(dir: string): string[] {
  const files: string[] = []
  // Sorted, because `readdirSync` returns filesystem order and that differs
  // between machines. It decides the order tables are created in a full
  // generate, so leaving it unsorted made the generated corpus — and its
  // migration numbering — depend on which machine ran it.
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // Models are routinely grouped in subdirectories (`commerce/`,
      // `Content/`). Reading only the top level ignored them in silence,
      // which is why embedders resorted to flattening the tree into a staging
      // directory before handing it over.
      files.push(...collectModelFiles(full))
      continue
    }
    if (isModelFile(entry.name))
      files.push(full)
  }

  return files
}

export async function loadModels(options: LoadModelsOptions): Promise<ModelRecord> {
  const cwd = options.cwd ?? process.cwd()
  // `isAbsolute` rather than a leading-slash test: on Windows an absolute path
  // is `C:\models`, which the old check read as relative and glued onto the
  // working directory.
  const dir = isAbsolute(options.modelsDir) ? options.modelsDir : join(cwd, options.modelsDir)

  const result: ModelRecord = {}

  for (const full of collectModelFiles(dir)) {
    // Cache-busting query parameter so a re-run sees edited models: dynamic
    // import() caches by path.
    const cacheBuster = `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
    const mod = await import(`${full}${cacheBuster}`)
    const rawDef = mod.default ?? mod
    // Support both direct model definitions and wrapped models from defineModel()
    const def: ModelDefinition = (rawDef as any).definition ?? (rawDef as any).getDefinition?.() ?? rawDef
    if (!isModelDefinition(def))
      continue

    const name = def.name ?? basename(full, extname(full))
    result[name] = {
      ...def,
      name,
    }
  }

  return result
}
