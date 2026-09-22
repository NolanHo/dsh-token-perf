/**
 * Host half of dsh-token-perf: the day-report endpoint behind `/api/token-perf`.
 *
 * The plugin claims one prefix route and owns every response on it, so no
 * composition-level fallback has to know this plugin's paths. The route is
 * fixed rather than configurable: the browser half is built against the same
 * constant, and a configurable prefix would let the two halves of one release
 * disagree. `/api/token-perf` is a local analytics surface, so it answers
 * loopback peers only and serves domain failures as a 200 envelope the panel
 * can render, keeping the transport status for transport-level facts.
 * @module dsh-token-perf
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.ts';
/** Cordis function-plugin name. */
export declare const name = "dsh-token-perf";
export { Config } from './config.ts';
/**
 * Register the day-report route on the composition's webserver.
 *
 * The route is registered only once `webServer` is available, so the plugin
 * loads unchanged in compositions without one, and registration is an effect
 * that unregisters on disposal.
 * @param ctx - the plugin's cordis context.
 * @param config - resolved `dsh-token-perf` configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
