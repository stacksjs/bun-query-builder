import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { dts } from 'bun-plugin-dtsx'

// `ts/no-top-level-await` guards the SHIPPED entry, because a top-level await
// anywhere in the bundle makes `bun build --compile` refuse every consumer that
// requires it — which is the exact failure `assertCompilable()` below exists to
// catch. This file is not shipped: it is a script Bun runs directly, where a
// top-level await is the only way to await at all.
// eslint-disable-next-line ts/no-top-level-await
const result = await Bun.build({
  splitting: true,
  minify: true,
  entrypoints: ['src/index.ts', 'src/browser.ts', 'src/dynamodb/index.ts', 'bin/cli.ts'],
  outdir: './dist',
  target: 'bun',
  plugins: [dts({
    root: './src',
    entrypoints: ['index.ts', 'browser.ts', 'dynamodb/index.ts'],
  })],
})

if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

/**
 * Refuse to ship an entry that cannot be compiled into a binary.
 *
 * This build used to *add* a top-level await: it rewrote the generated
 * `init_src` wrapper to `async` and awaited it at module scope so that
 * `init_config()` had run before anything read the config binding. That was
 * necessary when `src/config.ts` loaded its file config at module scope. The
 * config has since been lazy (`getConfig()`), so the wrapper is already
 * synchronous and the rewrite only added the await.
 *
 * The await is not a local problem. Every module that imports this package
 * inherits it, and `bun build --compile` refuses to bundle a `require()` of
 * anything that transitively contains one — which is how this surfaced as a
 * different repository's release job failing to build its CLI binaries, four
 * dependency hops away, with nothing here failing at all.
 *
 * So the check asks Bun, because Bun is the thing that will refuse it.
 */
async function assertCompilable(entry: string): Promise<void> {
  const probe = join(tmpdir(), `bun-query-builder-compile-probe-${process.pid}.ts`)
  const output = join(tmpdir(), `bun-query-builder-compile-probe-${process.pid}.bin`)

  // `require`, not `import`: that is the call bun --compile rejects, and it is
  // how a consumer's CLI entry reaches this package.
  await writeFile(probe, `require(${JSON.stringify(resolve(entry))})\n`)

  const built = Bun.spawnSync([
    'bun',
    'build',
    probe,
    '--compile',
    '--target=bun',
    '--outfile',
    output,
  ], { stderr: 'pipe', stdout: 'pipe' })

  await rm(probe, { force: true })
  await rm(output, { force: true })

  if (built.exitCode === 0)
    return

  console.error(`\n${entry} cannot be compiled into a binary, so neither can anything that imports it:\n`)
  console.error(built.stderr.toString().trim())
  console.error('\nA top-level await is the usual cause. Move it inside a function — a config or optional-dependency load can happen on first use.\n')
  process.exit(1)
}

// eslint-disable-next-line ts/no-top-level-await -- build script, not shipped; see the note above
await assertCompilable('./dist/src/index.js')
