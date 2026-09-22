/**
 * The repository's packaging face: package identity, entry points, the profile
 * bundle patch row, the license files, and the vendored dictionary's exact
 * bytes.
 *
 * Every assertion reads a committed file and resolves it from this file's own
 * location, so the suite runs from any working directory. The committed
 * `lib/` artifacts are asserted for presence, identity, and byte equality with
 * the vendored resource, because a git install loads them without a build.
 * @module dsh-token-perf/tests/manifest
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Module specifiers a browser bundle may keep: the shell's platform module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Repository root, resolved from this file rather than from the working directory. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The vendored dictionary, as recorded in `THIRD_PARTY_NOTICES.md` and `NOTICE`. */
const DICTIONARY = 'src/store/zstd-dictionary.bin'
const DICTIONARY_SHA256 = 'dad18fa0247a8fdd886a62d8552eabd36cbd50c25af172873080d2f0ae770d17'
const DICTIONARY_BYTES = 65_409

/** The names both halves of the plugin share; the wire contract must not lose one silently. */
const FROZEN_EXPORTS = [
  'DayReport',
  'DayReportResponse',
  'SessionUsage',
  'ModelUsage',
  'TokenBuckets',
  'RateStats',
  'CompactionStats',
  'SubagentStats',
  'DayTotals',
] as const

/** Read one committed file as UTF-8 text. */
function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/** The package manifest fields this suite pins. */
interface PackageManifest {
  name: string
  license: string
  type: string
  main?: string
  types?: string
  exports?: Record<string, { default?: string }>
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
  files?: string[]
}

describe('package.json', () => {
  const manifest = JSON.parse(readText('package.json')) as PackageManifest

  it('names the package, its license, and its module system', () => {
    expect(manifest.name).toBe('dsh-token-perf')
    expect(manifest.license).toBe('Apache-2.0')
    expect(manifest.type).toBe('module')
  })

  it('exposes built entry points under lib/', () => {
    expect(manifest.main?.startsWith('lib/')).toBe(true)
    expect(manifest.types?.startsWith('lib/')).toBe(true)
    expect(manifest.exports?.['.']?.default).toBe('./lib/index.js')
    expect(manifest.exports?.['./client']?.default).toBe('./lib/client.js')
  })

  it('declares the profile bundle patch and the web client half', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh?.client?.platform).toBe('web')
  })

  it('ships the vendored dictionary in the published files', () => {
    expect(manifest.files ?? []).toContain('lib/zstd-dictionary.bin')
  })
})

describe('cordis.patch.yml', () => {
  const patch = readText('cordis.patch.yml')

  it('inserts one host row for this package', () => {
    expect(patch).toMatch(/-\s+insert:/)
    expect(patch).toContain('id: token-perf')
    expect(patch).toContain("name: 'dsh-token-perf'")
  })

  it('carries the row id and the package name in the same insert entry', () => {
    expect(patch).toMatch(/insert:[\s\S]*?id:\s*token-perf[\s\S]*?name:\s*['"]dsh-token-perf['"]/)
  })
})

describe('license files', () => {
  it('carries the Apache License 2.0 text', () => {
    const license = readText('LICENSE')
    expect(license).toContain('Apache License')
    expect(license).toContain('Version 2.0, January 2004')
    expect(license).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION')
    expect(license).toContain('END OF TERMS AND CONDITIONS')
  })

  it('attributes the vendored dictionary to DeepSeek under the MIT license', () => {
    const notice = readText('NOTICE')
    expect(notice).toContain('DeepSeek')
    expect(notice).toContain('MIT License')
    expect(notice).toContain('zstd-dictionary.bin')
  })
})

describe('vendored zstd dictionary', () => {
  const bytes = readFileSync(join(ROOT, DICTIONARY))

  it('matches the recorded size', () => {
    expect(statSync(join(ROOT, DICTIONARY)).size).toBe(DICTIONARY_BYTES)
    expect(bytes.byteLength).toBe(DICTIONARY_BYTES)
  })

  it('matches the recorded sha256', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(DICTIONARY_SHA256)
  })
})

describe('frozen wire contract', () => {
  const types = readText('src/aggregate/types.ts')

  it('still exports every shared name', () => {
    const missing = FROZEN_EXPORTS.filter(
      name => !new RegExp(`export (?:interface|type) ${name}\\b`).test(types),
    )
    expect(missing).toEqual([])
  })
})

describe('committed build artifacts', () => {
  /**
   * `lib/` is committed so a git install needs no build step, which makes the
   * artifacts a distribution contract rather than a local output. These checks
   * cover what can be verified without a rebuild: presence, identity, and the
   * vendored resource's byte equality with its source. Rebuilding against a
   * changed source is covered by `pnpm build` in development, not here.
   */
  const artifacts = ['lib/index.js', 'lib/client.js', 'lib/zstd-dictionary.bin'] as const

  it('ships every entry point an installer loads', () => {
    for (const artifact of artifacts) {
      expect(statSync(join(ROOT, artifact)).size, artifact).toBeGreaterThan(0)
    }
  })

  it('keeps the built dictionary identical to the vendored source', () => {
    const vendored = readFileSync(join(ROOT, DICTIONARY))
    const built = readFileSync(join(ROOT, 'lib/zstd-dictionary.bin'))
    expect(built.equals(vendored)).toBe(true)
  })

  it('registers the client bundle under the id the profile row names', () => {
    const bundle = readText('lib/client.js')
    expect(bundle).toContain('window.__ModuleLoader__.load(')
    expect(bundle).toContain('id: "dsh-token-perf"')
    const foreign = [...bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)]
      .map(match => match[1] ?? '')
      .filter(specifier => !PLATFORM_MODULES.includes(specifier))
    expect(foreign).toEqual([])
  })

  it('exposes the host plugin identity and its config schema', () => {
    const host = readText('lib/index.js')
    expect(host).toContain('dsh-token-perf')
    expect(host).toMatch(/export\s*\{[^}]*\bapply\b/)
    expect(host).toMatch(/export\s*\{[^}]*\bConfig\b/)
  })
})

describe('committed artifacts are not stale', () => {
  /**
   * `lib/` is what a git install loads, so a source edit that never reached it
   * ships as a defect. The build records the digest of every source file it
   * consumed; recomputing it here fails the suite when the two diverge.
   */
  const SOURCE = 'src'
  const FINGERPRINT = 'lib/build-fingerprint.json'

  /** @returns repository-relative POSIX paths of every file under one directory. */
  function listFiles(directory: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue
      const parent = (entry as { parentPath?: string; path: string }).parentPath ?? entry.path
      found.push(relative(ROOT, join(parent, entry.name)).split(sep).join('/'))
    }
    return found.sort()
  }

  it('matches the committed build fingerprint', () => {
    const recorded = JSON.parse(readText(FINGERPRINT)) as { digest: string; files: Record<string, string> }
    const current = Object.fromEntries(
      listFiles(SOURCE).map(path => [path, createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')]),
    )
    expect(recorded.files).toEqual(current)
    expect(recorded.digest).toBe(
      createHash('sha256')
        .update(Object.entries(current).map(([path, hash]) => `${path}\0${hash}\n`).join(''))
        .digest('hex'),
    )
  })
})
