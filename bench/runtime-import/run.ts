import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { arch, platform, release } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'

type Variant = 'root' | 'runtime'
type Metric = 'importMs' | 'rssBytes'

interface Sample {
  pair: number
  order: number
  variant: Variant
  importMs: number
  rssBytes: number
}

interface StaticGraphFile {
  path: string
  bytes: number
  sha256: string
}

interface StaticGraph {
  files: StaticGraphFile[]
  fileCount: number
  totalBytes: number
  sha256: string
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function sha256(input: string | Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(input)
  return hasher.digest('hex')
}

function git(...args: string[]): string | null {
  const result = Bun.spawnSync(['git', ...args], { cwd: repositoryRoot })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

function gitState(): { commit: string | null, dirty: boolean | null, status: string | null, sourceSha256: string | null } {
  const status = git('status', '--porcelain=v1')
  const listed = git('ls-files', '-co', '--exclude-standard', '-z')
  let sourceSha256: string | null = null
  if (listed != null) {
    const hasher = new Bun.CryptoHasher('sha256')
    for (const path of listed.split('\0').filter(Boolean).sort()) {
      hasher.update(`${path}\0`)
      hasher.update(readFileSync(join(repositoryRoot, path)))
      hasher.update('\0')
    }
    sourceSha256 = hasher.digest('hex')
  }
  return {
    commit: git('rev-parse', 'HEAD'),
    dirty: status == null ? null : status.length > 0,
    status,
    sourceSha256,
  }
}

async function staticGraph(entry: string): Promise<StaticGraph> {
  const transpiler = new Bun.Transpiler({ loader: 'js' })
  const pending = [entry]
  const visited = new Set<string>()

  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file))
      continue
    visited.add(file)

    const source = await Bun.file(file).text()
    for (const imported of transpiler.scanImports(source)) {
      if (imported.kind !== 'import-statement' || !imported.path.startsWith('.'))
        continue
      pending.push(resolve(dirname(file), imported.path))
    }
  }

  const files = await Promise.all([...visited].sort().map(async (file): Promise<StaticGraphFile> => {
    const contents = new Uint8Array(await Bun.file(file).arrayBuffer())
    return {
      path: relative(packageRoot, file),
      bytes: statSync(file).size,
      sha256: sha256(contents),
    }
  }))
  const graphHasher = new Bun.CryptoHasher('sha256')
  for (const file of files)
    graphHasher.update(`${file.path}\0${file.bytes}\0${file.sha256}\0`)
  return {
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sha256: graphHasher.digest('hex'),
  }
}

function childEnvironment(): Record<string, string> {
  const retained = ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'TZ'] as const
  const env: Record<string, string> = { NODE_ENV: 'production' }
  for (const name of retained) {
    const value = process.env[name]
    if (value != null)
      env[name] = value
  }
  return env
}

const here = dirname(import.meta.path)
const repositoryRoot = resolve(here, '../..')
const packageRoot = join(repositoryRoot, 'packages/bun-query-builder')
const entries = {
  root: join(packageRoot, 'dist/src/index.js'),
  runtime: join(packageRoot, 'dist/src/runtime.js'),
} as const
const pairs = Number(option('pairs') ?? 15)
if (!Number.isSafeInteger(pairs) || pairs < 15)
  throw new Error(`--pairs must be an integer of at least 15, received ${pairs}`)

for (const entry of Object.values(entries)) {
  if (!await Bun.file(entry).exists())
    throw new Error(`Missing ${entry}. Run \`bun run build\` before this diagnostic.`)
}

