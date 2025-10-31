import { readFile, writeFile } from 'node:fs/promises'
import { dts } from 'bun-plugin-dtsx'

await Bun.build({
  entrypoints: ['src/index.ts'],
  outdir: './dist',
  target: 'bun',
  plugins: [dts()],
})

// Fix: Ensure init_config() is awaited in init_src()
// Bun's bundler doesn't automatically await async init functions
const filePath = './dist/index.js'
const content = await readFile(filePath, 'utf8')

// Replace init_config(); with await init_config(); only in the init_src function body
const updatedContent = content.replace(
  // eslint-disable-next-line regexp/no-super-linear-backtracking
  /(var init_src = __esm\(async \(\) => \{)((?:(?!\s+init_config\(\);)[\s\S])*?)(\s+)(init_config\(\);)/,
  '$1$2$3await $4',
)

await writeFile(filePath, updatedContent)
console.log('Fixed async init_config() call in build output')
