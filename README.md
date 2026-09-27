# dsh-token-perf

DeepSeek Harness plugin: **one local calendar day of your own agent usage**, rendered as a page inside the Web GUI settings panel.

English primary; [中文说明](README.zh.md) is a full translation of this file.

## What it is

`dsh-token-perf` answers one question about a DeepSeek Harness deployment: what did this machine's agents actually do on one local calendar day?

It reads the deployment's own session store (`$DSH_HOME/sessions.sqlite`, the `session-persistence-sqlite` backend's file), aggregates one local day in full plus the six days before it for the trend's work signal, and serves the result to its own browser half over one loopback-only HTTP route. The panel is the only consumer; nothing leaves the machine and no external service is contacted.

The plugin ships as two halves of one release: the host half registers `GET /api/token-perf/day` on the composition's webserver, and the browser half registers a section in the Web GUI settings panel, renders the report that route returns, and is bilingual (Chinese and English).

## What it reports

One response — `DayReport` in `src/aggregate/types.ts` — carries the whole day:

- **Tokens by model** — `byModel[]`, one row per `provider:model` route with `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, and `calls`. `totals` repeats the same five buckets for the whole day.
- **Step latency and throughput** — `speed[]`, one row per `provider:model` route: `steps` (settled steps with a measurable duration), `p50Ms`, `p90Ms`, and `outputPerStep` (mean output tokens per settled step). Rows descend by `steps` on the wire and the panel re-sorts them by `p50Ms` ascending; a sample that carried no route keeps its own `unknown` row.
- **De-replicated work** — `work` is the requested day's work signal and `workTrend[]` the seven trailing local days ending there, oldest first: `output` (the work signal), `cacheRead` (context re-reading, drawn as background), `events` (in-window events left once prefix-replica sessions are removed), and what that removal took out — `replicaEvents` and `replicaSessions`.
- **Retry signals** — `retries[]`, the day's `provider:model` routes whose retry share crossed both gates: at least 100 settled samples and a Wilson 95% lower bound at or above `retryThresholdShare`. A triggered route carries `settled`, `retried`, `share`, `wilsonLower`, and `triggered`; a route that did not trigger is absent from the array, and the panel draws no empty frame for it.
- **Sessions opened and active** — `totals.sessionsOpened` (headers created inside the day) and `totals.sessionsActive` (sessions owning at least one event inside the day). Every session row carries `origin: 'root' | 'subagent'`, and `totals.subagents` counts the opened ones that are subagents.
- **Subagents** — `subagents.total`, `subagents.spawningSessions`, `subagents.maxPerSession`, `subagents.byPreset[]`, `subagents.byModel[]`; per session, `sessions[].subagents` is how many children that session created in the day.
- **Messages** — `totals.userMessages` and `totals.assistantMessages`, with the same pair on every session row.
- **Tools** — `totals.toolCalls` and `totals.toolResults`, counted independently and never derived from one another; the same pair per session.
- **Context compactions** — `compaction.events` (compactions started), `compaction.summaries` (summarizer calls), and `compaction.summaryTokens` (the five buckets billed to summary generation, reported separately because the main-loop token fold excludes them).
- **Token rate** — `rate.buckets[24]` (local hour, tokens completed in it, calls completed in it), `rate.peakPerMinute`, `rate.avgPerActiveMinute`, `rate.activeMinutes`, and `rate.spanMinutes`.
- **Per-session table** — `sessions[]`, descending by tokens: `id`, `title`, `parentId`, `origin`, `agentPreset`, `createdAt`, `lastActivityAt`, `userMessages`, `assistantMessages`, `toolCalls`, `toolResults`, `compactions`, `llmCalls`, `subagents`, `models[]`, and the five buckets.
- **Report metadata** — `date`, `timezone`, `timezoneOffsetMinutes`, `generatedAt`, and `durationMs` (the wall-clock cost of producing the report: the day's scan, the trend's pass, and the fold).

The panel carries no bare day-total headline and no token-composition proportion ring; both v1 elements are deleted. A single total is not a work signal — 98.7% of the window's 67.0B tokens are cache reads and 98.8% are context re-sent inside the same session — and a ring loses its angles past four segments. The model split therefore lives in the per-route table, and route comparison in the speed view.

## Install

```sh
dsh plugin --profile web add github:NolanHo/dsh-token-perf#<commit-sha>
```

The command forwards to pnpm inside the profile directory, installs the pinned commit, and appends `dsh-token-perf` to `dsh.profile.bundles` in the profile's `package.json`, because the package manifest declares `dsh.bundle.patch`.

Restart the `dsh` process afterwards: bundle layers and the plugin row are composed at startup, not while the host runs. Refresh the browser page after the restart so the shell loads the new client bundle.

The repository commits its built `lib/`, so a git install needs no build step: the package declares no `prepare` script, pnpm therefore runs nothing at install time, and no profile `allowBuilds` entry is required.

Verify the bundle row is in the composed tree (this does not start the host):

```sh
dsh --profile web --dump-config | rg token-perf
```

When there is no `dsh` on `PATH` and the CLI is run from a checkout instead, the same invocations go through the checkout's script: `pnpm dsh plugin --profile web add …` and `pnpm dsh --profile web --dump-config`, both from the checkout directory.

Local development, serving the working copy instead of a pinned commit:

```sh
# in this repository
pnpm install
pnpm build

