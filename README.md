# dsh-token-perf

DeepSeek Harness plugin: **one local calendar day of your own agent usage**, rendered as a page inside the Web GUI settings panel.

English primary; [中文说明](README.zh.md) is a full translation of this file.

## What it is

`dsh-token-perf` answers one question about a DeepSeek Harness deployment: what did this machine's agents actually do on one local calendar day?

It reads the deployment's own session store (`$DSH_HOME/sessions.sqlite`, the `session-persistence-sqlite` backend's file), aggregates exactly one local day, and serves the result to its own browser half over one loopback-only HTTP route. The panel is the only consumer; nothing leaves the machine and no external service is contacted.

The plugin ships as two halves of one release: the host half registers `GET /api/token-perf/day` on the composition's webserver, and the browser half registers a section in the Web GUI settings panel, renders the report that route returns, and is bilingual (Chinese and English).

## What it reports

One response — `DayReport` in `src/aggregate/types.ts` — carries the whole day:

- **Tokens by model** — `byModel[]`, one row per `provider:model` route with `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, and `calls`. `totals` repeats the same five buckets for the whole day.
- **Sessions opened and active** — `totals.sessionsOpened` (headers created inside the day) and `totals.sessionsActive` (sessions owning at least one event inside the day). Every session row carries `origin: 'root' | 'subagent'`, and `totals.subagents` counts the opened ones that are subagents.
- **Subagents** — `subagents.total`, `subagents.spawningSessions`, `subagents.maxPerSession`, `subagents.byPreset[]`, `subagents.byModel[]`; per session, `sessions[].subagents` is how many children that session created in the day.
- **Messages** — `totals.userMessages` and `totals.assistantMessages`, with the same pair on every session row.
- **Tools** — `totals.toolCalls` and `totals.toolResults`, counted independently and never derived from one another; the same pair per session.
- **Context compactions** — `compaction.events` (compactions started), `compaction.summaries` (summarizer calls), and `compaction.summaryTokens` (the five buckets billed to summary generation, reported separately because the main-loop token fold excludes them).
- **Token rate** — `rate.buckets[24]` (local hour, tokens completed in it, calls completed in it), `rate.peakPerMinute`, `rate.avgPerActiveMinute`, `rate.activeMinutes`, and `rate.spanMinutes`.
- **Per-session table** — `sessions[]`, descending by tokens: `id`, `title`, `parentId`, `origin`, `agentPreset`, `createdAt`, `lastActivityAt`, `userMessages`, `assistantMessages`, `toolCalls`, `toolResults`, `compactions`, `llmCalls`, `subagents`, `models[]`, and the five buckets.
- **Report metadata** — `date`, `timezone`, `timezoneOffsetMinutes`, `generatedAt`, and `durationMs` (the wall-clock cost of the scan that produced the report).

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

The host half has four fields, declared under the `dsh-token-perf` row of a cordis composition:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `databasePath` | `string` | none; resolved per request (see below) | SQLite session store to read |
| `dictionaryPath` | `string` | the vendored `zstd-dictionary.bin` beside the built entry | zstd dictionary the store's event payloads were compressed with |
| `timeZone` | `string` | the host's own zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) | IANA zone the report's day boundaries are resolved in |
| `cacheTtlMs` | `number >= 0` | `30000` | how long a finished report may be served from cache; `0` disables caching |

`databasePath` is resolved per request in this order: the configured value → `$DSH_HOME/sessions.sqlite` → `~/.dsh/sessions.sqlite`. An unset or empty value at either step falls through to the next.

```yaml
- id: token-perf
  name: 'dsh-token-perf'
  config:
    timeZone: America/Los_Angeles
    databasePath: /root/.dsh/sessions.sqlite
    cacheTtlMs: 30000
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

One cache entry exists per `(day, database path, dictionary path, time zone)`. A past day cannot gain events, so its report is kept for the process's life; the current day's entry expires after `cacheTtlMs`; failures are never retained, so a store that was busy or missing is retried on the next request; and concurrent requests for one key await a single scan.

## How the numbers are defined

