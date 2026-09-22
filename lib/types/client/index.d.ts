/**
 * Browser half of dsh-token-perf.
 *
 * The plugin contributes one settings page (`settings.section`, id
 * `token-perf`) rendering the day dashboard, plus the dictionaries and the
 * style tag that page needs. Nothing else is registered: the page owns its own
 * header, navigation, and data reads through `/api/token-perf/day`.
 *
 * The nav row's label is read from the slot ledger, so it is both a thunk (a
 * projection re-reads it) and republished by a fresh registration on every
 * locale change — the ledger bump is what re-renders the shell's nav. The
 * registered component is a module-level reference, so React keeps the mounted
 * dashboard, and with it the day already read, across that re-registration.
 * @module dsh-token-perf/client
 */
import type { Context } from '@deepseek-ai/cordis';
/** Services required before activation. */
export declare const inject: readonly ["slots", "locale"];
/**
 * Register the settings page, its dictionaries, and its styles.
 * @param ctx - the client context carrying the injected services.
 */
export declare function apply(ctx: Context): void;
