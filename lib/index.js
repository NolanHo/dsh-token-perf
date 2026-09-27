import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
//#region src/aggregate/day.ts
/**
* Half-width of the instant window searched for a local day's first moment.
* A zone's local midnight sits at most ~14h from UTC midnight (Kiribati), and
* a transition can shift it by another hour, so 36h brackets every zone.
*/
const DAY_BOUND_SEARCH_MS = 1296e5;
/** One formatter per zone: constructing it is the expensive part of a probe. */
const formatters = /* @__PURE__ */ new Map();
/**
* The formatter that renders one instant's local calendar day.
* @param timeZone - IANA zone to render in.
* @returns a cached formatter for that zone.
*/
function formatterFor(timeZone) {
	let formatter = formatters.get(timeZone);
	if (formatter === void 0) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit"
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
}
/**
* Render one instant's local calendar day with an existing formatter.
* @param formatter - the zone's cached formatter.
* @param timeMs - epoch milliseconds.
* @returns the local calendar day, `YYYY-MM-DD`.
*/
function dayKeyWith(formatter, timeMs) {
	const parts = formatter.formatToParts(new Date(timeMs));
	const partValue = (type) => parts.find((part) => part.type === type)?.value ?? "";
	return `${partValue("year").padStart(4, "0")}-${partValue("month")}-${partValue("day")}`;
}
/**
* The UTC instant of one calendar date's midnight, with the literal year restored.
* `Date.UTC` maps years 0-99 onto 1900-1999, so the year is written back for
* the range `isLocalDayKey` accepts.
* @param date - local calendar day, `YYYY-MM-DD`.
* @returns epoch milliseconds of that date's UTC midnight.
*/
function utcMidnightOf(date) {
	const [year, month, day] = date.split("-").map(Number);
	const midnight = new Date(Date.UTC(year, month - 1, day));
	if (year >= 0 && year <= 99) midnight.setUTCFullYear(year, month - 1, day);
	return midnight.getTime();
}
/**
* The first instant whose local day is `date` or later.
*
* `localDayKey` is non-decreasing in time, so bisection finds the boundary
* exactly. Deriving it from the offset at UTC midnight instead returns the
* neighbouring day whenever a zone's offset changes at or across local
* midnight — Australia/Lord_Howe, America/Santiago, Pacific/Chatham and
* Africa/Cairo all take their transition there.
* @param date - local calendar day, `YYYY-MM-DD`.
* @param timeZone - IANA zone the day is interpreted in.
* @returns the boundary instant in epoch milliseconds.
*/
function firstInstantOfDayOrLater(date, timeZone) {
	const utcMidnight = utcMidnightOf(date);
	const formatter = formatterFor(timeZone);
	let low = utcMidnight - DAY_BOUND_SEARCH_MS;
	let high = utcMidnight + DAY_BOUND_SEARCH_MS;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (dayKeyWith(formatter, middle) >= date) high = middle;
		else low = middle + 1;
	}
	return low;
}
/**
* The calendar day after one local day.
* @param date - local calendar day, `YYYY-MM-DD`.
* @returns the following day, `YYYY-MM-DD`.
*/
function nextDayKey(date) {
	const [year, month, day] = date.split("-").map(Number);
	const next = new Date(Date.UTC(year, month - 1, day + 1));
	if (year >= 0 && year <= 99) next.setUTCFullYear(year, month - 1, day + 1);
	const part = (value, width) => String(value).padStart(width, "0");
	return `${part(next.getUTCFullYear(), 4)}-${part(next.getUTCMonth() + 1, 2)}-${part(next.getUTCDate(), 2)}`;
}
/**
* Resolve one `YYYY-MM-DD` local day to its UTC instant range in a zone.
*
* The range is the exact set of instants whose local calendar day is `date`,
* so a day whose zone shifts by 30 minutes, or whose transition lands on local
* midnight, is measured at its true length rather than at an assumed 23-25h.
* A day a zone skips entirely resolves to an empty range.
* @param date - local calendar day, `YYYY-MM-DD`.
* @param timeZone - IANA zone the day is interpreted in.
* @returns the half-open `[start, end)` range in epoch milliseconds.
*/
function localDayBounds(date, timeZone) {
	return {
		start: firstInstantOfDayOrLater(date, timeZone),
		end: firstInstantOfDayOrLater(nextDayKey(date), timeZone)
	};
}
/**
* Format one instant as the `YYYY-MM-DD` local day it falls in.
* @param timeMs - epoch milliseconds.
* @param timeZone - IANA zone the day is interpreted in.
* @returns the local calendar day.
*/
function localDayKey(timeMs, timeZone) {
	return dayKeyWith(formatterFor(timeZone), timeMs);
}
/**
* Test whether a string is a well-formed local calendar day.
* @param value - candidate string.
* @returns true when the string is `YYYY-MM-DD` for a real date between
* `0001-01-01` and `9998-12-31` inclusive.
*/
function isLocalDayKey(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	if (year < 1 || year > 9998) return false;
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
*
* The same pass also folds the day's de-replicated work signal: it counts rows,
* sums settled output and cache-read tokens, and keeps a rolling digest of each
* session's `(type, time)` sequence so a session whose log repeats another's is
* excluded from the signal. {@link scanWorkDay} runs that fold alone for one
* day, and {@link scanWorkDays} runs it for several consecutive local days in
* one pass — the trailing trend's shape, where a per-day scan would cost a
* whole-table pass per day because `events.time` is unindexed.
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
/**
* Rows the iterator may step before yielding to the event loop. A full-store
* window is 10^6 rows, so the batch is a responsiveness knob: ~2ms of work per
* yield at the measured decode rate, and a negligible fraction of the total.
* Packed rows count toward the batch like any other row, so a window that is
* mostly packed chunk rows still yields.
*/
const YIELD_EVERY_ROWS = 256;
/** Hand the event loop one turn, so a long synchronous scan cannot starve it. */
async function yieldToLoop() {
	await new Promise((resolve) => {
		setImmediate(resolve);
	});
}
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
* @returns the day's headers, events, and de-replicated work signal.
* @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
*/
async function scanDay(options) {
	return withStore(options, async (store, decodeData) => {
		const pass = await runWindowPass(store, decodeData, options.start, options.end, [singleBucket(options)], true);
		await yieldToLoop();
		return {
			sessions: loadHeaders(store, options.start, options.end, pass.scannedSessionIds),
			events: pass.events,
			skippedEvents: pass.skippedEvents,
			work: pass.work[0],
			scannedAt: Date.now()
		};
	});
}
/**
* Read several consecutive local days' de-replicated work signals in one pass.
*
* `events.time` has no index, so a windowed read is a whole-table pass whatever
* its width: the trailing trend's six earlier days cost one pass here instead
* of six. The fold keeps one accumulation per `(session, local day)` bucket, so
* each bucket's row count, first event time, token slot, and rolling digest are
* exactly what {@link scanWorkDay} would report for that day alone; the digest
* never spans the window, because a session that replays another's day is only
* a replica of the work that day actually repeated.
* @param options - store location, the half-open instant window, and the zone its local days are resolved in.
* @returns one work row per local day the window covers, oldest first, empty days included.
* @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
*/
async function scanWorkDays(options) {
	return withStore(options, async (store, decodeData) => {
		const days = localDaysIn(options.start, options.end, options.timeZone);
		const pass = await runWindowPass(store, decodeData, options.start, options.end, days, false);
		return days.map((day, index) => ({
			date: day.date,
			...pass.work[index]
		}));
	});
}
/**
* @param options - a single-day window.
* @returns that window as the one bucket a day scan folds into.
*/
function singleBucket(options) {
	return {
		start: options.start,
		end: options.end
	};
}
/**
* Enumerate the local days one instant window covers.
*
* A day is covered when its own range holds an instant of the window, so a
* window that starts or ends mid-day reports that day from the covered part
* alone. Every returned day owns at least one instant: a date a zone skips
* entirely (Pacific/Apia skipped 2011-12-30) owns none and is left out.
* @param start - inclusive window start, epoch milliseconds.
* @param end - exclusive window end, epoch milliseconds.
* @param timeZone - IANA zone the day boundaries are resolved in.
* @returns the covered days, oldest first, with their windows.
*/
function localDaysIn(start, end, timeZone) {
	const days = [];
	let date = localDayKey(start, timeZone);
	for (;;) {
		const bounds = localDayBounds(date, timeZone);
		if (bounds.start >= end) break;
		if (bounds.end > bounds.start) days.push({
			date,
			...bounds
		});
		date = localDayKey(bounds.end, timeZone);
	}
	return days;
}
/**
* Open the store, prove its schema, run one reader, and close it again.
*
* The schema guard runs before any row is read: a schema bump can repack `data`
* or reinterpret `ignorable`, and decoding such a store would report wrong
* numbers instead of failing. Every reader failure arrives as `unreadable`,
* except the `ScanError`s the guard and the row reader raise themselves.
* @param options - store location, read by every caller the same way.
* @param read - the reader to run against the open handle.
* @returns whatever the reader returned.
* @throws {ScanError} when the store is missing, unreadable, or of an unsupported schema.
*/
async function withStore(options, read) {
	const { databasePath, dictionaryPath } = options;
	if (!existsSync(databasePath)) throw new ScanError("no-database", `session store not found: ${databasePath}`);
	let store;
	try {
		store = new DatabaseSync(databasePath, { readOnly: true });
		assertSupportedSchema(store, databasePath);
		return await read(store, createDataDecoder(dictionaryPath));
	} catch (error) {
		if (error instanceof ScanError) throw error;
		throw new ScanError("unreadable", `cannot read session store ${databasePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	} finally {
		store?.close();
	}
}
/** Event types a work-only pass must decode; every other row is counted but never parsed. */
const WORK_EVENT_TYPES = /* @__PURE__ */ new Set([
	"assistant/message",
	"assistant/attempt",
	"llm/retry-started"
]);
/**
* Run the one ordered pass over a window's rows.
*
* Rows arrive ordered by `(session_id, seq)`, so one session's rows are
* contiguous and its accumulations can be built as they stream: the rolling
* digest is what identifies a session whose log repeats another's, without ever
* holding the table in memory.
*
* The fold keeps one accumulation per `(session, bucket)`, so folding several
* local days in one pass reports what a pass per day would: each bucket's row
* count, first event time, token slot, and digest chain begin and end at that
* day's own rows. A session copied from another is only a replica inside a day
* whose work it repeated, which is why the digest never spans the window.
* @param store - the open store handle.
* @param decodeData - decoder for the store's `data` column.
* @param start - inclusive window start, epoch milliseconds.
* @param end - exclusive window end, epoch milliseconds.
* @param buckets - the local days the window folds into, oldest first and covering it.
* @param keepEvents - whether to decode and retain every row's payload.
* @returns the pass's events (when kept), header ids, skip count, and work signals.
* @throws {ScanError} never; malformed rows surface to {@link withStore} as `unreadable`.
*/
async function runWindowPass(store, decodeData, start, end, buckets, keepEvents) {
	const events = [];
	const scannedSessionIds = /* @__PURE__ */ new Set();
	const sessions = /* @__PURE__ */ new Map();
	const bucketStarts = buckets.map((bucket) => bucket.start);
	let skippedEvents = 0;
	let previousId = -1;
	let current = [];
	const rows = store.prepare(`SELECT session_id, seq, type, time, data, ignorable FROM events
      WHERE time >= ? AND time < ?
      ORDER BY session_id, seq`).iterate(start, end);
	let sinceYield = 0;
	for (const row of rows) {
		if (row.session_id !== previousId) {
			if (previousId !== -1) sealChains(current);
			previousId = row.session_id;
			current = new Array(buckets.length);
			sessions.set(row.session_id, current);
		}
		const session = bucketWork(current, bucketIndexOf(bucketStarts, row.time), row.time);
		session.rows += 1;
		if (row.time < session.firstTime) session.firstTime = row.time;
		const chain = session.chain ??= [];
		session.digest = rollDigest(session.digest, digestOfType(row.type), row.time);
		chain.push(session.digest);
		if (!isPackedChunkRow(row.ignorable, row.type)) {
			if (keepEvents) scannedSessionIds.add(row.session_id);
			if (keepEvents || WORK_EVENT_TYPES.has(row.type)) {
				let data;
				try {
					data = JSON.parse(decodeData(row.data));
				} catch {
					skippedEvents += 1;
					data = void 0;
				}
				if (data !== void 0) {
					if (keepEvents) events.push({
						sessionId: row.session_id,
						seq: row.seq,
						type: row.type,
						time: row.time,
						data
					});
					const record = asRecord$1(data);
					if (record !== void 0) foldWorkEvent(session, row.type, record);
				}
			}
		}
		if (++sinceYield >= YIELD_EVERY_ROWS) {
			sinceYield = 0;
			await yieldToLoop();
		}
	}
	if (previousId !== -1) sealChains(current);
	return {
		events,
		scannedSessionIds,
		skippedEvents,
		work: workPerBucket(sessions, buckets.length)
	};
}
/**
* @param buckets - one session's per-bucket slots.
* @param index - the bucket the row belongs to.
* @param firstTime - the row's time, the bucket's first event time while it is new.
* @returns that bucket's accumulation, created by the row that first reaches it.
*/
function bucketWork(buckets, index, firstTime) {
	const existing = buckets[index];
	if (existing !== void 0) return existing;
	const created = emptySessionWork(firstTime);
	buckets[index] = created;
	return created;
}
/**
* Resolve the bucket one in-window row belongs to.
*
* The buckets are consecutive local days covering the window, so a row always
* falls in one of them. Walking back from the last start finds it without
* formatting the row's own day key, which a per-row calendar lookup would pay a
* zone conversion for.
* @param starts - ascending first instants of the pass's buckets.
* @param time - the row's event time, epoch milliseconds.
* @returns the bucket's index.
*/
function bucketIndexOf(starts, time) {
	for (let index = starts.length - 1; index > 0; index -= 1) if (time >= starts[index]) return index;
	return 0;
}
/**
* Drop the digest chain of every bucket too small to be a replica candidate.
*
* A chain is one number per row, so keeping it for a bucket that can never
* match another would make the pass's memory proportional to the window rather
* than to its candidate buckets.
* @param buckets - one session's per-bucket slots.
*/
function sealChains(buckets) {
	for (const session of buckets) if (session !== void 0 && session.rows < MIN_REPLICA_CANDIDATE_ROWS) session.chain = void 0;
}
/**
* Split the pass's accumulations into one work signal per bucket.
* @param sessions - every session the pass touched, with its per-bucket slots.
* @param count - number of buckets the pass folded.
* @returns the de-replicated work signal per bucket, in bucket order.
*/
function workPerBucket(sessions, count) {
	const work = [];
	for (let index = 0; index < count; index += 1) {
		const day = /* @__PURE__ */ new Map();
		for (const [id, buckets] of sessions) {
			const session = buckets[index];
			if (session !== void 0) day.set(id, session);
		}
		work.push(workOf(day));
	}
	return work;
}
/**
* Minimum rows in one bucket before a session is a prefix-replica candidate
* there, the threshold `usage-queries.mjs` established: a short log repeats by
* accident, a long one does not.
*/
const MIN_REPLICA_CANDIDATE_ROWS = 50;
/** Share of two candidates' rolling digests that must agree before one is a replica, as in the reference script. */
const REPLICA_AGREEMENT = .99;
/**
* @param firstTime - first event time of the bucket about to be read.
* @returns an empty accumulation for that bucket.
*/
function emptySessionWork(firstTime) {
	return {
		rows: 0,
		firstTime,
		output: 0,
		cacheRead: 0,
		slotKey: null,
		slotOutput: 0,
		slotCacheRead: 0,
		digest: DIGEST_SEED,
		chain: []
	};
}
/**
* Fold one settlement into a session's own output and cache-read totals.
*
* This mirrors the token fold the report performs — one replacement slot per
* session, a matching key replacing the earlier sample, `llm/retry-started`
* clearing the slot — and both are held equal by a test on a synthetic store,
* because the report's work signal and its token totals must not disagree.
* @param session - the session's accumulation.
* @param type - event type discriminant.
* @param data - the decoded payload.
*/
function foldWorkEvent(session, type, data) {
	const key = `${numberOf$1(data.turn)}:${numberOf$1(data.step)}`;
	if (type === "llm/retry-started") {
		if (session.slotKey === key) {
			session.slotKey = null;
			session.slotOutput = 0;
			session.slotCacheRead = 0;
		}
		return;
	}
	const buckets = settlementBucketsOf(type, data);
	if (buckets === void 0) return;
	const previousOutput = session.slotKey === key ? session.slotOutput : 0;
	const previousCacheRead = session.slotKey === key ? session.slotCacheRead : 0;
	session.output += buckets.output - previousOutput;
	session.cacheRead += buckets.cacheRead - previousCacheRead;
	session.slotKey = key;
	session.slotOutput = buckets.output;
	session.slotCacheRead = buckets.cacheRead;
}
/**
* Split one bucket's row and token totals into de-replicated and replica parts.
*
* Detection is the reference script's, applied inside one local day: two
* sessions whose first event of the day lands on the same millisecond are
* candidates, the lowest store id among them is the group's base, and a
* candidate whose rolling digest agrees with the base's on more than 99% of the
* shorter log is a copy of it. Only the base's work stays in the signal.
* @param sessions - every session with rows in the bucket.
* @returns the bucket's work signal.
*/
function workOf(sessions) {
	const replicas = replicaSessionIds(sessions);
	const work = {
		events: 0,
		replicaEvents: 0,
		replicaSessions: 0,
		output: 0,
		cacheRead: 0
	};
	for (const [id, session] of sessions) {
		if (replicas.has(id)) {
			work.replicaEvents += session.rows;
			work.replicaSessions += 1;
			continue;
		}
		work.events += session.rows;
		work.output += session.output;
		work.cacheRead += session.cacheRead;
	}
	return work;
}
/**
* Identify the sessions whose log inside one bucket repeats another session's.
* @param sessions - every session with rows in the bucket.
* @returns the non-canonical members of every prefix-replica group.
*/
function replicaSessionIds(sessions) {
	const candidatesByFirstTime = /* @__PURE__ */ new Map();
	for (const [id, session] of sessions) {
		if (session.chain === void 0) continue;
		const candidates = candidatesByFirstTime.get(session.firstTime);
		if (candidates === void 0) candidatesByFirstTime.set(session.firstTime, [id]);
		else candidates.push(id);
	}
	const replicas = /* @__PURE__ */ new Set();
	for (const candidates of candidatesByFirstTime.values()) {
		if (candidates.length < 2) continue;
		candidates.sort((left, right) => left - right);
		const base = sessions.get(candidates[0])?.chain;
		if (base === void 0) continue;
		for (let index = 1; index < candidates.length; index += 1) {
			const other = sessions.get(candidates[index])?.chain;
			if (other === void 0) continue;
			const length = Math.min(base.length, other.length);
			if (length === 0) continue;
			let same = 0;
			for (let position = 0; position < length; position += 1) if (base[position] === other[position]) same += 1;
			if (same / length > REPLICA_AGREEMENT) replicas.add(candidates[index]);
		}
	}
	return replicas;
}
/** FNV-1a offset basis, the seed of every bucket's rolling digest. */
const DIGEST_SEED = 2166136261;
/** One interned digest per distinct event type; a window has a handful of types. */
const TYPE_DIGESTS = /* @__PURE__ */ new Map();
/**
* @param type - event type discriminant.
* @returns a stable digest of that type, computed once per distinct string.
*/
function digestOfType(type) {
	let digest = TYPE_DIGESTS.get(type);
	if (digest === void 0) {
		digest = DIGEST_SEED;
		for (let index = 0; index < type.length; index += 1) digest = Math.imul(digest ^ type.charCodeAt(index), 16777619) >>> 0;
		TYPE_DIGESTS.set(type, digest);
	}
	return digest;
}
/**
* Fold one event into a bucket's rolling prefix digest.
*
* The digest covers `(type, time)` in row order, so two buckets digest equal at
* position *i* exactly when their first *i*+1 events of that day agree on type
* and time. Position is carried by the fold itself rather than hashed in, which
* is what lets a copy be recognised even when its first row of the day sits at a
* different `seq` than the original's.
* @param previous - the bucket's digest after its previous row, `DIGEST_SEED` for the first.
* @param typeDigest - {@link digestOfType} of the row's type.
* @param time - the row's event time, epoch milliseconds.
* @returns the digest including this row.
*/
function rollDigest(previous, typeDigest, time) {
	const low = time % 4294967296;
	const high = Math.floor(time / 4294967296);
	let hash = Math.imul(previous ^ typeDigest, 16777619) >>> 0;
	hash = Math.imul(hash ^ low, 16777619) >>> 0;
	return Math.imul(hash ^ high, 16777619) >>> 0;
}
const USAGE_FIELDS = [
	["input", "inputTokens"],
	["output", "outputTokens"],
	["cacheRead", "cacheReadTokens"],
	["cacheWrite", "cacheWriteTokens"],
	["reasoning", "reasoningTokens"]
];
/**
* Read one provider usage record into the five token buckets.
* @param value - a payload's usage field, absent when the provider reported none.
* @returns the buckets, or undefined when the field is not a usage record.
*/
function usageBucketsOf(value) {
	const record = asRecord$1(value);
	if (record === void 0) return void 0;
	const buckets = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0
	};
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
* @param data - the decoded payload.
* @returns the buckets, or undefined when the settlement reported no usage record.
*/
function settlementBucketsOf(type, data) {
	if (type === "assistant/message" && data.usage !== void 0) return usageBucketsOf(data.usage);
	if (type !== "assistant/message" && type !== "assistant/attempt") return void 0;
	return usageBucketsOf(lastStreamUsage(data.stream));
}
/**
* Read the last `usage` chunk of a settlement's stream.
* @param stream - the payload's stream records, absent on unexpected payloads.
* @returns the chunk's usage, or undefined when the stream carries none.
*/
function lastStreamUsage(stream) {
	if (!Array.isArray(stream)) return void 0;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = asRecord$1(stream[index]);
		if (record?.type !== "chunk") continue;
		const chunk = asRecord$1(record.chunk);
		if (chunk?.type === "usage") return chunk.usage;
	}
}
/** @returns the value as a JSON object, or undefined for anything else. */
function asRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** @returns the value as a finite number, or 0 when the payload omits it. */
function numberOf$1(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
//#region src/aggregate/report.ts
/**
* The fold from one scanned day to the frozen wire report.
*
* This module is pure: it never opens the store and never reads the clock, so
* the whole report is reproducible from a fixture. Token accounting mirrors
* the harness's own `tokenUsage` projection: samples fold per
* `(session, turn, step)` with later samples replacing earlier ones, and a
* retry clears the slot so the retried attempt bills separately.
*
* Step latency, the retry signal, and the de-replicated work signal follow the
* verified query semantics of the reference script `usage-queries.mjs`; where
* the wire JSDoc and that script disagree, the script's definition is the one
* implemented and the disagreement is stated on the function.
* @module dsh-token-perf/aggregate/report
*/
const BUCKET_KEYS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"reasoning"
];
/** Placeholder key for a count whose subject the store did not record. */
const UNKNOWN_KEY = "(unknown)";
const MILLISECONDS_PER_MINUTE = 6e4;
const HOURS_PER_DAY = 24;
/** The route a latency sample carries when the settlement named none. */
const UNKNOWN_ROUTE = {
	provider: "unknown",
	model: "unknown"
};
/**
* Sample-size gate of the retry signal, fixed by the report's contract rather
* than configurable: a share below this many settled calls is not evidence.
*/
const MIN_RETRY_SETTLED = 100;
/** z of a two-sided 95% Wilson score interval. */
const WILSON_Z = 1.96;
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
	const speedFolds = /* @__PURE__ */ new Map();
	/** Instants of every `step/start` whose settlement has not been seen yet. */
	const stepStarts = /* @__PURE__ */ new Map();
	const retryFolds = /* @__PURE__ */ new Map();
	let summaries = 0;
	let sessionsActive = 0;
	/**
	* Fold one usage-bearing settlement into the day.
	*
	* A later sample for the same key replaces the earlier one, so only the net
	* delta moves the totals, the route, and the rate. The session's own
	* replacement slot is the projection's: a retry clears it and the retried
	* attempt therefore bills its full usage.
	*
	* An assembled message also settles whichever step it closes: its latency is
	* `time − step/start.time` for the same `(session, turn, step)`, and it is
	* recorded on the route the message itself named. A settlement that closes no
	* known step contributes tokens but no latency, which is why the speed view's
	* sample size is not the day's settlement count.
	*/
	function applyUsageSample(fold, event, data) {
		const buckets = settlementBucketsOf(event.type, data);
		if (buckets === void 0) return;
		const turn = numberOf(data.turn);
		const step = numberOf(data.step);
		const key = `${turn}:${step}`;
		const previous = fold.slot !== null && fold.slot.key === key ? fold.slot : void 0;
		const ownRoute = routeOf(data);
		const route = ownRoute ?? previous?.route;
		if (ownRoute !== void 0) fold.lastRoute = ownRoute;
		const row = route === void 0 ? void 0 : routeRow(route);
		const previousRow = previous?.route === void 0 ? void 0 : routeRow(previous.route);
		const previousCallRow = previous?.counted === true ? previousRow : void 0;
		let delta = 0;
		for (const bucket of BUCKET_KEYS) {
			const change = buckets[bucket] - (previous?.buckets[bucket] ?? 0);
			delta += change;
			totals[bucket] += change;
			fold.buckets[bucket] += change;
		}
		if (previous !== void 0 && previousRow !== void 0) for (const bucket of BUCKET_KEYS) previousRow[bucket] -= previous.buckets[bucket];
		if (row !== void 0) for (const bucket of BUCKET_KEYS) row[bucket] += buckets[bucket];
		if (route !== void 0) fold.models.add(`${route.provider}/${route.model}`);
		if (previousCallRow !== void 0 && previousCallRow !== row) previousCallRow.calls -= 1;
		if (row !== void 0 && previousCallRow !== row) row.calls += 1;
		fold.slot = {
			key,
			buckets,
			route,
			counted: row !== void 0
		};
		retryFoldOf(route ?? fold.lastRoute ?? UNKNOWN_ROUTE).settled += 1;
		if (event.type === "assistant/message") {
			const stepKey = `${event.sessionId}|${turn}|${step}`;
			const startedAt = stepStarts.get(stepKey);
			if (startedAt !== void 0) {
				stepStarts.delete(stepKey);
				const speedFold = speedFoldOf(ownRoute ?? UNKNOWN_ROUTE);
				speedFold.latencies.push(event.time - startedAt);
				speedFold.output += buckets.output - (previous?.buckets.output ?? 0);
			}
		}
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
		const buckets = usageBucketsOf(data.usage);
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
	/** Resolve one route to its speed fold, creating it on first sample. */
	function speedFoldOf(route) {
		const key = routeLabel(route.provider, route.model);
		let fold = speedFolds.get(key);
		if (fold === void 0) {
			fold = {
				provider: route.provider,
				model: route.model,
				latencies: [],
				output: 0
			};
			speedFolds.set(key, fold);
		}
		return fold;
	}
	/** Resolve one route to its retry fold, creating it on first sample or retry. */
	function retryFoldOf(route) {
		const key = routeLabel(route.provider, route.model);
		let fold = retryFolds.get(key);
		if (fold === void 0) {
			fold = {
				provider: route.provider,
				model: route.model,
				settled: 0,
				retried: 0
			};
			retryFolds.set(key, fold);
		}
		return fold;
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
			case "llm/retry-started": {
				const retried = `${numberOf(data?.turn)}:${numberOf(data?.step)}`;
				if (fold.slot !== null && fold.slot.key === retried) fold.slot = null;
				retryFoldOf(fold.lastRoute ?? UNKNOWN_ROUTE).retried += 1;
				break;
			}
			case "step/start":
				if (data !== void 0) stepStarts.set(`${event.sessionId}|${numberOf(data.turn)}|${numberOf(data.step)}`, event.time);
				break;
			case "request/context":
				if (data !== void 0) {
					const context = contextRouteOf(data);
					if (context !== void 0) fold.lastRoute = context;
				}
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
	const byModel = [...routes.values()].filter((row) => row.calls > 0 || totalOf(row) !== 0).sort((left, right) => totalOf(right) - totalOf(left) || compareKeys(routeKey(left), routeKey(right)));
	const speed = [...speedFolds.values()].map((fold) => {
		const latencies = fold.latencies.sort((left, right) => left - right);
		return {
			provider: fold.provider,
			model: fold.model,
			steps: latencies.length,
			p50Ms: percentileOf(latencies, .5),
			p90Ms: percentileOf(latencies, .9),
			outputPerStep: fold.output / latencies.length
		};
	}).sort((left, right) => right.steps - left.steps || compareKeys(routeLabel(left.provider, left.model), routeLabel(right.provider, right.model)));
	const work = {
		date,
		output: scan.work.output,
		cacheRead: scan.work.cacheRead,
		events: scan.work.events,
		replicaEvents: scan.work.replicaEvents,
		replicaSessions: scan.work.replicaSessions
	};
	const workTrend = [...input.previousWork, work];
	const retries = [];
	for (const fold of retryFolds.values()) {
		const wilsonLower = wilsonLowerBound(fold.retried, fold.settled);
		const triggered = fold.settled >= MIN_RETRY_SETTLED && wilsonLower >= input.retryThresholdShare;
		if (!triggered) continue;
		retries.push({
			provider: fold.provider,
			model: fold.model,
			settled: fold.settled,
			retried: fold.retried,
			share: fold.settled === 0 ? 0 : fold.retried / fold.settled,
			wilsonLower,
			triggered
		});
	}
	retries.sort((left, right) => right.wilsonLower - left.wilsonLower || compareKeys(routeLabel(left.provider, left.model), routeLabel(right.provider, right.model)));
	const compaction = {
		events: totals.compactions,
		summaries,
		summaryTokens: compactionBuckets
	};
	const subagents = {
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
	};
	return {
		date,
		timezone,
		timezoneOffsetMinutes,
		generatedAt,
		durationMs,
		skippedEvents: input.scan.skippedEvents,
		totals,
		byModel,
		speed,
		work,
		workTrend,
		retries,
		sessions,
		rate,
		compaction,
		subagents
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
		slot: null,
		subagentModel: void 0,
		lastRoute: void 0,
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
/** @returns the `provider:model` label the speed view and the retry signal group a route under. */
function routeLabel(provider, model) {
	return `${provider}:${model}`;
}
/** @returns an ascending string comparison, the stable tie-break of every ranking. */
function compareKeys(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}
/**
* Select one percentile from an ascending sample.
*
* This is the reference script's rule — index `floor(n × fraction)`, clamped to
* the last sample — rather than the textbook nearest-rank rank `ceil(fraction ×
* n)`. The two differ by at most one order statistic, and the script's wins so
* the panel and the script report the same number for the same day; the wire
* JSDoc's "by nearest rank" names this rule loosely.
* @param sorted - the sample, ascending, non-empty.
* @param fraction - quantile in `(0, 1)`.
* @returns the selected sample value.
*/
function percentileOf(sorted, fraction) {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
/**
* Lower bound of the Wilson score interval for a binomial share.
*
* The interval is the report's answer to "how much of this share survives its
* sample size": with `n` settled calls it stays near zero until the evidence
* accumulates, which is why the signal compares this bound rather than the
* observed share against the threshold.
* @param successes - reported occurrences, clamped to `trials`.
* @param trials - settled calls in the window; a non-positive value bounds at zero.
* @returns the lower bound at 95% confidence, in `0..1`.
*/
function wilsonLowerBound(successes, trials) {
	if (trials <= 0) return 0;
	const share = Math.min(1, successes / trials);
	const zSquared = WILSON_Z * WILSON_Z;
	const denominator = 1 + zSquared / trials;
	const centre = (share + zSquared / (2 * trials)) / denominator;
	const margin = WILSON_Z / denominator * Math.sqrt(share * (1 - share) / trials + zSquared / (4 * trials * trials));
	return Math.max(0, centre - margin);
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
/**
* Read the route a `request/context` record names.
* @param data - the event payload, which carries the resolved route at its top level.
* @returns the route, or undefined when either half is missing.
*/
function contextRouteOf(data) {
	const provider = data.provider;
	const model = data.model;
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
* Schemastery fills the four that have a default, so the plugin's `apply`
* always receives every field resolved.
* @module dsh-token-perf/config
*/
/** Default cache lifetime: long enough to absorb a panel's refresh burst, short enough to stay live. */
const DEFAULT_CACHE_TTL_MS = 3e4;
/** Default retry threshold: ten percent of a window's settled calls. */
const DEFAULT_RETRY_THRESHOLD_SHARE = .1;
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
	cacheTtlMs: z.number().min(0).default(DEFAULT_CACHE_TTL_MS),
	retryThresholdShare: z.number().min(0).max(1).default(DEFAULT_RETRY_THRESHOLD_SHARE)
});
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
*
* The report's seven-day trend costs one more window pass over the six earlier
* days: a work-only scan that decodes settlements alone and buckets its rows by
* local day, so the six days cost one whole-table pass instead of six. It runs
* after the day's own scan, sequentially, and yields to the event loop the same
* way that pass does.
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
	const retryThresholdShare = config.retryThresholdShare;
	const key = [
		day,
		databasePath,
		dictionaryPath,
		timezone,
		String(retryThresholdShare)
	].join("\0");
	const cached = ttl > 0 ? cache.get(key) : void 0;
	if (cached !== void 0) {
		if (cached.expiresAt > now) return Promise.resolve(cached.response);
		cache.delete(key);
	}
	const pending = inFlight.get(key);
	if (pending !== void 0) return pending;
	let promise;
	promise = produceReport(day, timezone, databasePath, dictionaryPath, retryThresholdShare, now).then((response) => {
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
* @param retryThresholdShare - retry share a route's Wilson lower bound must reach to be signalled.
* @param startedAt - instant the report's production began, epoch milliseconds.
* @returns the frozen wire envelope.
*/
async function produceReport(day, timezone, databasePath, dictionaryPath, retryThresholdShare, startedAt) {
	try {
		const { start, end } = localDayBounds(day, timezone);
		const scan = await scanDay({
			databasePath,
			dictionaryPath,
			start,
			end
		});
		const previousWork = await scanPreviousWork(day, timezone, databasePath, dictionaryPath);
		return deepFreeze({
			ok: true,
			report: buildDayReport({
				scan,
				date: day,
				timezone,
				generatedAt: startedAt,
				durationMs: Date.now() - startedAt,
				previousWork,
				retryThresholdShare
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
/** Local days the trend covers, the reported day included. */
const TREND_DAYS = 7;
/**
* Scan the six local days before one report's day.
*
* They are read in one contiguous pass over `[day-6 00:00, day 00:00)`: the
* store has no index on `events.time`, so a windowed read costs a whole-table
* pass whatever its width, and the fold buckets the rows by local day to report
* each day's own de-replicated signal. The day itself is not part of this
* window — the report's own scan already folds it while decoding its events,
* and a bucket for it here would decode the busiest day's settlements twice for
* a row nothing reads.
* @param day - `YYYY-MM-DD` local day the report covers.
* @param timezone - IANA zone the day boundaries are resolved in.
* @param databasePath - session store to read.
* @param dictionaryPath - zstd dictionary the store's payloads were compressed with.
* @returns the earlier days' work signals, oldest first.
* @throws {ScanError} when the store read fails.
*/
async function scanPreviousWork(day, timezone, databasePath, dictionaryPath) {
	return scanWorkDays({
		databasePath,
		dictionaryPath,
		timeZone: timezone,
		start: localDayBounds(trendStartDay(day, timezone), timezone).start,
		end: localDayBounds(day, timezone).start
	});
}
/**
* The local day the trend's window opens on: six local days before `day`.
* @param day - `YYYY-MM-DD` local day the report covers.
* @param timezone - IANA zone the day boundaries are resolved in.
* @returns the sixth local day before `day`.
*/
function trendStartDay(day, timezone) {
	let cursor = day;
	for (let index = 1; index < TREND_DAYS; index += 1) cursor = localDayKey(localDayBounds(cursor, timezone).start - 1, timezone);
	return cursor;
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