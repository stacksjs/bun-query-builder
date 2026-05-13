import { readFile, writeFile } from 'node:fs/promises'
import { dts } from 'bun-plugin-dtsx'

const result = await Bun.build({
  entrypoints: ['src/index.ts', 'src/browser.ts', 'src/dynamodb/index.ts', 'bin/cli.ts'],
  outdir: './dist',
  target: 'bun',
  plugins: [dts()],
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

async function patchGeneratedEntry(filePath: string): Promise<void> {
  let original: string
  try {
    original = await readFile(filePath, 'utf8')
  }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return

    throw error
  }

  let content = original
  const asyncInitializers = new Set<string>()

  // Bun 1.3.13 can emit the root entry wrapper as `__esm(() => { ... })`
  // even when an earlier patch introduces `await init_config()` inside it.
  // Patch every generated init_src* wrapper that touches config so the output
  // remains parseable across Bun patch releases.
  content = content.replace(
    /var (init_src\d*) = __esm\((?:async )?\(\) => \{[\s\S]*?\n\}\);/g,
    (wrapper: string, name: string) => {
      if (!wrapper.includes('init_config();') && !wrapper.includes('await init_config();'))
        return wrapper

      asyncInitializers.add(name)

      return wrapper
        .replace(`var ${name} = __esm(() => {`, `var ${name} = __esm(async () => {`)
        .replace(/(?<!await )init_config\(\);/g, 'await init_config();')
    },
  )

  for (const name of asyncInitializers) {
    content = content.replace(
      new RegExp(`\\n${name}\\(\\);\\n\\nexport \\{`),
      `\nawait ${name}();\n\nexport {`,
    )
  }

  // (Removed) Earlier this script overwrote the built `setConfig` body
  // with a hand-written version that wrote to a hard-coded `config3`
  // identifier. Bun's bundler now emits a different name for the module-
  // level `config` binding (`config5` in current builds), so the patch
  // became a write to a dead/implicit-global variable — every
  // `setConfig({dialect:'sqlite'})` looked like a no-op because consumers
  // kept reading the `postgres` default from `config5`. With Step 1's
  // `await init_config()` guaranteeing the binding is populated before
  // any reader runs, the source-level `setConfig` (which mutates `config`
  // in place rather than reassigning it) is enough.

  if (content !== original) {
    await writeFile(filePath, content)
    console.log(`Fixed async init_config() call in ${filePath}`)
  }
}

await patchGeneratedEntry('./dist/src/index.js')
await patchGeneratedEntry('./dist/index.js')