# from the dsh checkout, or with dsh on PATH
dsh plugin --profile web add link:/absolute/path/to/dsh-token-perf
```

A `link:` spec resolves to the checkout itself, so `pnpm build` here is what the profile serves; a git spec serves the committed `lib/`. A `link:` path that starts with `.` or `..` is anchored to the directory the command is invoked from, so the same relative spec works from anywhere. The restart rule is unchanged.

## Configuration

The host half has five fields, declared under the `dsh-token-perf` row of a cordis composition:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `databasePath` | `string` | none; resolved per request (see below) | SQLite session store to read |
| `dictionaryPath` | `string` | the vendored `zstd-dictionary.bin` beside the built entry | zstd dictionary the store's event payloads were compressed with |
| `timeZone` | `string` | the host's own zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) | IANA zone the report's day boundaries are resolved in |
| `cacheTtlMs` | `number >= 0` | `30000` | how long a finished report may be served from cache; `0` disables caching |
| `retryThresholdShare` | `number in 0..1` | `0.10` | retry share a route's Wilson 95% lower bound must reach before the route is signalled |

`databasePath` is resolved per request in this order: the configured value → `$DSH_HOME/sessions.sqlite` → `~/.dsh/sessions.sqlite`. An unset or empty value at either step falls through to the next.

`retryThresholdShare` moves the retry signal's second gate only. Raising it narrows the badge row: fewer routes clear the bound, and a route whose observed share is high but whose sample is small stays silent. Lowering it widens the row, and at `0` every route with at least 100 settled samples is signalled. The 100-sample gate is fixed in the report rather than configurable, and the value is part of the report cache key, so changing it re-scans.

```yaml
- id: token-perf
  name: 'dsh-token-perf'
  config:
    timeZone: America/Los_Angeles
    databasePath: /root/.dsh/sessions.sqlite
    cacheTtlMs: 30000
    retryThresholdShare: 0.10
