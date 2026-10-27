/**
 * The Releaser's public npm readback (stacksjs/bun-query-builder#1197).
 * Ported with the script from pantry's own Releaser tests; the last case reads
 * a receipt in the exact form this package's publish log prints it.
 */
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { originalPublication, publicationReadbackReceipt, verifyPublishedTarball, waitForNpmPublication } from '../../../.github/scripts/npm-publication-readback'

function fixture(name = 'bun-query-builder', version = '1.2.3', description?: string): { bytes: Buffer, integrity: string } {
  const json = Buffer.from(JSON.stringify({ name, version, description }))
  const header = Buffer.alloc(512)
  header.write('package/package.json')
  header.write(json.length.toString(8).padStart(11, '0'), 124)
  header[156] = 48
  header.fill(32, 148, 156)
  header.write([...header].reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  const bytes = gzipSync(Buffer.concat([header, json, Buffer.alloc(512 - json.length), Buffer.alloc(1024)]))
  return { bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
}

test('public readback verifies actual tarball integrity and its internal release identity', () => {
  const archive = fixture()
  expect(verifyPublishedTarball(archive.bytes, archive.integrity, 'bun-query-builder', '1.2.3')).toBe(archive.integrity)
  expect(() => verifyPublishedTarball(archive.bytes, 'sha512-wrong', 'bun-query-builder', '1.2.3')).toThrow('integrity mismatch')
  expect(() => verifyPublishedTarball(archive.bytes, archive.integrity, 'bun-query-builder', '1.2.4')).toThrow('manifest does not match')
  const invalid = gzipSync(Buffer.from('incomplete tar'))
  const integrity = `sha512-${createHash('sha512').update(invalid).digest('base64')}`
  expect(() => verifyPublishedTarball(invalid, integrity, 'bun-query-builder', '1.2.3')).toThrow('no package/package.json')
})

test('an accepted asynchronous publication must expose both metadata and verified archive bytes', async () => {
  const archive = fixture()
  let clock = 0
  let requests = 0
  const result = await waitForNpmPublication('bun-query-builder', '1.2.3', {
    now: () => clock, wait: async ms => { clock += ms }, timeoutMs: 30_000,
    fetcher: (async (url) => {
      requests++
      if (requests === 1 || requests === 3) return new Response(null, { status: 404 })
      if (String(url).endsWith('.tgz')) return new Response(archive.bytes)
      return Response.json({ name: 'bun-query-builder', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/bun-query-builder/-/bun-query-builder-1.2.3.tgz', integrity: archive.integrity } })
    }),
  })
  expect(requests).toBe(5)
  expect(clock).toBe(10_000)
  expect(result.integrity).toBe(archive.integrity)
})

test('a staged version that never becomes readable fails within the readback deadline', async () => {
  let clock = 0
  await expect(waitForNpmPublication('bun-query-builder', '1.2.3', {
    now: () => clock, wait: async ms => { clock += ms }, timeoutMs: 10_000,
    fetcher: async () => new Response(null, { status: 404 }),
  })).rejects.toThrow('before its deadline')
  expect(clock).toBe(10_000)
})

test('self-consistent public bytes for the same version cannot replace the original accepted archive', async () => {
  const original = fixture()
  const other = fixture('bun-query-builder', '1.2.3', 'different original publication')
  await expect(waitForNpmPublication('bun-query-builder', '1.2.3', {
    expectedOriginal: { name: 'bun-query-builder', version: '1.2.3', integrity: original.integrity, shasum: createHash('sha1').update(original.bytes).digest('hex') },
    fetcher: async url => String(url).endsWith('.tgz')
      ? new Response(other.bytes)
      : Response.json({ name: 'bun-query-builder', version: '1.2.3', dist: { tarball: 'https://registry.npmjs.org/bun-query-builder/-/bun-query-builder-1.2.3.tgz', integrity: other.integrity, shasum: createHash('sha1').update(other.bytes).digest('hex') } }),
  })).rejects.toThrow('original accepted archive')
})

test('an accepted pending exit proceeds only with the complete original package receipt', () => {
  const archive = fixture()
  const receipt = { name: 'bun-query-builder', version: '1.2.3', integrity: archive.integrity, shasum: createHash('sha1').update(archive.bytes).digest('hex') }
  const printed = `\u001B[32mPublishing bun-query-builder@1.2.3...\u001B[0m\nShasum: ${receipt.shasum}\nIntegrity: ${receipt.integrity}\n`
  const pending = 'Error: Upload accepted; publication is pending public metadata and verified tarball availability. Do not upload this version again.'
  expect(originalPublication(printed, receipt.name, receipt.version)).toEqual(receipt)
  expect(publicationReadbackReceipt(1, printed + pending, receipt.name, receipt.version)).toEqual(receipt)
  expect(() => publicationReadbackReceipt(1, printed + 'Error: access denied', receipt.name, receipt.version)).toThrow('without a complete original archive receipt')
  expect(() => publicationReadbackReceipt(1, pending, receipt.name, receipt.version)).toThrow('without a complete original archive receipt')
  expect(() => publicationReadbackReceipt(1, printed + pending, 'other-package', receipt.version)).toThrow('without a complete original archive receipt')
  expect(publicationReadbackReceipt(0, 'Version already published; skipped.', receipt.name, receipt.version)).toBeUndefined()
})

test('an unresolved upload proceeds only to bounded original-byte readback, never another upload', async () => {
  const archive = fixture()
  const original = { name: 'bun-query-builder', version: '1.2.3', integrity: archive.integrity, shasum: createHash('sha1').update(archive.bytes).digest('hex') }
  const pending = 'Upload outcome is pending public verification. Do not send another upload while this version may be staged.'
  const log = `Publishing bun-query-builder@1.2.3...\nShasum: ${original.shasum}\nIntegrity: ${original.integrity}\nError: ${pending}`
  const receipt = publicationReadbackReceipt(1, log, original.name, original.version)
  expect(receipt).toEqual(original)
  expect(() => publicationReadbackReceipt(1, pending, original.name, original.version)).toThrow('complete original archive receipt')
  expect(() => publicationReadbackReceipt(2, log, original.name, original.version)).toThrow('complete original archive receipt')
  let clock = 0
  let reads = 0
  const result = await waitForNpmPublication(original.name, original.version, {
    expectedOriginal: receipt,
    now: () => clock, wait: async ms => { clock += ms }, timeoutMs: 20_000,
    fetcher: async (url, init) => {
      expect(init?.method || 'GET').toBe('GET')
      reads++
      if (reads === 1 || reads === 3) return new Response(null, { status: 404 })
      return String(url).endsWith('.tgz')
        ? new Response(archive.bytes)
        : Response.json({ ...original, dist: { tarball: 'https://registry.npmjs.org/bun-query-builder/-/bun-query-builder-1.2.3.tgz', integrity: original.integrity, shasum: original.shasum } })
    },
  })
  expect(clock).toBe(10_000)
  expect(reads).toBe(5)
  expect(result.integrity).toBe(original.integrity)
})

test('a second original identity for one version refuses readback rather than choosing one', () => {
  const a = fixture()
  const b = fixture('bun-query-builder', '1.2.3', 'another archive')
  const log = [a, b].map(archive => `Publishing bun-query-builder@1.2.3...\nShasum: ${createHash('sha1').update(archive.bytes).digest('hex')}\nIntegrity: ${archive.integrity}`).join('\n')
  expect(() => originalPublication(log, 'bun-query-builder', '1.2.3')).toThrow('Conflicting original accepted archive receipts')
})

test('accepted receipt readback waits for public metadata and matches the original SHA1 and SHA512', async () => {
  const archive = fixture()
  const original = { name: 'bun-query-builder', version: '1.2.3', integrity: archive.integrity, shasum: createHash('sha1').update(archive.bytes).digest('hex') }
  let clock = 0
  let reads = 0
  const result = await waitForNpmPublication(original.name, original.version, {
    expectedOriginal: original,
    now: () => clock, wait: async ms => { clock += ms }, timeoutMs: 20_000,
    fetcher: async url => {
      reads++
      if (reads === 1) return new Response(null, { status: 404 })
      return String(url).endsWith('.tgz')
        ? new Response(archive.bytes)
        : Response.json({ ...original, dist: { tarball: 'https://registry.npmjs.org/bun-query-builder/-/bun-query-builder-1.2.3.tgz', integrity: original.integrity, shasum: original.shasum } })
    },
  })
  expect(clock).toBe(5_000)
  expect(result.integrity).toBe(original.integrity)
  expect(reads).toBe(3)
})

test('reads the receipt from this package\'s own publish log, as the 0.3.28 release printed it', () => {
  // Verbatim from the v0.3.28 Releaser run, which npm then served with this shasum.
  const log = [
    'Publishing bun-query-builder@0.3.28...',
    'Shasum: d55235f897fe8294698017cc0b31555ea0183800',
    'Integrity: sha512-NQu5f3ZryKULjNu5nj/sKrgXaZMxjQArijjqoKH7oxUegPxGLA5MlJUq+xrmoId0Cw71f+vssLKhrTUfZFPVpw==',
    'Upload accepted; publication is pending public metadata and verified tarball availability. Do not upload this version again.',
  ].join('\n')
  expect(publicationReadbackReceipt(1, log, 'bun-query-builder', '0.3.28')).toEqual({
    name: 'bun-query-builder',
    version: '0.3.28',
    shasum: 'd55235f897fe8294698017cc0b31555ea0183800',
    integrity: 'sha512-NQu5f3ZryKULjNu5nj/sKrgXaZMxjQArijjqoKH7oxUegPxGLA5MlJUq+xrmoId0Cw71f+vssLKhrTUfZFPVpw==',
  })
})
