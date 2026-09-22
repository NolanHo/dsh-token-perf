import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
//#region src/aggregate/day.ts
const MILLISECONDS_PER_MINUTE$1 = 6e4;
const MILLISECONDS_PER_DAY = 864e5;
/**
* Read one zone's UTC offset at one instant.
*
* `longOffset` renders the zone's own rules at that instant (`GMT-07:00`), so
* the offset is never assumed — it follows the zone and its DST transitions.
* `UTC` and the zones that alias it render the bare `GMT`, which is offset zero.
* @param timeMs - epoch milliseconds.
* @param timeZone - IANA zone to read the offset in.
* @returns minutes east of UTC in force at that instant.
*/
function offsetMinutesAt(timeMs, timeZone) {
	const name = new Intl.DateTimeFormat("en-US", {
		timeZone,
		timeZoneName: "longOffset"
	}).formatToParts(new Date(timeMs)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
	const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
	if (match === null) return 0;
	return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}
/**
* Resolve one `YYYY-MM-DD` local day to its UTC instant range in a zone.
* @param date - local calendar day, `YYYY-MM-DD`.
* @param timeZone - IANA zone the day is interpreted in.
* @returns the half-open `[start, end)` range in epoch milliseconds.
*/
function localDayBounds(date, timeZone) {
	const [year, month, day] = date.split("-").map(Number);
	const utcMidnight = Date.UTC(year, month - 1, day);
	const nextUtcMidnight = utcMidnight + MILLISECONDS_PER_DAY;
	return {
		start: utcMidnight - offsetMinutesAt(utcMidnight, timeZone) * MILLISECONDS_PER_MINUTE$1,
		end: nextUtcMidnight - offsetMinutesAt(nextUtcMidnight, timeZone) * MILLISECONDS_PER_MINUTE$1
	};
}
/**
* Format one instant as the `YYYY-MM-DD` local day it falls in.
* @param timeMs - epoch milliseconds.
* @param timeZone - IANA zone the day is interpreted in.
* @returns the local calendar day.
*/
function localDayKey(timeMs, timeZone) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(new Date(timeMs));
	const partValue = (type) => parts.find((part) => part.type === type)?.value ?? "";
	return `${partValue("year").padStart(4, "0")}-${partValue("month")}-${partValue("day")}`;
}
/**
* Test whether a string is a well-formed local calendar day.
* @param value - candidate string.
* @returns true when the string is `YYYY-MM-DD` and a real date.
*/
function isLocalDayKey(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const probe = new Date(Date.UTC(year, month - 1, day));
	probe.setUTCFullYear(year);
	return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}
