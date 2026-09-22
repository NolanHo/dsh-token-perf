/**
 * Write `lib/build-fingerprint.json`, the digest of every source file the
 * build consumed.
 *
 * `lib/` is committed because a git install runs no build, so the artifacts
 * are a distribution contract and a source edit that never reached them is a
 * released defect. `tests/manifest.spec.ts` recomputes this digest from `src/`
 * and compares, which turns "the committed bundle is stale" into a failing
 * test instead of a silent one.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'src')
const OUTPUT = join(ROOT, 'lib', 'build-fingerprint.json')

/**
 * List every file under one directory, repository-relative and sorted.
 * @param directory - absolute directory to walk.
 * @returns repository-relative POSIX paths.
 */
function listFiles(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    found.push(relative(ROOT, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/'))
  }
  return found.sort()
}

const files = Object.fromEntries(
  listFiles(SOURCE).map(path => [path, createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')]),
)
const digest = createHash('sha256')
  .update(Object.entries(files).map(([path, hash]) => `${path}\0${hash}\n`).join(''))
  .digest('hex')

writeFileSync(OUTPUT, `${JSON.stringify({ algorithm: 'sha256', digest, files }, null, 2)}\n`)
console.log(`build-fingerprint: ${Object.keys(files).length} source files, digest ${digest}`)