```

### The route

The prefix is fixed at `/api/token-perf` and is not a configuration field: the two halves of one release are built against the same constant, and a configurable prefix would let them disagree.

| Request | Response |
|---|---|
| `GET /api/token-perf/day?date=YYYY-MM-DD` | `200` with `{ok:true,report}`, or `200` with `{ok:false,code,message}` where `code` is `bad-request`, `no-database`, `unsupported-schema`, or `unreadable` |
| `GET /api/token-perf/day` with no `date` | today, in the report's zone |
| any other method | `405` with `allow: GET` |
| any other path under the prefix | `404` |
| a non-loopback peer | `403` |

Every response carries `cache-control: no-store`. Domain failures — a missing store, an unsupported schema, an invalid date — answer `200` with the error envelope so the panel can render the reason, while the transport status stays reserved for transport-level facts. Route handling is loopback-only: a report describes local usage and is not a remote API.

One cache entry exists per `(day, database path, dictionary path, time zone, retry threshold share)`. A past day cannot gain events, so its report is kept for the process's life; the current day's entry expires after `cacheTtlMs`; failures are never retained, so a store that was busy or missing is retried on the next request; and concurrent requests for one key await a single scan.

## How the numbers are defined

- **Source.** `$DSH_HOME/sessions.sqlite`, the SQLite session backend's file, opened read-only (`node:sqlite`'s `DatabaseSync` with `readOnly: true`). The store's owner keeps writing; nothing here writes or locks.
- **Two windowed passes.** The store has no index on `events.time`, so a windowed read costs one whole-table pass whatever its width, and a report runs two. The day's own scan (`time >= start AND time < end`, ordered by `(session_id, seq)`) decodes every event and folds every metric above plus the day's own work signal, with the `sessions` headers it needs; one work-only pass over the six earlier days reads every row's type and time for the replica digest and decodes only the settlements it sums. Event payloads are zstd-compressed with the vendored dictionary — a small number of rows are stored as plain text — so rows are decoded in Node and never through SQL.
- **Schema guard.** The reader requires `PRAGMA user_version` to be 20 and the columns it reads to exist. Anything else fails as `unsupported-schema` before a payload is decoded, rather than reporting numbers from a format it does not know.
- **Token accounting mirrors the harness's own `tokenUsage` projection.** Each session holds **one** replacement slot, not a map per key: a sample folds against the slot only when its `(session, turn, step)` key matches the slot's, and a key that reappears after another key advanced the slot therefore starts from zero rather than from its own stale buckets. A matching sample replaces the earlier one, so only the net delta moves the totals; `llm/retry-started` clears the slot when it names that same key, which is what makes a retried attempt bill in full. A sample is `assistant/message`'s `data.usage`, or the last `chunk.type === 'usage'` inside `assistant/attempt`'s `data.stream`. The buckets map `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens`; `totalTokens` is never summed, because it is one call's cache-inclusive total rather than one of the five buckets. A sample that carries no route is attributed to the route of the sample it replaced.
- **Routes are `provider:model`.** The route is read from `assistant/message.data.message.source.{provider,model}`. One model served by two providers is two rows, because it is two billing routes.
- **Step latency.** `assistant/message.time − step/start.time` for the same `(session, turn, step)`, folded per `provider:model`. A step that never settles inside the day contributes tokens but no latency sample, so a route's `steps` is smaller than its settlement count. `p50Ms` and `p90Ms` take the order statistic at index `floor(n × fraction)` clamped to the last sample — the reference script's rule, which can sit one order statistic away from textbook nearest-rank, so the wire names the rule rather than the textbook term. **No mean latency is reported anywhere**, and the panel draws a p50 bar with a p90 whisker rather than an average bar. A settlement carrying no route keeps its own `unknown` row instead of being dropped.
- **The day is a host-local calendar day.** The boundaries are the exact instants whose local calendar day is the requested date, found by bisecting on the zone's own rendering of each instant. A transition day is therefore measured at its real length rather than an assumed one — including zones that shift by 30 minutes (Australia/Lord_Howe) or change offset at local midnight (America/Santiago, Africa/Cairo) — and a day a zone skips entirely resolves to an empty range. The day is neither UTC nor the browser's zone.
- **Prefix-replica de-duplication.** A session is a prefix replica inside one local day when its in-window `(type, time)` sequence repeats another session's. The candidates are that day's sessions with at least 50 rows whose first event lands on the same millisecond; the lowest store id among them is the group's base, and a candidate whose rolling digest agrees with the base's on more than 99% of the shorter log is removed. A replica's events and settled tokens leave `work` and are reported as `replicaEvents` and `replicaSessions`, so the response states how much was removed; `totals`, `byModel`, and the session rows keep every event, replica or not. The cause is a seeded or forked session re-appending the events it copies with their original timestamps, which is why a closed day's raw window keeps growing after the day ends. Detection is per local day, so a session is a replica only inside a day whose work it actually repeated.
- **Opened versus active.** Opened means the session header's `created_at` falls inside the day; active means the session owns at least one event inside the day. A session is a subagent when `sessions.parent_session` is set. The `origin` column is not used, because it disagrees with `parent_session` in the store this plugin was built against.
- **Subagent distribution.** Counts per parent come from `parent_session`; the preset comes from the session header's `agent_preset`, and the model from the child's own `subagent/descriptor` event (`agentProvider`/`agentModel`). A subject the store did not record is reported as `(unknown)` rather than dropped.
- **`llmCalls` is a settlement count, not a message count.** It counts the usage samples folded in the day: completed assistant messages, the `assistant/attempt` streams that carry a sample of their own, and compaction summaries. It is therefore larger than `assistantMessages` in real stores, and the panel shows the assistant-message count beneath it so the two cannot be confused.
- **Retry signal.** `llm/retry-started` counted over usage-bearing settlement samples, grouped per local day × `provider:model`; the report evaluates its own day's windows only. A route reaches `retries[]` only when its window holds at least 100 settled samples **and** the Wilson 95% lower bound of `retried / settled` is at or above `retryThresholdShare` — the bound, not the observed share, so a small sample cannot fire whatever its ratio. A retry event names no route of its own, so it is charged to the route its session last addressed (`request/context`, or its newest route-bearing settlement) and to `unknown` when the session recorded none.
- **Tools.** `tool/call` and `tool/result` are counted independently. Their counts differ in real stores — interrupted and dispatched calls — so neither is derived from the other.
- **Rate.** Each metered settlement's net delta is added to the minute its event landed in and then to its local hour. `activeMinutes` counts minutes with a non-zero delta, `peakPerMinute` is the largest such minute, and `avgPerActiveMinute` divides the day's main-loop tokens by `activeMinutes`. The measurement limit is under Known limitations.
- **Compaction.** `compaction/start` counts compactions. `compaction/summary` is a separate summarizer call that carries its own usage and model: it is billed, excluded from the main-loop token fold, reported under `compaction.summaryTokens`, and still counted in `llmCalls`. `compaction/prune` calls no model and is not counted.
- **The trend window.** `workTrend` is exactly seven trailing local days ending at the requested day, oldest first. The six days before it are folded by one contiguous work-only scan over `[day-6 00:00, day 00:00)`, bucketed by local day; the requested day is not re-read there, because the day's own scan already folded its work row while decoding its events.

## Known limitations

- **`cacheWrite` is always 0 in this deployment.** No provider in the store this plugin was built against ever reports `cacheWriteTokens`. The field stays in the contract because the harness's projection has it; a zero here means "not reported", not "nothing was cached".
- **`reasoning` is sparse.** Only some providers report `reasoningTokens` separately. A day whose routes do not report them shows 0 even though reasoning tokens were spent.
- **Minute buckets measure tokens completed in that minute, not the rate while a call ran.** A settlement's whole usage lands in the minute its event was written, so a long call appears as one spike instead of a smooth rate, and the hourly buckets inherit that skew. `spanMinutes` is the span from the first settlement to the last, not a duty cycle.
- **`created_at` is the current incarnation's creation time.** A resumed or seeded session can carry a creation timestamp well after its first event, so a session that counts as "opened today" may contain older event times, and the two are deliberately not cross-checked.
- **Raw day totals are not stable.** Because a seeded or forked session re-appends copied events with their original timestamps, those appends keep landing in closed-day windows: `totals`, `byModel`, the session rows, and `rate` describe the window as it stands at scan time and drift upward as more copies are written. The de-replicated `work` figures are the stable half — on 2026-09-20 and 2026-09-21 they equal the values measured before that drift began (output 26,519,140 and 19,880,737; cacheRead 4,236,351,104 and 3,676,235,324).
- **The de-duplication rule is stricter than the analysis baseline it was derived from.** On 2026-09-21 it removes four replica sessions (17,510 events) where the original analysis found one group. It is a heuristic with stated thresholds — at least 50 rows, same first-event millisecond, more than 99% sequence agreement — not a proof that a session was copied, and a duplicate whose first event lands in another millisecond is not detected.
- **One session backend, one schema version.** Only the SQLite store at `user_version = 20` is readable. Any other backend or a bumped schema surfaces `unsupported-schema` in the panel instead of a report: the reader fails loudly rather than decode a format it does not know.
- **The first load of a report is expensive; a cached hit is free.** With no index on `events.time`, one day plus the seven-day trend costs two whole-table passes: measured on a 3.4 GB / 2.2 M-event store, about **46 s cold** and about **37 s with a warm page cache**. The result is then cached — past days indefinitely, the current day for `cacheTtlMs` — and a cached hit costs 0 ms. The scan yields to the event loop every 256 rows, so it does not stall a running Host, and `durationMs` reports the real cost of the scans that produced the report.
- **Totals exclude compaction summary tokens.** `totals` and `byModel` are the main-loop fold only; the summarizer's own usage lives in `compaction.summaryTokens`. Add the two when comparing against a provider bill.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

`pnpm build` runs `tsc -p tsconfig.build.json`, which emits declarations into `lib/types/**`, then `tsdown`, which emits two bundles:

- `lib/index.js` — the host half (ESM); Node builtins, cordis, and every `@deepseek-ai/*` package stay external and resolve from the profile;
- `lib/client.js` — the browser half, **minified**, a CJS closure registered with `window.__ModuleLoader__.load({ id: 'dsh-token-perf', factory })` whose `require` resolves only the shell's platform modules; everything else is inlined. Two build-time purity gates guard that module table: one rejects a Node builtin or a non-platform `@deepseek-ai/*` import while the bundle resolves, and the other walks the emitted chunk's **module graph** — not its text — so every remaining module must be this package's own source or a platform-table external. Reading the graph is what keeps minification from blinding the gate, because minification renames the factory's `require` parameter and would defeat a textual scan. The current bundle is 46,699 B.

The build copies `src/store/zstd-dictionary.bin` to `lib/zstd-dictionary.bin`, which is the default the host resolves at runtime.

`lib/` is committed on purpose. A git install fetches sources and does not run `build`, so a package that ships neither built artifacts nor an allowlisted `prepare` script arrives unloadable; committing the artifacts keeps installation to one command with no install-time code execution.

`pnpm test` runs the suites in `tests/`. `tests/manifest.spec.ts` asserts the packaging face — manifest fields, the bundle patch row, the license files, and the vendored dictionary's exact bytes — without any build step, and `tests/integration/real-store.spec.ts` runs against a store copy when `TOKEN_PERF_STORE` names one.

## License

Apache-2.0; see [`LICENSE`](LICENSE). [`NOTICE`](NOTICE) carries the attribution for the vendored dictionary, and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) records its origin, license, and exact bytes.
