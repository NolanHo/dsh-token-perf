/**
 * tsdown build for dsh-token-perf:
 * - lib/index.js — the node half (ESM); node builtins, cordis, and every
 *   @deepseek-ai/ package stay external and resolve from the profile.
 * - lib/client.js — the browser half: a CJS closure registered with
 *   window.__ModuleLoader__.load({ id: 'dsh-token-perf', factory }), whose
 *   require resolves only platform module-table entries (react, cordis, the
 *   client slots and primitives). Everything else inlines, and two purity
 *   gates reject any import or surviving require() outside that table.
 */
import type { UserConfig } from 'tsdown'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/**
 * Platform module-table entries the client factory resolves at runtime —
 * the shell's PLATFORM_MODULES list (packages/client/web/src/platform.ts).
 */
const CLIENT_EXTERNALS = [
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

/** Absolute prefix of this package's own sources, shared by both faces. */
const SOURCE_ROOT = fileURLToPath(new URL('src/', import.meta.url))

/** Every require() the emitted client bundle is allowed to keep. */
const REQUIRE_PATTERN = /\brequire\(\s*["']([^"']+)["']\s*\)/g

/** Client-bundle purity gates: only the platform table may leave the bundle. */
const purityGate = {
  name: 'dsh-token-perf-client-purity',
  resolveId(source: string) {
    if (NODE_BUILTINS.has(source)) {
      throw new Error(
        `client bundle purity: Node builtin "${source}" cannot run in the browser module table`,
      )
    }
    if (!source.startsWith('@deepseek-ai/')) return null
    if (CLIENT_EXTERNALS.includes(source)) return null
    throw new Error(
      `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — value imports are forbidden; collaborate through cordis services`,
    )
  },
  /**
   * Check the chunk's module graph rather than its emitted text: minification
   * renames the factory's `require` parameter, so a textual scan for
   * `require(...)` silently stops checking anything once the client bundle is
   * minified. Every module in the graph must be this plugin's own source or a
   * platform-table external — which also enforces the plugin's "zero
   * third-party runtime bytes" contract.
   */
  generateBundle(
    _options: unknown,
    bundle: Record<string, { type: string; code?: string; moduleIds?: string[] }>,
  ) {
    for (const [fileName, chunk] of Object.entries(bundle)) {
      if (chunk.type !== 'chunk') continue
      for (const id of chunk.moduleIds ?? []) {
        if (id.startsWith('\0')) continue
        if (CLIENT_EXTERNALS.includes(id)) continue
        // This plugin's own source, wherever it sits: the client half shares
        // pure helpers with the host half (the local-day arithmetic, the buckets).
        if (id.startsWith(SOURCE_ROOT) || id.startsWith('.')) continue
        throw new Error(
          `client bundle purity: ${fileName} pulls in "${id}", which is neither this plugin's own source nor a platform module`,
        )
      }
      for (const match of (chunk.code ?? '').matchAll(REQUIRE_PATTERN)) {
        const specifier = match[1] ?? ''
        if (CLIENT_EXTERNALS.includes(specifier)) continue
        throw new Error(
          `client bundle purity: ${fileName} requires "${specifier}", which is not a platform module`,
        )
      }
    }
  },
}

const define = {
  'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  'import.meta.resolve': 'undefined',
}

const client: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  // The browser bundle is a served artifact, not something anyone reads on
  // disk: comments and whitespace are download weight with no reader. The
  // module loader wrapper and the string literals it needs survive minification.
  minify: true,
  external: [...CLIENT_EXTERNALS],
  define,
  inputOptions: {
    resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [purityGate],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-token-perf", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

const host: UserConfig = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [/^node:/, 'cordis', /^@deepseek-ai\//],
  define,
  outputOptions: {
    entryFileNames: 'index.js',
    codeSplitting: false,
  },
}

export default [host, client]
