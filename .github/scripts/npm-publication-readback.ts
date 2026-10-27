/**
 * Read a release back from the public npm registry before the Releaser
 * reports it published (stacksjs/bun-query-builder#1197).
 *
 * `pantry publish` waits 120s to read its upload back. npm often takes three
 * or four minutes to serve a new version, so an accepted upload ended the job
 * with exit 1 and skipped the binaries and the GitHub Release. This finishes
 * that readback with a longer, bounded deadline, against the archive npm
 * accepted: the receipt in the publish log (SHA1 and SHA512), the registry
 * metadata, the tarball bytes, and the manifest inside the tarball must all
 * agree. A rejected upload, a missing or conflicting receipt, or a mismatched
 * archive still fails. Nothing here ever uploads.
 *
 * Ported from pantry's own Releaser (pantry-pm/pantry,
 * .github/scripts/npm-publication-readback.ts; contract in its
 * docs/releases.md, "npm acceptance and public availability"). Only the
 * manifest it reads differs.
 *
 * With PANTRY_NPM_PUBLISH_EXIT_CODE set, it judges that publish run first;
 * without it (a release of an existing tag), it only confirms the version npm
 * serves is a well-formed archive of this package at this version.
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { gunzipSync } from 'node:zlib'

/** Verify actual registry bytes, including the manifest inside the npm archive. */
export function verifyPublishedTarball(bytes: Uint8Array, integrity: string, name: string, version: string): string {
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (!integrity.split(/\s+/).includes(actual)) throw new Error('Published npm tarball integrity mismatch')
  const tar = gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 })
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) break
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').split('\0')[0]!.trim()
    const sizeField = field(124, 12)
    if (!/^[0-7]+$/.test(sizeField)) throw new Error('Invalid npm tar entry size')
    const size = Number.parseInt(sizeField, 8)
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error('Truncated npm tar entry')
    const prefix = field(345, 155)
    const filename = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`
    if (filename === 'package/package.json') {
      if (header[156] !== 0 && header[156] !== 48) throw new Error('Published package manifest is not a regular file')
      const manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8'))
      if (manifest.name !== name || manifest.version !== version) throw new Error('Published npm archive manifest does not match the release')
      return actual
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Published npm archive has no package/package.json')
}

export interface OriginalNpmPublication {
  name: string
  version: string
  integrity: string
  shasum: string
}

/** Associate the CLI's original archive identity with its actual package. */
export function originalPublication(log: string, name: string, version: string): OriginalNpmPublication | undefined {
  let current: Partial<OriginalNpmPublication> | undefined
  let original: OriginalNpmPublication | undefined
  for (const raw of log.split('\n')) {
    const line = stripVTControlCharacters(raw).trim()
    if (line.startsWith('Publishing ')) {
      const match = /^Publishing (.+)@([^ ]+)\.\.\.$/.exec(line)
      current = match ? { name: match[1], version: match[2] } : undefined
    }
    else if (current && line.startsWith('Shasum: ')) current.shasum = line.slice(8)
    else if (current && line.startsWith('Integrity: ')) current.integrity = line.slice(11)
    if (current?.name !== name || current.version !== version || !current.integrity || !current.shasum) continue
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(current.integrity) || !/^[a-f0-9]{40}$/.test(current.shasum))
      throw new Error('Invalid original accepted archive receipt')
    const receipt = current as OriginalNpmPublication
    if (original && (original.integrity !== receipt.integrity || original.shasum !== receipt.shasum))
      throw new Error('Conflicting original accepted archive receipts')
    original = { ...receipt }
  }
  return original
}

/** Accepted and unresolved uploads may be read back; neither may be uploaded again. */
export function publicationReadbackReceipt(exitCode: number, log: string, name: string, version: string): OriginalNpmPublication | undefined {
  const original = originalPublication(log, name, version)
  const output = stripVTControlCharacters(log)
  const pending = output.includes('Upload accepted; publication is pending public metadata')
    || output.includes('Upload outcome is pending public verification. Do not send another upload while this version may be staged.')
  if (exitCode !== 0 && (exitCode !== 1 || !pending || !original))
    throw new Error(`npm publish exited ${exitCode} without a complete original archive receipt and a pending upload outcome; no upload will be retried`)
  return original
}

interface ReadbackOptions {
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => number
  wait?: (ms: number) => Promise<void>
  timeoutMs?: number
  expectedOriginal?: OriginalNpmPublication
}

/** npm's 202 acknowledgement can precede public metadata and tarball visibility. */
export async function waitForNpmPublication(name: string, version: string, options: ReadbackOptions = {}): Promise<{ name: string, version: string, tarball: string, integrity: string, bytes: number }> {
  const fetcher = options.fetcher || fetch
  const now = options.now || Date.now
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = now() + (options.timeoutMs ?? 15 * 60_000)
  const original = options.expectedOriginal
  if (original && (original.name !== name || original.version !== version))
    throw new Error('Readback does not identify the original accepted archive')
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
  let pending = 'metadata'
  while (now() < deadline) {
    const metadataResponse = await fetcher(metadataUrl, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - now()))) })
    if (!metadataResponse.ok) {
      if (metadataResponse.status !== 404 && metadataResponse.status !== 429 && metadataResponse.status < 500)
        throw new Error(`Public npm metadata returned HTTP ${metadataResponse.status}`)
      pending = `metadata HTTP ${metadataResponse.status}`
      await metadataResponse.body?.cancel()
    }
    else {
      const metadata = await metadataResponse.json() as { name: string, version: string, dist: { tarball: string, integrity: string, shasum?: string } }
      if (metadata.name !== name || metadata.version !== version || !metadata.dist?.integrity)
        throw new Error('Public npm metadata does not match the release')
      if (original && (metadata.dist.shasum !== original.shasum || !metadata.dist.integrity.split(/\s+/).includes(original.integrity)))
        throw new Error('Public npm metadata does not match the original accepted archive')
      const url = new URL(metadata.dist.tarball)
      if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password)
        throw new Error('Unexpected npm tarball origin')
      if (now() >= deadline) break
      const archive = await fetcher(url.href, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - now()))) })
      if (archive.ok) {
        if (Number(archive.headers.get('Content-Length') || 0) > 64 * 1024 * 1024) throw new Error('Published npm archive exceeds the readback size limit')
        const bytes = new Uint8Array(await archive.arrayBuffer())
        if (bytes.length > 64 * 1024 * 1024) throw new Error('Published npm archive exceeds the readback size limit')
        if (original && (createHash('sha1').update(bytes).digest('hex') !== original.shasum
          || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== original.integrity))
          throw new Error('Public npm bytes do not match the original accepted archive')
        const integrity = verifyPublishedTarball(bytes, metadata.dist.integrity, name, version)
        return { name, version, tarball: url.href, integrity, bytes: bytes.length }
      }
      if (archive.status !== 404 && archive.status !== 429 && archive.status < 500)
        throw new Error(`Public npm tarball returned HTTP ${archive.status}`)
      pending = `tarball HTTP ${archive.status}`
      await archive.body?.cancel()
    }
    await wait(Math.min(5000, Math.max(0, deadline - now())))
  }
  throw new Error(`Public npm publication did not become readable before its deadline (${pending})`)
}

if (import.meta.main) {
  const output = 'artifacts/npm-publication/proof.json'
  await mkdir(dirname(output), { recursive: true })
  const manifest = await Bun.file('packages/bun-query-builder/package.json').json()
  // Empty when the workflow released an existing tag and published nothing.
  const publishExit = process.env.PANTRY_NPM_PUBLISH_EXIT_CODE || undefined
  let original: OriginalNpmPublication | undefined
  try {
    if (publishExit !== undefined) {
      if (!/^\d+$/.test(publishExit)) throw new Error('Invalid npm publication exit code')
      const log = await Bun.file('artifacts/npm-publication/publish.log').text()
      original = publicationReadbackReceipt(Number(publishExit), log, manifest.name, manifest.version)
    }
    const result = await waitForNpmPublication(manifest.name, manifest.version, { expectedOriginal: original })
    await Bun.write(output, JSON.stringify({ at: new Date().toISOString(), passed: true, publishExitCode: publishExit === undefined ? null : Number(publishExit), original, ...result }, null, 2) + '\n')
    console.log(`Verified public ${result.name}@${result.version}, ${result.bytes} archive bytes and SHA512 integrity`)
  }
  catch (error) {
    await Bun.write(output, JSON.stringify({ at: new Date().toISOString(), passed: false, name: manifest.name, version: manifest.version, publishExitCode: publishExit ?? null, original, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n')
    throw error
  }
}
