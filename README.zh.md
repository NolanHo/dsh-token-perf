# dsh-token-perf

DeepSeek Harness 插件：把**你自己某一个本地自然日**的 agent 用量分析，渲染成 Web GUI 设置面板里的一页。

中文说明为主；英文原版见 [README.md](README.md)，两版内容一致。

## 它是什么

`dsh-token-perf` 回答关于一个 DeepSeek Harness 部署的一个问题：这台机器上的 agent 在某一个本地自然日里实际做了什么？

它读取部署自身的会话库（`$DSH_HOME/sessions.sqlite`，即 `session-persistence-sqlite` 后端的文件），只聚合一个本地自然日，再通过唯一一条仅限回环地址的 HTTP 路由把结果交给自己的浏览器半。除了这个面板没有别的消费者；数据不出本机，也不访问任何外部服务。

插件是同一个 release 的两个半：host 半在组合的 webserver 上注册 `GET /api/token-perf/day`；浏览器半在 Web GUI 设置面板里注册一个 section，渲染该路由返回的报告，界面中英双语。

## 它报告什么

一个响应（`src/aggregate/types.ts` 的 `DayReport`）承载整天的数据：

- **按模型拆分的 token** —— `byModel[]`，每个 `provider:model` 路由一行，含 `input`、`output`、`cacheRead`、`cacheWrite`、`reasoning` 与 `calls`；`totals` 里重复同样五个桶的当天合计。
- **开启与活跃的 session** —— `totals.sessionsOpened`（创建时间落在当天的 session header）与 `totals.sessionsActive`（当天至少有一条 event 的 session）；每个 session 行都带 `origin: 'root' | 'subagent'`，`totals.subagents` 是当天开启的 session 中属于 subagent 的数量。
- **subagent** —— `subagents.total`、`subagents.spawningSessions`、`subagents.maxPerSession`、`subagents.byPreset[]`、`subagents.byModel[]`；按 session 看，`sessions[].subagents` 是这个 session 当天创建了多少个子代理。
- **消息数** —— `totals.userMessages` 与 `totals.assistantMessages`，每个 session 行上有同一对计数。
- **工具** —— `totals.toolCalls` 与 `totals.toolResults`，两者各自独立计数、绝不互相推导；每个 session 行上有同一对计数。
- **context compact** —— `compaction.events`（发起的压缩次数）、`compaction.summaries`（摘要调用次数）、`compaction.summaryTokens`（摘要生成消耗的五个桶，单独报告，因为主循环的 token 折叠不含它）。
- **token 速率** —— `rate.buckets[24]`（本地小时、该小时完成的 token、该小时完成的调用数）、`rate.peakPerMinute`、`rate.avgPerActiveMinute`、`rate.activeMinutes`、`rate.spanMinutes`。
- **逐 session 明细表** —— `sessions[]`，按 token 降序：`id`、`title`、`parentId`、`origin`、`agentPreset`、`createdAt`、`lastActivityAt`、`userMessages`、`assistantMessages`、`toolCalls`、`toolResults`、`compactions`、`llmCalls`、`subagents`、`models[]`，以及五个 token 桶。
- **报告元数据** —— `date`、`timezone`、`timezoneOffsetMinutes`、`generatedAt`、`durationMs`（生成这份报告的扫描实际耗时）。

## 安装

```sh
dsh plugin --profile web add github:NolanHo/dsh-token-perf#<commit-sha>
```

该命令在 profile 目录内转发给 pnpm，装上被 pin 死的 commit；由于包 manifest 里声明了 `dsh.bundle.patch`，它还会把 `dsh-token-perf` 追加进 profile `package.json` 的 `dsh.profile.bundles`。

之后必须**重启 `dsh` 进程**：bundle 层与插件行在启动时组合，运行中不会生效。重启后刷新浏览器页面，shell 才会加载新的 client bundle。

仓库**提交了构建产物 `lib/`**，因此 git 安装不需要构建步骤：包内没有 `prepare` 脚本，pnpm 在安装期什么都不执行，也不需要往 profile 的 `allowBuilds` 里加任何条目。

验证该 bundle 行已进入组合树（这条命令不会启动 host）：

```sh
dsh --profile web --dump-config | rg token-perf
```

当 `PATH` 上没有 `dsh`、命令是从某个 checkout 里跑的时候，同样的调用走该 checkout 的 script：在 checkout 目录内执行 `pnpm dsh plugin --profile web add …` 与 `pnpm dsh --profile web --dump-config`。

本地开发，让 profile 直接用工作副本而不是 pin 死的 commit：

```sh
# 在本仓库内
pnpm install
pnpm build

# 在 dsh checkout 内，或 PATH 上有 dsh 时
dsh plugin --profile web add link:/absolute/path/to/dsh-token-perf
```

