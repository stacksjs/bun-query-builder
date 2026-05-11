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

  // Step 2: Even with `await init_config()` in init_src, peer bundles can call
  // `setConfig(...)` from their own top-level (e.g. `@stacksjs/database` does
  // at module load). Those callers reach `setConfig` before init_config has
  // awaited bunfig, so `config3` is still `undefined` and Object.assign blows
  // up. Bun's DCE strips a TypeScript-side guard on `config` because its
  // declared type doesn't include undefined. So we patch the built `setConfig`
  // function in-place to add the guard the bundler refuses to keep.
  //
  // Replace the entire `function setConfig(userConfig) { ... }` body — match
  // the open brace through the closing brace, with or without an existing
  // guard. Idempotent: rebuilds always produce the same output.
  const setConfigPattern = /function setConfig\(userConfig\) \{[\s\S]*?(\n}\n)/
  if (!setConfigPattern.test(content)) {
    console.warn(`setConfig pattern not found in ${filePath} — guard skipped`)
  }
  else {
    // `defaultConfig3` itself may be undefined this early — its assignment lives
    // inside the same async init wrapper. Fall back to `{}` so Object.assign has
    // something to mutate; the caller is about to merge real fields in.
    const guardedBody = `function setConfig(userConfig) {
  if (config3 == null || config3.dialect === undefined) { config3 = defaultConfig3 ? { ...defaultConfig3 } : {} }
  Object.assign(config3, userConfig);
  if (userConfig.database) { config3.database = { ...config3.database, ...userConfig.database }; }
  if (userConfig.timestamps) { config3.timestamps = { ...config3.timestamps, ...userConfig.timestamps }; }
  if (userConfig.pagination) { config3.pagination = { ...config3.pagination, ...userConfig.pagination }; }
  if (userConfig.softDeletes) { config3.softDeletes = { ...config3.softDeletes, ...userConfig.softDeletes }; }
  if (_config) { Object.assign(_config, config3); }
}
`
    content = content.replace(setConfigPattern, guardedBody)
    console.log(`Patched setConfig() with init guard in ${filePath}`)
  }

  if (content !== original) {
    await writeFile(filePath, content)
    console.log(`Fixed async init_config() call in ${filePath}`)
  }
}

await patchGeneratedEntry('./dist/src/index.js')
await patchGeneratedEntry('./dist/index.js')
