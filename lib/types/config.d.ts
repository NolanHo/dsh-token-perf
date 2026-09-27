/**
 * The Host half's configuration surface.
 *
 * A cordis composition declares these fields under the `dsh-token-perf` entry;
 * Schemastery fills the four that have a default, so the plugin's `apply`
 * always receives every field resolved.
 * @module dsh-token-perf/config
 */
import z from '@deepseek-ai/schemastery';
/** Host configuration for the day report. */
export interface Config {
    /** SQLite session store to read; defaults to the host's own store. */
    databasePath?: string;
    /** zstd dictionary the store's payloads were compressed with; defaults to the vendored copy. */
    dictionaryPath?: string;
    /** IANA zone one report's day boundaries are resolved in; defaults to the host's own. */
    timeZone?: string;
    /** How long a finished report may be served from cache, in milliseconds; `0` disables caching. */
    cacheTtlMs: number;
    /**
     * Retry share at which a `(day, route)` window is reported as a retry signal,
     * `0..1`. It is the second gate only: a route needs at least 100 settled calls
     * before its Wilson 95% lower bound is compared against this value, so the
     * signal never fires on a small sample.
     */
    retryThresholdShare: number;
}
/**
 * The dictionary shipped beside the built entry: `pnpm build` copies
 * `src/store/zstd-dictionary.bin` next to `lib/index.js`, so the bundle's own
 * URL is the only path that survives packaging. The service falls back to it
 * when called with a configuration that skipped schema resolution.
 */
export declare const DEFAULT_DICTIONARY_PATH: string;
/** The configuration schema a cordis composition validates this plugin's entry against. */
export declare const Config: z<Partial<Config>, Config>;