- **Source.** `$DSH_HOME/sessions.sqlite`, the SQLite session backend's file, opened read-only (`node:sqlite`'s `DatabaseSync` with `readOnly: true`). The store's owner keeps writing; nothing here writes or locks.
- **One pass.** The store has no index on `events.time`, so a day costs one windowed scan of `events` (`time >= start AND time < end`, ordered by `(session_id, seq)`) plus the `sessions` headers it needs, and every metric above is folded from that single result. Event payloads are zstd-compressed with the vendored dictionary — a small number of rows are stored as plain text — so rows are decoded in Node and never through SQL.
- **Schema guard.** The reader requires `PRAGMA user_version` to be 20 and the columns it reads to exist. Anything else fails as `unsupported-schema` before a payload is decoded, rather than reporting numbers from a format it does not know.
- **Token accounting mirrors the harness's own `tokenUsage` projection.** Samples fold per `(session, turn, step)`: a later sample for the same key replaces the earlier one and only the net delta moves the totals, while `llm/retry-started` clears the key so a retried attempt bills in full. A sample is `assistant/message`'s `data.usage`, or the last `chunk.type === 'usage'` inside `assistant/attempt`'s `data.stream`. The buckets map `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens`; `totalTokens` is never summed, because it is one call's cache-inclusive total rather than one of the five buckets. A sample that carries no route is attributed to the route of the sample it replaced.
- **Routes are `provider:model`.** The route is read from `assistant/message.data.message.source.{provider,model}`. One model served by two providers is two rows, because it is two billing routes.
- **The day is a host-local calendar day.** Boundaries are resolved through the IANA zone's real offsets at both edges, so a DST transition day is correctly 23 or 25 hours long. The day is neither UTC nor the browser's zone.
- **Opened versus active.** Opened means the session header's `created_at` falls inside the day; active means the session owns at least one event inside the day. A session is a subagent when `sessions.parent_session` is set. The `origin` column is not used, because it disagrees with `parent_session` in the store this plugin was built against.
- **Subagent distribution.** Counts per parent come from `parent_session`; the preset comes from the session header's `agent_preset`, and the model from the child's own `subagent/descriptor` event (`agentProvider`/`agentModel`). A subject the store did not record is reported as `(unknown)` rather than dropped.
- **Tools.** `tool/call` and `tool/result` are counted independently. Their counts differ in real stores — interrupted and dispatched calls — so neither is derived from the other.
- **Rate.** Each metered settlement's net delta is added to the minute its event landed in and then to its local hour. `activeMinutes` counts minutes with a non-zero delta, `peakPerMinute` is the largest such minute, and `avgPerActiveMinute` divides the day's main-loop tokens by `activeMinutes`. The measurement limit is under Known limitations.
- **Compaction.** `compaction/start` counts compactions. `compaction/summary` is a separate summarizer call that carries its own usage and model: it is billed, excluded from the main-loop token fold, reported under `compaction.summaryTokens`, and still counted in `llmCalls`. `compaction/prune` calls no model and is not counted.

## Known limitations

- **`cacheWrite` is always 0 in this deployment.** No provider in the store this plugin was built against ever reports `cacheWriteTokens`. The field stays in the contract because the harness's projection has it; a zero here means "not reported", not "nothing was cached".
- **`reasoning` is sparse.** Only some providers report `reasoningTokens` separately. A day whose routes do not report them shows 0 even though reasoning tokens were spent.
- **Minute buckets measure tokens completed in that minute, not the rate while a call ran.** A settlement's whole usage lands in the minute its event was written, so a long call appears as one spike instead of a smooth rate, and the hourly buckets inherit that skew. `spanMinutes` is the span from the first settlement to the last, not a duty cycle.
- **`created_at` is the current incarnation's creation time.** A resumed or seeded session can carry a creation timestamp well after its first event, so a session that counts as "opened today" may contain older event times, and the two are deliberately not cross-checked.
- **One session backend, one schema version.** Only the SQLite store at `user_version = 20` is readable. Any other backend or a bumped schema surfaces `unsupported-schema` in the panel instead of a report: the reader fails loudly rather than decode a format it does not know.
- **The first load of a day is expensive.** With no index on `events.time`, the scan reads the whole `events` window, which takes seconds on a multi-gigabyte store. The result is cached afterwards — past days indefinitely, the current day for `cacheTtlMs` — and `durationMs` reports the real cost; a cold request after a restart pays it again.
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
- `lib/client.js` — the browser half, a CJS closure registered with `window.__ModuleLoader__.load({ id: 'dsh-token-perf', factory })` whose `require` resolves only the shell's platform modules; everything else is inlined, and two build-time purity gates reject any import or surviving `require()` outside that table.

The build copies `src/store/zstd-dictionary.bin` to `lib/zstd-dictionary.bin`, which is the default the host resolves at runtime.

`lib/` is committed on purpose. A git install fetches sources and does not run `build`, so a package that ships neither built artifacts nor an allowlisted `prepare` script arrives unloadable; committing the artifacts keeps installation to one command with no install-time code execution.

`pnpm test` runs the suites in `tests/`. `tests/manifest.spec.ts` asserts the packaging face — manifest fields, the bundle patch row, the license files, and the vendored dictionary's exact bytes — without any build step, and `tests/integration/real-store.spec.ts` runs against a store copy when `TOKEN_PERF_STORE` names one.

## License

Apache-2.0; see [`LICENSE`](LICENSE). [`NOTICE`](NOTICE) carries the attribution for the vendored dictionary, and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) records its origin, license, and exact bytes.