`link:` 规格直接指向这份 checkout，所以 profile 用的就是这里 `pnpm build` 的产物；git 规格用的则是已提交的 `lib/`。以 `.` 或 `..` 开头的 `link:` 路径会以命令调用目录为锚点解析，因此同一个相对规格在任何目录下都成立。重启规则不变。

## 配置

host 半有四个字段，写在 cordis 组合里 `dsh-token-perf` 那一行下面：

| 字段 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `databasePath` | `string` | 无；每个请求按下面顺序解析 | 要读取的 SQLite 会话库 |
| `dictionaryPath` | `string` | 构建产物旁边那份 vendored `zstd-dictionary.bin` | 库里 event payload 压缩所用的 zstd 字典 |
| `timeZone` | `string` | host 自身时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`） | 解析报告日界所用的 IANA 时区 |
| `cacheTtlMs` | `number >= 0` | `30000` | 一份完成的报告最多可从缓存服务多久；`0` 关闭缓存 |

`databasePath` 每个请求按这个顺序解析：配置值 → `$DSH_HOME/sessions.sqlite` → `~/.dsh/sessions.sqlite`。任一步取到未设置或空字符串都继续往下落。

```yaml
- id: token-perf
  name: 'dsh-token-perf'
  config:
    timeZone: America/Los_Angeles
    databasePath: /root/.dsh/sessions.sqlite
    cacheTtlMs: 30000
```

### 路由

前缀固定为 `/api/token-perf`，不是配置项：同一个 release 的两个半按同一个常量构建，可配置的前缀会让两边说法不一致。

| 请求 | 响应 |
|---|---|
| `GET /api/token-perf/day?date=YYYY-MM-DD` | `200` + `{ok:true,report}`；或 `200` + `{ok:false,code,message}`，`code` 为 `bad-request`、`no-database`、`unsupported-schema`、`unreadable` 之一 |
| `GET /api/token-perf/day` 不带 `date` | 报告时区下的今天 |
| 其它方法 | `405`，带 `allow: GET` |
| 前缀下的其它路径 | `404` |
| 非回环地址的对端 | `403` |

所有响应都带 `cache-control: no-store`。领域失败——库不存在、schema 不支持、日期非法——回 `200` 加错误信封，让面板能渲染原因；传输层状态只留给传输层事实。路由只服务回环地址：这份报告描述的是本机用量，不是远程 API。

缓存按 `(日期, 库路径, 字典路径, 时区)` 各一份。已经过去的某天不可能再产生 event，其报告在进程存活期间一直保留；当天的条目在 `cacheTtlMs` 之后过期；失败从不缓存，因此刚刚繁忙或缺失的库会在下一个请求重试；同一个 key 的并发请求共用同一次扫描。

## 数字是怎么定义的

- **数据源。** `$DSH_HOME/sessions.sqlite`，SQLite 会话后端的文件，以只读方式打开（`node:sqlite` 的 `DatabaseSync` 加 `readOnly: true`）。库的属主继续写自己的；这里不写、不加锁。
- **单遍扫描。** 库里 `events.time` 没有索引，所以一天的成本是一次带时间窗的 `events` 扫描（`time >= start AND time < end`，按 `(session_id, seq)` 排序）加上所需的 `sessions` header，上面每一项指标都从这一份结果里折叠出来。event payload 是用 vendored 字典压缩的 zstd（极少数行以纯文本存放），因此一律在 Node 里解码，绝不走 SQL。
- **schema 守卫。** reader 要求 `PRAGMA user_version` 为 20 且它读取的列都存在。任何其它情况在解码任何 payload 之前就以 `unsupported-schema` 失败，而不是用不认识的格式报出错误数字。
- **token 口径镜像 harness 自己的 `tokenUsage` 投影。** 采样按 `(session, turn, step)` 折叠：同一个 key 后到的采样替换先前的，只有净增量会改变总计；`llm/retry-started` 清空该 key，于是重试的那次调用会完整计费。一个采样要么是 `assistant/message` 的 `data.usage`，要么是 `assistant/attempt` 的 `data.stream` 里最后一个 `chunk.type === 'usage'`。五个桶映射 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`；`totalTokens` 从不求和，因为它是单次调用含 cache 的全量，而不是五个桶之一。不带路由的采样会归到它所替换的那条采样的路由上。
- **路由键是 `provider:model`。** 路由读自 `assistant/message.data.message.source.{provider,model}`。同一个模型由两个 provider 提供就是两行，因为那是两条计费路由。
- **"一天"是宿主本地自然日。** 日界通过 IANA 时区在两个边界上的真实 offset 解析，因此跨 DST 的那一天正确地是 23 或 25 小时。既不是 UTC，也不是浏览器所在时区。
- **开启与活跃。** "开启"指 session header 的 `created_at` 落在当天内；"活跃"指该 session 当天至少拥有一条 event。`sessions.parent_session` 有值即判为 subagent。不使用 `origin` 列，因为在本插件构建时所用的库里它与 `parent_session` 不一致。
- **subagent 分布。** 每个父的计数来自 `parent_session`；preset 来自 session header 的 `agent_preset`，模型来自子 session 自己的 `subagent/descriptor` 事件（`agentProvider`/`agentModel`）。库里没记录的主体报成 `(unknown)`，而不是丢掉。
- **工具。** `tool/call` 与 `tool/result` 各自独立计数。真实库里两者数量不同——被中断的、被派发的调用——所以谁也不是从谁推出来的。
- **速率。** 每个计量结算的净增量加到它落库的那一分钟，再聚到对应的本地小时。`activeMinutes` 是净增量非零的分钟数，`peakPerMinute` 是其中最大的一分钟，`avgPerActiveMinute` 用当天主循环 token 除以 `activeMinutes`。测量口径的限制见"已知限制"。
- **压缩。** `compaction/start` 计压缩次数。`compaction/summary` 是另一次摘要调用，自带 usage 与 model：它真实计费、不进主循环 token 折叠、单独报在 `compaction.summaryTokens`，同时仍计入 `llmCalls`。`compaction/prune` 不调用模型，不计。

