/**
 * The day-report wire contract shared by both halves of dsh-token-perf.
 *
 * The Host aggregates one local calendar day from the session store and
 * serializes {@link DayReportResponse} as JSON; the browser half renders it.
 * This module is the frozen boundary between them: adding a field is
 * compatible, and changing one requires both halves in the same release.
 * @module dsh-token-perf/aggregate/types
 */
/** Provider-reported token buckets for one model, session, or the whole day. */
export interface TokenBuckets {
    /** Prompt tokens billed at the full input rate. */
    input: number;
    /** Completion tokens, including any reasoning tokens the provider bills as output. */
    output: number;
    /** Prompt tokens served from the provider's cache. */
    cacheRead: number;
    /** Prompt tokens written to the provider's cache; zero when the provider reports none. */
    cacheWrite: number;
    /** Reasoning tokens, reported only by providers that expose them separately. */
    reasoning: number;
}
/** One provider/model route's usage inside the day. */
export interface ModelUsage extends TokenBuckets {
    /** Provider half of the route, as recorded on the assistant message. */
    provider: string;
    /** Model half of the route. */
    model: string;
    /** Completed assistant messages attributed to this route. */
    calls: number;
}
/** One session's activity inside the day. */
export interface SessionUsage extends TokenBuckets {
    /** Logical session key. */
    id: string;
    /** Latest folded title, absent when the session never set one. */
    title?: string;
    /** Parent session key when this session is a subagent. */
    parentId?: string;
    /** `subagent` for a delegated session, `root` for a top-level one. */
    origin: 'root' | 'subagent';
    /** Agent preset recorded on the session header, when present. */
    agentPreset?: string;
    /** Session creation time in epoch milliseconds. */
    createdAt: number;
    /** Timestamp of the session's last event inside the day. */
    lastActivityAt: number;
    /** Human-role prompts recorded in the day. */
    userMessages: number;
    /** Assistant messages recorded in the day. */
    assistantMessages: number;
    /** Tool invocations recorded in the day. */
    toolCalls: number;
    /** Tool results recorded in the day; not derivable from `toolCalls`. */
    toolResults: number;
    /** Compactions started in the day. */
    compactions: number;
    /** Usage samples attributed to this session; see {@link DayTotals.llmCalls}. */
    llmCalls: number;
    /** Subagent sessions this session created in the day. */
    subagents: number;
    /** Distinct `provider/model` routes this session used in the day. */
    models: string[];
}
/** One local hour's metered token completions. */
export interface RateBucket {
    /** Local hour of day, 0 through 23. */
    hour: number;
    /** Tokens completed in this hour. */
    tokens: number;
    /** Model calls completed in this hour. */
    calls: number;
}
/** Token consumption rate derived from per-minute completion buckets. */
export interface RateStats {
    /** Exactly 24 entries, index equal to {@link RateBucket.hour}. */
    buckets: RateBucket[];
    /** Largest single-minute token completion in the day. */
    peakPerMinute: number;
    /** Mean tokens per minute across {@link activeMinutes}. */
    avgPerActiveMinute: number;
    /** Minutes with at least one metered completion. */
    activeMinutes: number;
    /** Minutes from the day's first to last metered completion, inclusive. */
    spanMinutes: number;
}
/** Context-compaction activity for the day. */
export interface CompactionStats {
    /** Compactions started in the day. */
    events: number;
    /** Compaction summaries produced in the day. */
    summaries: number;
    /** Tokens billed to summary generation, which the main-loop fold excludes. */
    summaryTokens: TokenBuckets;
}
/** Subagent delegation summarized for the day. */
export interface SubagentStats {
    /** Subagent sessions created in the day. */
    total: number;
    /** Sessions that created at least one subagent in the day, subagent parents included. */
    spawningSessions: number;
    /** Largest number of subagents created by one session in the day. */
    maxPerSession: number;
    /** Subagent counts by the parent session's agent preset, descending by count. */
    byPreset: Array<{
        preset: string;
        count: number;
    }>;
    /** Subagent counts by the child's recorded `provider/model`, descending by count. */
    byModel: Array<{
        model: string;
        count: number;
    }>;
}
/** Day-wide counters and token buckets. */
export interface DayTotals extends TokenBuckets {
    /** Sessions created in the day, root and subagent alike. */
    sessionsOpened: number;
    /** Sessions with at least one event in the day. */
    sessionsActive: number;
    /** Subagent sessions created in the day. */
    subagents: number;
    /** Human-role prompts recorded in the day. */
    userMessages: number;
    /** Assistant messages recorded in the day. */
    assistantMessages: number;
    /** Tool invocations recorded in the day. */
    toolCalls: number;
    /** Tool results recorded in the day. */
    toolResults: number;
    /** Compactions started in the day. */
    compactions: number;
    /**
     * Usage samples folded in the day: completed assistant messages, the attempt
     * streams that carry a sample of their own, and compaction summaries. It is
     * therefore a settlement count, not `assistantMessages`, and the two differ.
     */
    llmCalls: number;
}
/** One local calendar day of token, message, tool, and session activity. */
export interface DayReport {
    /** Local calendar day the report covers, `YYYY-MM-DD`. */
    date: string;
    /** IANA time zone the day boundaries were resolved in. */
    timezone: string;
    /** The zone's UTC offset at the start of the day, in minutes. */
    timezoneOffsetMinutes: number;
    /** When the Host produced this report, epoch milliseconds. */
    generatedAt: number;
    /** Wall-clock cost of producing the report. */
    durationMs: number;
    /**
     * In-window events whose payload could not be decoded. They are excluded
     * from every total, so a non-zero value marks the report as incomplete.
     */
    skippedEvents: number;
    /** Day-wide counters and token buckets. */
    totals: DayTotals;
    /** Per-route usage, descending by total tokens. */
    byModel: ModelUsage[];
    /** Per-session usage, descending by total tokens. */
    sessions: SessionUsage[];
    /** Token consumption rate. */
    rate: RateStats;
    /** Context-compaction activity. */
    compaction: CompactionStats;
    /** Subagent delegation summary. */
    subagents: SubagentStats;
}
/** Why the Host could not produce a report. */
export type DayReportErrorCode = 'bad-request' | 'no-database' | 'unsupported-schema' | 'unreadable';
/** The `/api/token-perf/day` response body. */
export type DayReportResponse = {
    ok: true;
    report: DayReport;
} | {
    ok: false;
    code: DayReportErrorCode;
    message: string;
};
