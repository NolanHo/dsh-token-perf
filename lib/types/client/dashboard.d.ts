/**
 * The dsh-token-perf day dashboard: a self-contained settings page that reads
 * one local day's report from `/api/token-perf/day` and renders the frozen
 * wire contract.
 *
 * The module owns its whole data path — request, wire-boundary validation,
 * store, and view — so the settings shell only has to mount one component. The
 * two seams the browser cannot provide itself are injectable: the fetch face
 * (tests substitute a stub, the browser gets the platform one) and the clock
 * (which resolves "today" in the host's zone). The store is created by the
 * component rather than handed in by the slot registration, so React keeps it
 * across the ledger bumps a locale change causes.
 * @module dsh-token-perf/client/dashboard
 */
import type { ReactNode } from 'react';
import type { DayReport, DayReportErrorCode, SessionUsage } from '../aggregate/types.ts';
import type { Translator } from './locales.ts';
/** The Host route this page reads; fixed by the release, not configurable. */
export declare const DAY_ENDPOINT = "/api/token-perf/day";
/** The read-only HTTP response face the day source consumes. */
export interface ResponseLike {
    /** Whether the host treated the request as successful. */
    readonly ok: boolean;
    /** HTTP status, read when {@link ResponseLike.ok} is false. */
    readonly status: number;
    /**
     * Parse the body as JSON.
     * @returns the parsed body.
     */
    json(): Promise<unknown>;
}
/**
 * The fetch face the day source calls.
 *
 * Deliberately structural: the browser passes the platform `fetch`, tests pass
 * a stub, and neither has to construct a real `Response`. Credentials are fixed
 * to `same-origin` — the route is loopback-only and must ride the page's own
 * origin rather than a cookie-less cross-origin request.
 */
export type FetchLike = (input: string, init: {
    credentials: 'same-origin';
}) => Promise<ResponseLike>;
/** Why one day's report could not be read. */
export type DayReportFailure = {
    readonly kind: 'report';
    readonly code: DayReportErrorCode;
    readonly message: string;
} | {
    readonly kind: 'http';
    readonly status: number;
} | {
    readonly kind: 'malformed';
} | {
    readonly kind: 'network';
};
/** One day's read result: the report, or the failure the panel renders. */
export type DayReportLoad = {
    readonly ok: true;
    readonly report: DayReport;
} | {
    readonly ok: false;
    readonly failure: DayReportFailure;
};
/**
 * Read one day's report envelope.
 * @param date - local calendar day, `YYYY-MM-DD`.
 * @returns the report or the failure to display; never rejects.
 */
export type DayReportSource = (date: string) => Promise<DayReportLoad>;
/** Options for the same-origin HTTP source. */
export interface HttpSourceOptions {
    /** Fetch implementation; defaults to the runtime's own. */
    fetchImpl?: FetchLike;
    /** Route to read; defaults to {@link DAY_ENDPOINT}. */
    endpoint?: string;
}
/** What the page is showing right now. */
export type DashboardSnapshot = {
    readonly status: 'loading';
    readonly date: string;
} | {
    readonly status: 'ready';
    readonly date: string;
    readonly report: DayReport;
} | {
    readonly status: 'error';
    readonly date: string;
    readonly failure: DayReportFailure;
};
/** The day the page reads and the state of that read. */
export interface DashboardStore {
    /**
     * Subscribe to snapshot changes.
     * @param listener - called after every published snapshot.
     * @returns the unsubscribe function.
     */
    subscribe(listener: () => void): () => void;
    /**
     * Read the current snapshot.
     * @returns the snapshot, referentially stable until it changes.
     */
    getSnapshot(): DashboardSnapshot;
    /**
     * Read the snapshot for React's server renderer, which cannot subscribe.
     * @returns the same snapshot as {@link DashboardStore.getSnapshot}.
     */
    getServerSnapshot(): DashboardSnapshot;
    /**
     * Show one day, fetching its report.
     * @param date - local calendar day, `YYYY-MM-DD`.
     * @returns a promise settling after the load is published; a stale load
     *   (the user moved on before it finished) publishes nothing.
     */
    open(date: string): Promise<void>;
    /**
     * Re-read the day currently shown.
     * @returns a promise settling after the load is published.
     */
    refresh(): Promise<void>;
    /**
     * Resolve the runtime's current local day in the report's own zone once one
     * has been read, and in the runtime's zone before that.
     * @returns the `YYYY-MM-DD` key of today.
     */
    today(): string;
}
/** Options for {@link createDashboardStore}. */
export interface DashboardStoreOptions {
    /** Reads one day's envelope. */
    load: DayReportSource;
    /** Clock in epoch milliseconds; defaults to `Date.now`. */
    now?: () => number;
    /** Zone that resolves "today" before a report names one; defaults to the runtime's. */
    timeZone?: string;
    /** Day to open on; defaults to the clock's local today. */
    initialDate?: string;
}
/** Props the dashboard accepts; every one has a production default. */
export interface DashboardProps {
    /** Copy resolver; defaults to the module-level translator bound to the active locale. */
    t?: Translator;
    /**
     * Store to render; the component creates and drives its own when absent. An
     * injected store is driven by its owner (tests open days on it directly).
     */
    store?: DashboardStore;
    /** Day source for the owned store; defaults to the same-origin HTTP source. */
    load?: DayReportSource;
    /** Clock for the owned store; defaults to `Date.now`. */
    now?: () => number;
    /** Day the owned store opens on; defaults to the clock's local today. */
    initialDate?: string;
}
/** The session-table sort keys. */
export type SessionSort = 'tokens' | 'messages' | 'tools';
/**
 * Build the same-origin day source.
 * @param options - fetch face and route override.
 * @returns the source; transport and parsing failures come back as failures
 *   rather than as thrown errors.
 */
export declare function createHttpSource(options?: HttpSourceOptions): DayReportSource;
/**
 * Create the page's day store.
 * @param options - day source, clock, zone, and opening day.
 * @returns the store the dashboard subscribes to.
 */
export declare function createDashboardStore(options: DashboardStoreOptions): DashboardStore;
/**
 * Whether the day carries no activity at all.
 *
 * A day with sessions but no metered call is not empty — the session table
 * still has rows worth reading — so every channel must be silent for the empty
 * state to replace the report body.
 * @param report - the day's report.
 * @returns whether the empty-day state applies.
 */
export declare function isEmptyDay(report: DayReport): boolean;
/**
 * Order the session table.
 * @param sessions - session rows from the report.
 * @param sort - the measure to sort by.
 * @returns a copy ordered by that measure, descending; equal measures keep the
 *   report's own token-descending order.
 */
export declare function sortSessions(sessions: readonly SessionUsage[], sort: SessionSort): SessionUsage[];
/**
 * The settings page: one day's report with its own header and states.
 * @param props - copy resolver and the injectable data seams.
 * @returns the page element tree.
 */
export declare function Dashboard(props: DashboardProps): ReactNode;