## 已知限制

- **本部署里 `cacheWrite` 恒为 0。** 在本插件构建时所用的库里，没有任何 provider 报告过 `cacheWriteTokens`。该字段留在契约里是因为 harness 的投影有它；这里的 0 表示"未上报"，不是"没有缓存"。
- **`reasoning` 稀疏。** 只有部分 provider 单独上报 `reasoningTokens`。当天路由都不上报时这里显示 0，尽管确实花了推理 token。
- **分钟桶量的是"该分钟完成的 token"，不是调用进行中的速率。** 一次结算的全部用量落在它 event 落库的那一分钟里，于是长调用表现为一根尖峰而不是平滑速率，小时桶继承同一偏斜。`spanMinutes` 是首次到末次结算的跨度，不是占空比。
- **`created_at` 是当前 incarnation 的创建时刻。** 被 resume 或带 seed 的 session 可能带着远晚于其首条 event 的创建时间，因此一个算作"今天开启"的 session 里可能包含更早的 event 时间；这两者有意不做互相校验。
- **只支持一种会话后端、一个 schema 版本。** 只有 `user_version = 20` 的 SQLite 库可读。其它后端或升版后的 schema 会在面板里以 `unsupported-schema` 呈现，而不是给出一份报告：reader 宁可响亮失败，也不解码它不认识的格式。
- **一天的首次加载很贵。** 由于 `events.time` 没有索引，扫描会读完整个 `events` 窗口，在多 GB 的库上要几秒。之后该天进入缓存——过去的天无限期保留，当天保留 `cacheTtlMs`——`durationMs` 会给出真实成本；重启后的第一次冷请求要再付一次。
- **总计不含 compaction 摘要 token。** `totals` 与 `byModel` 只是主循环折叠；摘要自身的用量只在 `compaction.summaryTokens` 里。与 provider 账单对账时要把两者相加。

## 开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

`pnpm build` 先跑 `tsc -p tsconfig.build.json`，把声明文件输出到 `lib/types/**`；再跑 `tsdown`，产出两个 bundle：

- `lib/index.js` —— host 半（ESM）；Node 内置模块、cordis、以及所有 `@deepseek-ai/*` 包保持 external，由 profile 解析；
- `lib/client.js` —— 浏览器半，一个 CJS 闭包，通过 `window.__ModuleLoader__.load({ id: 'dsh-token-perf', factory })` 注册，其 `require` 只能解析 shell 的平台模块；其余全部内联，构建期两道纯度闸门会拒绝平台模块表之外的任何 import 或残留 `require()`。

构建随后把 `src/store/zstd-dictionary.bin` 拷成 `lib/zstd-dictionary.bin`，也就是 host 运行时的默认字典路径。

`lib/` 是**有意入库**的。git 安装取的是源码快照、不会跑 `build`，既不提交构建产物又没有可放行的 `prepare` 脚本的包装上去就是加载不了的；提交产物让安装保持一条命令，且安装期不执行任何代码。

`pnpm test` 跑 `tests/` 下的用例。`tests/manifest.spec.ts` 断言打包面——manifest 字段、bundle patch 行、许可证文件、vendored 字典的确切字节——不需要先构建；`tests/integration/real-store.spec.ts` 在 `TOKEN_PERF_STORE` 指向一份库副本时才跑真实库。

## 许可证

Apache-2.0，见 [`LICENSE`](LICENSE)。[`NOTICE`](NOTICE) 载有 vendored 字典的归属声明，[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 记录它的来源、许可证与确切字节。