/**
* Resolve the Host process's IANA time zone.
* @returns the zone `Intl` reports for this process, or `UTC` when unreported.
*/
function resolveHostTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}
//#endregion
//#region src/aggregate/report.ts
/**
* The fold from one scanned day to the frozen wire report.
*
* This module is pure: it never opens the store and never reads the clock, so
* the whole report is reproducible from a fixture. Token accounting mirrors
* the harness's own `tokenUsage` projection: samples fold per
* `(session, turn, step)` with later samples replacing earlier ones, and a
* retry clears the slot so the retried attempt bills separately.
* @module dsh-token-perf/aggregate/report
*/
const USAGE_FIELDS = [
	["input", "inputTokens"],
	["output", "outputTokens"],
	["cacheRead", "cacheReadTokens"],
	["cacheWrite", "cacheWriteTokens"],
	["reasoning", "reasoningTokens"]
];
const BUCKET_KEYS = USAGE_FIELDS.map(([bucket]) => bucket);
/** Placeholder key for a count whose subject the store did not record. */
const UNKNOWN_KEY = "(unknown)";
const MILLISECONDS_PER_MINUTE = 6e4;
const HOURS_PER_DAY = 24;
/**
* Fold one day's scanned rows into the wire report.
* @param input - the scan and the report's identity fields.
* @returns the day report, sorted for presentation.
*/
function buildDayReport(input) {
	const { scan, date, timezone, generatedAt, durationMs } = input;
	const bounds = localDayBounds(date, timezone);
	const [year, month, dayOfMonth] = date.split("-").map(Number);
	const timezoneOffsetMinutes = (Date.UTC(year, month - 1, dayOfMonth) - bounds.start) / MILLISECONDS_PER_MINUTE;
	const folds = /* @__PURE__ */ new Map();
	for (const header of scan.sessions) folds.set(header.id, createFold(header.key, header));
	const totals = {
		...zeroBuckets(),
		sessionsOpened: 0,
		sessionsActive: 0,
		subagents: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		compactions: 0,
		llmCalls: 0
	};
	const routes = /* @__PURE__ */ new Map();
	const summarySlots = /* @__PURE__ */ new Map();
	const compactionBuckets = zeroBuckets();
	const minuteTokens = /* @__PURE__ */ new Map();
	const hourTokens = new Array(HOURS_PER_DAY).fill(0);
	const hourCalls = new Array(HOURS_PER_DAY).fill(0);
	let summaries = 0;
	let sessionsActive = 0;
	/**
	* Fold one usage-bearing settlement into the day.
	*
	* A later sample for the same key replaces the earlier one, so only the net
	* delta moves the totals, the route, and the rate. The session's own
	* replacement slot is the projection's: a retry clears it and the retried
	* attempt therefore bills its full usage.
	*/
	function applyUsageSample(fold, event, data) {
		const sample = usageSampleOf(event.type, data);
		if (sample === void 0) return;
		const buckets = bucketsOf(sample);
		if (buckets === void 0) return;
		const key = `${numberOf(data.turn)}:${numberOf(data.step)}`;
		const previous = fold.slots.get(key);
		const ownRoute = routeOf(data);
		const route = ownRoute ?? previous?.route;
		const row = route === void 0 ? void 0 : routeRow(route);
		let delta = 0;
		for (const bucket of BUCKET_KEYS) {
			const change = buckets[bucket] - (previous?.buckets[bucket] ?? 0);
			delta += change;
			totals[bucket] += change;
			fold.buckets[bucket] += change;
			if (row !== void 0) row[bucket] += change;
		}
		if (ownRoute !== void 0 && row !== void 0) {
			row.calls += 1;
			fold.models.add(`${ownRoute.provider}/${ownRoute.model}`);
		}
		fold.slots.set(key, {
			buckets,
			route
		});
		const minute = Math.floor(event.time / MILLISECONDS_PER_MINUTE);
		minuteTokens.set(minute, (minuteTokens.get(minute) ?? 0) + delta);
		const hour = localHourOf(event.time, timezone);
		hourTokens[hour] += delta;
		hourCalls[hour] += 1;
		totals.llmCalls += 1;
		fold.llmCalls += 1;
	}
	/**
	* Fold one compaction summary's metering event.
	*
	* Summary calls are billed work the main-loop fold never sees, so their
	* tokens stay out of the day's buckets and route table and are reported
	* under `compaction.summaryTokens` instead. The call itself still counts as
	* a metered model call for the day and its session.
	*/
	function applySummary(fold, event, data) {
		summaries += 1;
		const buckets = bucketsOf(data.usage);
		if (buckets === void 0) return;
		const key = typeof data.compactionId === "string" ? data.compactionId : `${event.sessionId}:${event.seq}`;
		const previous = summarySlots.get(key);
		for (const bucket of BUCKET_KEYS) compactionBuckets[bucket] += buckets[bucket] - (previous?.[bucket] ?? 0);
		summarySlots.set(key, buckets);
		totals.llmCalls += 1;
		fold.llmCalls += 1;
	}
	/** Resolve one route to its day row, creating it on first use. */
	function routeRow(route) {
		const key = `${route.provider}/${route.model}`;
		let row = routes.get(key);
		if (row === void 0) {
			row = {
				provider: route.provider,
				model: route.model,
				...zeroBuckets(),
				calls: 0
			};
			routes.set(key, row);
		}
		return row;
	}
	for (const event of scan.events) {
		let fold = folds.get(event.sessionId);
		if (fold === void 0) {
			fold = createFold(`#${event.sessionId}`, void 0, event.time);
			folds.set(event.sessionId, fold);
		}
		if (!fold.active) {
			fold.active = true;
			sessionsActive += 1;
		}
		if (event.time > fold.lastActivityAt) fold.lastActivityAt = event.time;
		const data = asRecord(event.data);
		switch (event.type) {
			case "user/message":
				fold.userMessages += 1;
				totals.userMessages += 1;
				break;
			case "assistant/message":
				fold.assistantMessages += 1;
				totals.assistantMessages += 1;
				if (data !== void 0) applyUsageSample(fold, event, data);
				break;
			case "assistant/attempt":
				if (data !== void 0) applyUsageSample(fold, event, data);
				break;
			case "tool/call":
				fold.toolCalls += 1;
				totals.toolCalls += 1;
				break;
			case "tool/result":
				fold.toolResults += 1;
				totals.toolResults += 1;
				break;
			case "compaction/start":
				fold.compactions += 1;
				totals.compactions += 1;
				break;
			case "compaction/summary":
				if (data !== void 0) applySummary(fold, event, data);
				break;
			case "llm/retry-started":
				fold.slots.delete(`${numberOf(data?.turn)}:${numberOf(data?.step)}`);
				break;
			case "session/title":
				if (typeof data?.title === "string" && data.title !== "") fold.title = data.title;
				break;
			case "subagent/descriptor": if (fold.subagentModel === void 0 && typeof data?.agentModel === "string" && data.agentModel !== "") fold.subagentModel = typeof data.agentProvider === "string" && data.agentProvider !== "" ? `${data.agentProvider}/${data.agentModel}` : data.agentModel;
		}
	}
	for (const header of scan.sessions) {
		if (header.createdAt < bounds.start || header.createdAt >= bounds.end) continue;
		totals.sessionsOpened += 1;
		if (header.parentKey !== null) totals.subagents += 1;
	}
	totals.sessionsActive = sessionsActive;
	const children = [];
	const childCountByParent = /* @__PURE__ */ new Map();
	for (const fold of folds.values()) {
		const header = fold.header;
		if (header === void 0 || header.parentKey === null) continue;
		if (header.createdAt < bounds.start || header.createdAt >= bounds.end) continue;
		children.push(fold);
		childCountByParent.set(header.parentKey, (childCountByParent.get(header.parentKey) ?? 0) + 1);
	}
	for (const fold of folds.values()) fold.subagents = childCountByParent.get(fold.id) ?? 0;
	const presetCounts = /* @__PURE__ */ new Map();
	const descriptorCounts = /* @__PURE__ */ new Map();
	for (const child of children) {
		const preset = child.header?.agentPreset ?? UNKNOWN_KEY;
		presetCounts.set(preset, (presetCounts.get(preset) ?? 0) + 1);
		const model = child.subagentModel ?? UNKNOWN_KEY;
		descriptorCounts.set(model, (descriptorCounts.get(model) ?? 0) + 1);
	}
	let maxPerSession = 0;
	for (const count of childCountByParent.values()) if (count > maxPerSession) maxPerSession = count;
	let peakPerMinute = 0;
	let activeMinutes = 0;
	let firstMinute = Number.POSITIVE_INFINITY;
	let lastMinute = Number.NEGATIVE_INFINITY;
	for (const [minute, tokens] of minuteTokens) {
		if (tokens > peakPerMinute) peakPerMinute = tokens;
		if (tokens > 0) activeMinutes += 1;
		if (minute < firstMinute) firstMinute = minute;
		if (minute > lastMinute) lastMinute = minute;
	}
	const rate = {
		buckets: Array.from({ length: HOURS_PER_DAY }, (_unused, hour) => ({
			hour,
			tokens: hourTokens[hour],
			calls: hourCalls[hour]
		})),
		peakPerMinute,
		avgPerActiveMinute: activeMinutes === 0 ? 0 : Math.round(totalOf(totals) / activeMinutes),
		activeMinutes,
		spanMinutes: minuteTokens.size === 0 ? 0 : lastMinute - firstMinute + 1
	};
	const sessions = [...folds.values()].map((fold) => ({
		id: fold.id,
		title: fold.title,
		parentId: fold.header?.parentKey ?? void 0,
		origin: fold.header?.parentKey == null ? "root" : "subagent",
		agentPreset: fold.header?.agentPreset ?? void 0,
		createdAt: fold.createdAt,
		lastActivityAt: fold.lastActivityAt,
		userMessages: fold.userMessages,
		assistantMessages: fold.assistantMessages,
		toolCalls: fold.toolCalls,
		toolResults: fold.toolResults,
		compactions: fold.compactions,
		llmCalls: fold.llmCalls,
		subagents: fold.subagents,
		models: [...fold.models].sort(compareKeys),
		...fold.buckets
	}));
	sessions.sort((left, right) => totalOf(right) - totalOf(left) || compareKeys(left.id, right.id));
	return {
		date,
		timezone,
		timezoneOffsetMinutes,
		generatedAt,
		durationMs,
		totals,
		byModel: [...routes.values()].sort((left, right) => totalOf(right) - totalOf(left) || compareKeys(routeKey(left), routeKey(right))),
		sessions,
		rate,
		compaction: {
			events: totals.compactions,
			summaries,
			summaryTokens: compactionBuckets
		},
		subagents: {
			total: children.length,
			spawningSessions: childCountByParent.size,
			maxPerSession,
			byPreset: [...presetCounts].map(([preset, count]) => ({
				preset,
				count
			})).sort((left, right) => right.count - left.count || compareKeys(left.preset, right.preset)),
			byModel: [...descriptorCounts].map(([model, count]) => ({
				model,
				count
			})).sort((left, right) => right.count - left.count || compareKeys(left.model, right.model))
		}
	};
}
/**
* Start one session's fold.
* @param id - logical session key, or the `#id` fallback for a header-less session.
* @param header - the header, absent when the store has none.
* @param fallbackTime - first in-window event time, `createdAt`'s stand-in without a header.
* @returns the empty fold.
*/
function createFold(id, header, fallbackTime = 0) {
	const createdAt = header?.createdAt ?? fallbackTime;
	return {
		id,
		header,
		buckets: zeroBuckets(),
		createdAt,
		lastActivityAt: createdAt,
		title: void 0,
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		compactions: 0,
		llmCalls: 0,
		models: /* @__PURE__ */ new Set(),
		slots: /* @__PURE__ */ new Map(),
		subagentModel: void 0,
		subagents: 0,
		active: false
	};
}
/** @returns a fresh all-zero bucket set. */
function zeroBuckets() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0
	};
}
/** @returns the five buckets summed, the report's token total. */
function totalOf(buckets) {
	return BUCKET_KEYS.reduce((sum, key) => sum + buckets[key], 0);
}
/** @returns the `provider/model` key one route is grouped under. */
function routeKey(row) {
	return `${row.provider}/${row.model}`;
}
/** @returns an ascending string comparison, the stable tie-break of every ranking. */
function compareKeys(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
/** @returns the value as a JSON object, or undefined for anything else. */
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** @returns the value as a finite number, or 0 when the payload omits it. */
function numberOf(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
/**
* Read one provider usage record into the report's buckets.
* @param value - the payload's usage field, absent when the provider reported none.
* @returns the buckets, or undefined when the field is not a usage record.
*/
function bucketsOf(value) {
	const record = asRecord(value);
	if (record === void 0) return void 0;
	const buckets = zeroBuckets();
	for (const [bucket, field] of USAGE_FIELDS) {
		const amount = record[field];
		if (typeof amount === "number" && Number.isFinite(amount)) buckets[bucket] = amount;
	}
	return buckets;
}
/**
* Resolve the usage one settlement reports, mirroring the harness's `usageOf`:
* an assembled message's own usage, otherwise the last usage chunk of its stream.
* @param type - event type discriminant.
* @param data - the event payload.
* @returns the usage record, or undefined when the settlement reported none.
*/
function usageSampleOf(type, data) {
	if (type === "assistant/message" && data.usage !== void 0) return data.usage;
	if (type !== "assistant/message" && type !== "assistant/attempt") return void 0;
	return lastStreamUsage(data.stream);
}
/**
* Read the last `usage` chunk of a settlement's stream.
* @param stream - the payload's stream records, absent on unexpected payloads.
* @returns the chunk's usage, or undefined when the stream carries none.
*/
function lastStreamUsage(stream) {
	if (!Array.isArray(stream)) return void 0;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = asRecord(stream[index]);
		if (record?.type !== "chunk") continue;
		const chunk = asRecord(record.chunk);
		if (chunk?.type === "usage") return chunk.usage;
	}
}
/**
* Read the model route an assistant message was billed to.
* @param data - the event payload.
* @returns the route, or undefined for settlements that carry none.
*/
function routeOf(data) {
	const source = asRecord(asRecord(data.message)?.source);
	const provider = source?.provider;
	const model = source?.model;
	if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") return void 0;
	return {
		provider,
		model
	};
}
/** One formatter per zone: constructing one costs more than the fold it serves. */
const HOUR_FORMATTERS = /* @__PURE__ */ new Map();
/**
* Resolve an instant's local hour of day.
* @param timeMs - epoch milliseconds.
* @param timeZone - IANA zone the report's day is resolved in.
* @returns the hour, 0 through 23, in that zone at that instant.
*/
function localHourOf(timeMs, timeZone) {
	let formatter = HOUR_FORMATTERS.get(timeZone);
	if (formatter === void 0) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hour: "2-digit",
			hourCycle: "h23"
		});
		HOUR_FORMATTERS.set(timeZone, formatter);
	}
	return Number(formatter.formatToParts(new Date(timeMs)).find((part) => part.type === "hour")?.value ?? "0");
}
//#endregion
//#region src/config.ts
/**
* The Host half's configuration surface.
*
* A cordis composition declares these fields under the `dsh-token-perf` entry;
* Schemastery fills the three that have a host-derived default, so the plugin's
* `apply` always receives every field resolved.
* @module dsh-token-perf/config
*/
/** Default cache lifetime: long enough to absorb a panel's refresh burst, short enough to stay live. */
const DEFAULT_CACHE_TTL_MS = 3e4;
/**
* The dictionary shipped beside the built entry: `pnpm build` copies
* `src/store/zstd-dictionary.bin` next to `lib/index.js`, so the bundle's own
* URL is the only path that survives packaging. The service falls back to it
* when called with a configuration that skipped schema resolution.
*/
const DEFAULT_DICTIONARY_PATH = fileURLToPath(new URL("./zstd-dictionary.bin", import.meta.url));
/** The configuration schema a cordis composition validates this plugin's entry against. */
const Config = z.object({
	databasePath: z.string(),
	dictionaryPath: z.string().default(DEFAULT_DICTIONARY_PATH),
	timeZone: z.string().default(resolveHostTimeZone()),
	cacheTtlMs: z.number().min(0).default(DEFAULT_CACHE_TTL_MS)
});
//#endregion
//#region src/store/decode.ts
/**
* Decoding of the session store's `events.data` column.
*
* The SQLite persistence backend stores each event payload as JSON text, or as
* a zstd frame compressed against a schema-pinned dictionary, or as a packed
* physical row holding several logical chunk events. This module owns both
* facts the row reader must apply: which rows are packed, and how a data value
* becomes JSON text.
* @module dsh-token-perf/store/decode
*/
/** `ignorable` value marking one packed chunk row; scalars carry 0/1 or NULL. */
const PACKED_ROW_SENTINEL = 0;
/** Event types a packed row may carry; any other type is a malformed row. */
const CHUNK_TAGS = [
	"text-chunks",
	"reasoning-chunks",
	"tool-call-chunks"
];
/**
* Build a decoder bound to one zstd dictionary.
*
* The dictionary is read once per store scan and reused for every row: it is
* the physical-format key, so a store written with a different dictionary
* fails to decompress rather than decoding to wrong text.
* @param dictionaryPath - absolute path of the schema's zstd dictionary.
* @returns a decoder returning JSON text, unchanged for rows stored uncompressed.
*/
function createDataDecoder(dictionaryPath) {
	const dictionary = readFileSync(dictionaryPath);
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	return (value) => typeof value === "string" ? value : utf8.decode(zstdDecompressSync(value, { dictionary }));
}
/**
* Test whether one `events` row is a packed chunk row.
*
* The `ignorable` column doubles as the physical-format discriminator: only a
* packed row carries the sentinel, and only chunk types may be packed, so a
* sentinel on any other type means the store is not the schema this reader
* understands.
* @param ignorable - the row's `ignorable` column, `null` when stored NULL.
* @param type - the row's `type` column.
* @returns true when the row is a packed chunk row the day report must skip.
* @throws {Error} when the packed sentinel carries a non-chunk type.
*/
function isPackedChunkRow(ignorable, type) {
	if (ignorable !== PACKED_ROW_SENTINEL) return false;
	if (!CHUNK_TAGS.includes(type)) throw new Error(`malformed ${type} storage row: packed discriminator requires a chunk tag`);
	return true;
}
//#endregion
//#region src/store/day-scan.ts
/**
* The read-only scan of one local day out of the session store.
*
* The store is the SQLite persistence backend's file: `events` carries every
* logical session event, `sessions` carries the header each event belongs to.
* `events.time` has no index, so callers get one pass over the whole table
* windowed by time, and every metric is derived from that single result.
* @module dsh-token-perf/store/day-scan
*/
/** A scan failure the Host reports as a structured response. */
var ScanError = class extends Error {
	/** Machine-readable failure class. */
	code;
	/**
	* @param code - machine-readable failure class.
	* @param message - operator-facing explanation.
	* @param options - standard error options, typically the original failure as `cause`.
	*/
	constructor(code, message, options) {
		super(message, options);
		this.name = "ScanError";
		this.code = code;
	}
};
/** The physical format this reader understands; a store at any other version needs its own reader. */
const SCHEMA_VERSION = 20;
/** Columns the reader needs; a store missing one is not this schema. */
const REQUIRED_COLUMNS = [["sessions", [
	"id",
	"session_key",
	"version",
	"created_at",
	"cwd",
	"parent_session",
	"seed_length",
	"origin",
	"delegation_depth",
	"agent_preset",
	"incarnation",
	"revision"
]], ["events", [
	"session_id",
	"seq",
	"type",
	"time",
	"data",
	"source_event_seqs",
	"surface_op",
	"ignorable"
]]];
/**
* Bounded `IN (…)` size for header loading. One day of events can name more
* sessions than a single statement may bind, and SQLite's parameter ceiling
* (32766) is far above any batch that matters here.
*/
const HEADER_ID_BATCH = 500;
/**
* Read one local day of session activity from the store.
* @param options - store location and the day's half-open instant window.
* @returns the day's headers and events.
* @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
*/
async function scanDay(options) {
	const { databasePath, dictionaryPath, start, end } = options;
	if (!existsSync(databasePath)) throw new ScanError("no-database", `session store not found: ${databasePath}`);
	let store;
	try {
		store = new DatabaseSync(databasePath, { readOnly: true });
		assertSupportedSchema(store, databasePath);
		const decodeData = createDataDecoder(dictionaryPath);
		const events = [];
		const scannedSessionIds = /* @__PURE__ */ new Set();
		const rows = store.prepare(`SELECT session_id, seq, type, time, data, ignorable FROM events
        WHERE time >= ? AND time < ?
        ORDER BY session_id, seq`).iterate(start, end);
		for (const row of rows) {
			if (isPackedChunkRow(row.ignorable, row.type)) continue;
			scannedSessionIds.add(row.session_id);
			events.push({
				sessionId: row.session_id,
				seq: row.seq,
				type: row.type,
				time: row.time,
				data: JSON.parse(decodeData(row.data))
			});
		}
		return {
			sessions: loadHeaders(store, start, end, scannedSessionIds),
			events,
			scannedAt: Date.now()
		};
	} catch (error) {
		if (error instanceof ScanError) throw error;
		throw new ScanError("unreadable", `cannot read session store ${databasePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	} finally {
		store?.close();
	}
}
/**
* Reject a store whose physical format this reader cannot decode.
*
* The guard runs before any row is read: a schema bump can repack `data` or
* reinterpret `ignorable`, and decoding such a store would report wrong
* numbers instead of failing.
* @param store - the open store handle.
* @param databasePath - path named in the failure message.
* @throws {ScanError} with code `unsupported-schema` naming the actual version or missing columns.
*/
function assertSupportedSchema(store, databasePath) {
	const version = store.prepare("PRAGMA user_version").get()?.user_version;
	if (version !== SCHEMA_VERSION) throw new ScanError("unsupported-schema", `session store ${databasePath} reports schema version ${String(version)}, expected ${SCHEMA_VERSION}`);
	for (const [table, columns] of REQUIRED_COLUMNS) {
		const present = new Set(store.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
		const missing = columns.filter((column) => !present.has(column));
		if (missing.length !== 0) throw new ScanError("unsupported-schema", `session store ${databasePath} has no ${table}.${missing.join(`, ${table}.`)}`);
	}
}
/**
* Load every header the day's report can need: the sessions created inside the
* window join the sessions that own an in-window event.
* @param store - the open store handle.
* @param start - inclusive window start, epoch milliseconds.
* @param end - exclusive window end, epoch milliseconds.
* @param scannedSessionIds - ids of the sessions that own an in-window event.
* @returns headers ascending by store id.
*/
function loadHeaders(store, start, end, scannedSessionIds) {
	const columns = "id, session_key, parent_session, origin, agent_preset, created_at";
	const headers = /* @__PURE__ */ new Map();
	const created = store.prepare(`SELECT ${columns} FROM sessions WHERE created_at >= ? AND created_at < ?`).all(start, end);
	for (const row of created) headers.set(row.id, headerOf(row));
	const eventOwners = [...scannedSessionIds].filter((id) => !headers.has(id)).sort((left, right) => left - right);
	for (let offset = 0; offset < eventOwners.length; offset += HEADER_ID_BATCH) {
		const batch = eventOwners.slice(offset, offset + HEADER_ID_BATCH);
		const placeholders = batch.map(() => "?").join(", ");
		const rows = store.prepare(`SELECT ${columns} FROM sessions WHERE id IN (${placeholders})`).all(...batch);
		for (const row of rows) headers.set(row.id, headerOf(row));
	}
	return [...headers.values()].sort((left, right) => left.id - right.id);
}
/**
* Project one store row onto the scan's header record.
* @param row - the `sessions` row as stored.
* @returns the header without the columns the scan does not use.
*/
function headerOf(row) {
	return {
		id: row.id,
		key: row.session_key,
		parentKey: row.parent_session,
		origin: row.origin,
		agentPreset: row.agent_preset,
		createdAt: row.created_at
	};
}
//#endregion
//#region src/store/day-service.ts
/**
* The Host's day-report assembly: window resolution, scan, fold, and cache.
*
* One report is expensive — the store has no index on `events.time`, so a day
* costs a full-table pass — while the settings panel re-requests it on every
* open. The cache therefore keeps one report per store and day: a past day's
* report can never change and is kept for the process's life, today's is
* re-scanned once its lifetime expires, and a lifetime of zero disables
* retention entirely. Concurrent requests for one key await the same scan, and
* a failed scan is never retained.
* @module dsh-token-perf/store/day-service
*/
/**
* Resolve which SQLite session store one report reads.
*
* The configured path wins; otherwise the deployment's `DSH_HOME` and finally
* the default profile location. An unset or empty value at either step falls
* through, because an empty `DSH_HOME` names no store.
* @param config - resolved host configuration.
* @returns absolute path of the session store to read.
*/
function resolveDatabasePath(config) {
	const configured = config.databasePath;
	if (configured !== void 0 && configured !== "") return configured;
	const home = process.env.DSH_HOME;
	if (home !== void 0 && home !== "") return join(home, "sessions.sqlite");
	return join(homedir(), ".dsh", "sessions.sqlite");
}
const cache = /* @__PURE__ */ new Map();
const inFlight = /* @__PURE__ */ new Map();
/**
* Produce one local day's report, serviceable from the cache when possible.
* @param date - `YYYY-MM-DD` local day, or undefined for the host's own today.
* @param config - resolved host configuration.
* @returns the wire envelope; domain failures arrive as `ok: false` rather than a rejection.
*/
function getDayReport(date, config) {
	const timezone = config.timeZone ?? resolveHostTimeZone();
	const now = Date.now();
	const day = date ?? localDayKey(now, timezone);
	if (!isLocalDayKey(day)) return Promise.resolve(deepFreeze({
		ok: false,
		code: "bad-request",
		message: `invalid date ${JSON.stringify(day)}: expected a real YYYY-MM-DD local day`
	}));
	const databasePath = resolveDatabasePath(config);
	const dictionaryPath = config.dictionaryPath ?? DEFAULT_DICTIONARY_PATH;
	const ttl = config.cacheTtlMs;
	const key = [
		day,
		databasePath,
		dictionaryPath,
		timezone
	].join("\0");
	const cached = ttl > 0 ? cache.get(key) : void 0;
	if (cached !== void 0) {
		if (cached.expiresAt > now) return Promise.resolve(cached.response);
		cache.delete(key);
	}
	const pending = inFlight.get(key);
	if (pending !== void 0) return pending;
	let promise;
	promise = produceReport(day, timezone, databasePath, dictionaryPath, now).then((response) => {
		if (inFlight.get(key) === promise) {
			inFlight.delete(key);
			if (ttl > 0 && response.ok) {
				const expiresAt = day < localDayKey(Date.now(), timezone) ? Number.POSITIVE_INFINITY : Date.now() + ttl;
				cache.set(key, {
					response,
					expiresAt
				});
			}
		}
		return response;
	});
	inFlight.set(key, promise);
	return promise;
}
/**
* Scan and fold one day, translating every failure into the wire envelope.
* @param day - `YYYY-MM-DD` local day.
* @param timezone - IANA zone the day's window is taken in.
* @param databasePath - session store to read.
* @param dictionaryPath - zstd dictionary the store's payloads were compressed with.
* @param startedAt - instant the report's production began, epoch milliseconds.
* @returns the frozen wire envelope.
*/
async function produceReport(day, timezone, databasePath, dictionaryPath, startedAt) {
	try {
		const { start, end } = localDayBounds(day, timezone);
		return deepFreeze({
			ok: true,
			report: buildDayReport({
				scan: await scanDay({
					databasePath,
					dictionaryPath,
					start,
					end
				}),
				date: day,
				timezone,
				generatedAt: startedAt,
				durationMs: Date.now() - startedAt
			})
		});
	} catch (error) {
		return deepFreeze({
			ok: false,
			code: error instanceof ScanError ? error.code : "unreadable",
			message: error instanceof Error ? error.message : String(error)
		});
	}
}
/**
* Freeze a response through every nested object, so a holder of one cached
* report cannot edit what the next caller receives.
* @param value - value to freeze in place.
* @returns the same value, frozen.
*/
function deepFreeze(value) {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}
//#endregion
//#region src/index.ts
/** Cordis function-plugin name. */
const name = "dsh-token-perf";
/** The one prefix this plugin claims; `/day` is its only subpath. */
const ROUTE_PREFIX = "/api/token-perf";
/** The report subpath, complete path included. */
const DAY_ROUTE = `${ROUTE_PREFIX}/day`;
/** Reports are per-request live data; no intermediary may store one. */
const NO_STORE = "no-store";
/**
* Register the day-report route on the composition's webserver.
*
* The route is registered only once `webServer` is available, so the plugin
* loads unchanged in compositions without one, and registration is an effect
* that unregisters on disposal.
* @param ctx - the plugin's cordis context.
* @param config - resolved `dsh-token-perf` configuration.
*/
function apply(ctx, config) {
	ctx.inject(["webServer"], (scope) => {
		scope.effect(() => scope.webServer.register({
			kind: "prefix",
			path: ROUTE_PREFIX,
			handler: createHandler(config)
		}), `dsh-token-perf: ${DAY_ROUTE}`);
	});
}
/**
* Build the route handler for one resolved configuration.
* @param config - resolved `dsh-token-perf` configuration.
* @returns the handler owning the whole response lifecycle.
*/
function createHandler(config) {
	return async (req, res) => {
		try {
			await respond(req, res, config);
		} catch {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			res.statusCode = 500;
			res.setHeader("cache-control", NO_STORE);
			res.end();
		}
	};
}
/**
* Answer one request on the claimed prefix.
* @param req - the incoming request.
* @param res - the response this function finishes.
* @param config - resolved `dsh-token-perf` configuration.
*/
async function respond(req, res, config) {
	if (!isLoopbackPeer(req.socket?.remoteAddress)) {
		sendStatus(res, 403);
		return;
	}
	if (req.method !== "GET") {
		res.setHeader("allow", "GET");
		sendStatus(res, 405);
		return;
	}
	const url = new URL(String(req.url ?? "/"), "http://localhost");
	if (url.pathname !== DAY_ROUTE) {
		sendStatus(res, 404);
		return;
	}
	sendJson(res, 200, await getDayReport(url.searchParams.get("date") ?? void 0, config));
}
/**
* Whether a TCP peer address names this machine.
*
* Node reports an IPv4 peer as `a.b.c.d`, an IPv6 one as its literal form, and
* an IPv4 peer on a dual-stack listener as `::ffff:a.b.c.d` — in either the
* dotted or the two-hex-group spelling.
* @param address - `req.socket.remoteAddress`, absent on a tunnel with no socket.
* @returns true for `127.0.0.0/8` and `::1` only.
*/
function isLoopbackPeer(address) {
	if (address === void 0) return false;
	const literal = address.toLowerCase();
	if (literal === "::1") return true;
	const mapped = /^::ffff:(.+)$/.exec(literal)?.[1] ?? literal;
	if (/^127(?:\.\d{1,3}){3}$/.test(mapped)) return true;
	const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
	return groups !== null && Number.parseInt(groups[1], 16) >>> 8 === 127;
}
/**
* Finish a response that carries no body.
* @param res - the response to finish.
* @param status - HTTP status to send.
*/
function sendStatus(res, status) {
	res.statusCode = status;
	res.setHeader("cache-control", NO_STORE);
	res.end();
}
/**
* Finish a response with one JSON body.
* @param res - the response to finish.
* @param status - HTTP status to send.
* @param body - JSON-serializable body.
*/
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("cache-control", NO_STORE);
	res.end(payload);
}
//#endregion
export { Config, apply, name };

//# sourceMappingURL=index.js.map