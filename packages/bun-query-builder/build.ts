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

// Fix: Ensure init_config() is awaited in init_src()
// Bun's bundler doesn't automatically await async init functions.
// `dist/src/index.js` is where the bundler emits the entry — `package.json`
// exports points consumers there directly so we don't need to copy.
const filePath = './dist/src/index.js'
const original = await readFile(filePath, 'utf8')

// Step 1: Replace init_config(); with await init_config(); only in the
// init_src function body so the rest of the bundle sees a populated
// config3/defaultConfig3 by the time init_src completes.
let content = original.replace(
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  /(var init_src = __esm\(async \(\) => \{)((?:(?!\s+init_config\(\);)[\s\S])*?)(\s+)(init_config\(\);)/,
  '$1$2$3await $4',
)

// Step 2: Even with `await init_config()` in init_src, peer bundles can call
// `setConfig(...)` from their own top-level (e.g. `@stacksjs/database` does
// at module load). Those callers reach `setConfig` before init_config has
// awaited bunfig, so `config3` is still `undefined` and Object.assign blows
// up. Bun's DCE strips a TypeScript-side guard on `config` because its
// declared type doesn't include undefined. So we patch the built `setConfig`
// function in-place to add the guard the bundler refuses to keep.
//
// Replace the entire `function setConfig(userConfig) { ... }` body — match the
// open brace through the closing brace, with or without an existing guard.
// Idempotent: rebuilds always produce the same output.
const setConfigPattern = /function setConfig\(userConfig\) \{[\s\S]*?(\n}\n)/
if (!setConfigPattern.test(content)) {
  console.warn('setConfig pattern not found — guard skipped')
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
  console.log('Patched setConfig() with init guard for early callers')
}

if (content !== original) {
  await writeFile(filePath, content)
  console.log('Fixed async init_config() call in build output')
}