const output = resolve(repositoryRoot, option('output') ?? 'bench/runtime-import/results/latest.json')
const samples: Sample[] = []
const gitBefore = gitState()
const rootGraph = await staticGraph(entries.root)
const runtimeGraph = await staticGraph(entries.runtime)
for (let pair = 0; pair < pairs; pair++) {
  const order: Variant[] = pair % 2 === 0 ? ['root', 'runtime'] : ['runtime', 'root']
  for (const [orderIndex, variant] of order.entries()) {
    const child = Bun.spawnSync([
      process.execPath,
      '--no-env-file',
      join(here, 'sample.ts'),
      entries[variant],
    ], {
      env: childEnvironment(),
      stderr: 'pipe',
      stdout: 'pipe',
    })
    if (child.exitCode !== 0)
      throw new Error(child.stderr.toString())
    samples.push({
      pair,
      order: orderIndex,
      variant,
      ...JSON.parse(child.stdout.toString()),
    })
  }
}

const values = (variant: Variant, key: Metric) =>
  samples.filter(sample => sample.variant === variant).map(sample => sample[key])
const pairedDeltas = (key: Metric) => Array.from({ length: pairs }, (_, pair) => {
  const rows = samples.filter(sample => sample.pair === pair)
  return rows.find(sample => sample.variant === 'runtime')![key]
    - rows.find(sample => sample.variant === 'root')![key]
})
const pairRatios = (key: Metric) => Array.from({ length: pairs }, (_, pair) => {
  const rows = samples.filter(sample => sample.pair === pair)
  return rows.find(sample => sample.variant === 'runtime')![key]
    / rows.find(sample => sample.variant === 'root')![key]
})
const metric = (key: Metric) => {
  const rootMedian = median(values('root', key))
  const runtimeMedian = median(values('runtime', key))
  const deltas = pairedDeltas(key)
  const ratios = pairRatios(key)
  return {
    rootMedian,
    runtimeMedian,
    medianDelta: runtimeMedian - rootMedian,
    medianPercentChange: ((runtimeMedian / rootMedian) - 1) * 100,
    pairedMedianDelta: median(deltas),
    pairedMedianRatio: median(ratios),
    runtimeLowerPairs: ratios.filter(ratio => ratio < 1).length,
    ties: ratios.filter(ratio => ratio === 1).length,
    runtimeHigherPairs: ratios.filter(ratio => ratio > 1).length,
  }
}

const gitAfter = gitState()
const rootGraphAfter = await staticGraph(entries.root)
const runtimeGraphAfter = await staticGraph(entries.runtime)
const sourceChangedDuringRun = gitBefore.commit !== gitAfter.commit
  || gitBefore.status !== gitAfter.status
  || gitBefore.sourceSha256 !== gitAfter.sourceSha256
const buildChangedDuringRun = rootGraph.sha256 !== rootGraphAfter.sha256
  || runtimeGraph.sha256 !== runtimeGraphAfter.sha256
const result = {
  diagnosticOnly: true,
  diagnosticReason: 'Fresh-process import comparison. Hosted runners and developer machines are not dedicated benchmark hardware.',
  generatedAt: new Date().toISOString(),
  runtime: {
    name: 'Bun',
    version: Bun.version,
    executable: process.execPath,
  },
  host: {
    platform: platform(),
    release: release(),
    arch: arch(),
  },
  git: {
    before: gitBefore,
    after: gitAfter,
    changedDuringRun: sourceChangedDuringRun,
  },
  changedDuringRun: sourceChangedDuringRun || buildChangedDuringRun,
  pairs,
  entries,
  staticGraph: {
    root: rootGraph,
    runtime: runtimeGraph,
    fileCountDelta: runtimeGraph.fileCount - rootGraph.fileCount,
    byteDelta: runtimeGraph.totalBytes - rootGraph.totalBytes,
    bytePercentChange: ((runtimeGraph.totalBytes / rootGraph.totalBytes) - 1) * 100,
    after: {
      rootSha256: rootGraphAfter.sha256,
      runtimeSha256: runtimeGraphAfter.sha256,
    },
    changedDuringRun: buildChangedDuringRun,
  },
  importMs: metric('importMs'),
  rssBytes: metric('rssBytes'),
  samples,
}

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
