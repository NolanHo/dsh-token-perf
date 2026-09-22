/**
 * Copy for the dsh-token-perf settings page.
 *
 * `zh` is the key-set source of truth: it fixes the {@link CopyKey} union, and
 * `en` is checked against that union, so adding a key to one language without
 * the other is a compile error. Both dictionaries are registered into the DSH
 * locale registry as the `dsh-token-perf` namespace; every user-visible string
 * on the page resolves through {@link t}, which reads the active locale from the
 * registered service at call time (the same snapshot the service itself reads,
 * so the two readings cannot diverge).
 * @module dsh-token-perf/client/locales
 */

/** The locale namespace this plugin registers. */
export const LOCALE_NS = 'dsh-token-perf'

/** Simplified Chinese dictionary; its key set defines {@link CopyKey}. */
export const zh = {
  'settings.nav': 'Token 分析',
  'page.title': '单日 Token 与工作流分析',
  'page.subtitle': '数据来自宿主会话数据库，按宿主本地日切分。',

  'header.prev': '前一天',
  'header.next': '后一天',
  'header.today': '今天',
  'header.dateLabel': '日期',
  'header.datePlaceholder': 'YYYY-MM-DD',
  'header.view': '查看',
  'header.refresh': '刷新',
  'header.timezone': '时区 {zone}（{offset}）',
  'header.generated': '生成于 {time}，耗时 {duration}',
  'header.invalidDate': '请输入有效日期（YYYY-MM-DD）。',
  'header.skippedEvents': '另有 {count} 条事件无法解码，未计入任何合计。',

  'state.loading': '正在读取 {date} 的报告…',
  'state.empty.title': '{date} 没有任何活动',
  'state.empty.body': '这一天没有开启或活跃的会话，也没有计量到的模型调用。',

  'error.title': '无法读取当日报告',
  'error.bad-request': '请求的日期无效。请检查日期格式后重试。',
  'error.no-database': '宿主上找不到会话数据库。',
  'error.unsupported-schema': '会话数据库结构不受支持，可能与当前 DSH 版本不匹配。',
  'error.unreadable': '会话数据库无法读取。',
  'error.http': '宿主返回了 HTTP {status}。',
  'error.malformed': '宿主返回了无法解析的响应。',
  'error.network': '无法连接到宿主。',
  'error.hostMessage': '宿主信息：{message}',
  'error.retry': '重试',

  'summary.title': '概览',
  'summary.totalTokens': '总 token',
  'summary.exactCount': '精确 {count}',
  'summary.sessionsOpened': '开启会话',
  'summary.sessionsSplit': '根 {root} · 子代理 {subagent}',
  'summary.sessionsActive': '活跃会话',
  'summary.subagentsOpened': '开启子代理',
  'summary.messages': '消息',
  'summary.messagesSplit': '用户 {user} · 助手 {assistant}',
  'summary.toolCalls': '工具调用',
  'summary.toolResults': '工具结果 {count}',
  'summary.compactions': '上下文压缩',
  'summary.summaryTokens': '摘要 token {count}',
  'summary.llmCalls': '用量结算次数',
  'summary.llmCallsDetail': '助手消息 {assistant}，另含重试与摘要调用',

  'tokens.title': 'Token 构成',
  'tokens.input': '输入',
  'tokens.output': '输出',
  'tokens.cacheRead': '缓存读取',
  'tokens.cacheWrite': '缓存写入',
  'tokens.reasoning': '推理',
  'tokens.unavailable': '本部署不适用',
  'tokens.total': '合计',

  'models.title': '按模型',
  'models.route': 'provider/model',
  'models.calls': '调用',
  'models.total': '合计 token',
  'models.share': '占比',
  'models.empty': '这一天没有计量到的模型调用。',

  'rate.title': '消耗速率（本地小时）',
  'rate.peak': '峰值 {value}/分钟',
  'rate.avg': '活跃分钟均值 {value}/分钟',
  'rate.activeMinutes': '活跃分钟 {count}',
  'rate.span': '首末跨度 {count} 分钟',
  'rate.bar': '{hour}:00 · {tokens} · {calls} 次调用',
  'rate.note': '分钟桶记录的是该分钟完成的用量，不代表该分钟正在消耗的速率。',

  'subagents.title': '子代理',
  'subagents.total': '开启总数',
  'subagents.spawningSessions': '触发的会话',
  'subagents.maxPerSession': '单会话最多',
  'subagents.byPreset': '按 preset',
  'subagents.byModel': '按模型',
  'subagents.entry': '{name} · {count}',
  'subagents.none': '这一天没有开启子代理。',
  'subagents.unrecorded': '未记录',

  'sessions.title': '会话明细',
  'sessions.count': '共 {count} 个会话',
  'sessions.sortBy': '排序',
  'sessions.sortTokens': '按 token',
  'sessions.sortMessages': '按消息',
  'sessions.sortTools': '按工具调用',
  'sessions.showAll': '显示全部 {count} 个',
  'sessions.showLess': '收起',
  'sessions.empty': '这一天没有会话活动。',
  'sessions.colTitle': '标题',
  'sessions.colStart': '开始',
  'sessions.colKind': '类型',
  'sessions.colParent': '父会话',
  'sessions.colSubagents': '子代理',
  'sessions.colMessages': '消息',
  'sessions.colTools': '工具',
  'sessions.colCompactions': '压缩',
  'sessions.colTokens': 'Token',
  'sessions.colModels': '模型',
  'sessions.kindRoot': '根',
  'sessions.kindSubagent': '子代理',
  'sessions.messagesSplit': '用户 {user} / 助手 {assistant}',
  'sessions.toolsSplit': '调用 {calls} / 结果 {results}',
} as const satisfies Record<string, string>

/** The copy key union, fixed by the Chinese dictionary. */
export type CopyKey = keyof typeof zh

/** English dictionary, checked complete against {@link CopyKey}. */
export const en = {
  'settings.nav': 'Token Analytics',
  'page.title': 'Daily token and workflow analytics',
  'page.subtitle': 'Data comes from the host session store, split by the host local day.',

  'header.prev': 'Previous day',
  'header.next': 'Next day',
  'header.today': 'Today',
  'header.dateLabel': 'Date',
  'header.datePlaceholder': 'YYYY-MM-DD',
  'header.view': 'View',
  'header.refresh': 'Refresh',
  'header.timezone': 'Time zone {zone} ({offset})',
  'header.generated': 'Generated {time}, took {duration}',
  'header.invalidDate': 'Enter a valid date (YYYY-MM-DD).',
  'header.skippedEvents': '{count} further events could not be decoded and are in no total.',

  'state.loading': 'Loading the report for {date}…',
  'state.empty.title': 'No activity on {date}',
  'state.empty.body': 'No session was opened or active on this day, and no model call was metered.',

  'error.title': 'Could not load the day report',
  'error.bad-request': 'The requested date is invalid. Check the format and try again.',
  'error.no-database': 'The session database was not found on the host.',
  'error.unsupported-schema': 'The session database schema is unsupported and may not match this DSH build.',
  'error.unreadable': 'The session database could not be read.',
  'error.http': 'The host answered HTTP {status}.',
  'error.malformed': 'The host returned a response that could not be parsed.',
  'error.network': 'The host could not be reached.',
  'error.hostMessage': 'Host message: {message}',
  'error.retry': 'Retry',

  'summary.title': 'Overview',
  'summary.totalTokens': 'Total tokens',
  'summary.exactCount': 'exact {count}',
  'summary.sessionsOpened': 'Sessions opened',
  'summary.sessionsSplit': 'root {root} · subagent {subagent}',
  'summary.sessionsActive': 'Sessions active',
  'summary.subagentsOpened': 'Subagents opened',
  'summary.messages': 'Messages',
  'summary.messagesSplit': 'user {user} · assistant {assistant}',
  'summary.toolCalls': 'Tool calls',
  'summary.toolResults': 'tool results {count}',
  'summary.compactions': 'Compactions',
  'summary.summaryTokens': 'summary tokens {count}',
  'summary.llmCalls': 'Usage settlements',
  'summary.llmCallsDetail': 'assistant messages {assistant}, plus retries and summaries',

  'tokens.title': 'Token composition',
  'tokens.input': 'Input',
  'tokens.output': 'Output',
  'tokens.cacheRead': 'Cache read',
  'tokens.cacheWrite': 'Cache write',
  'tokens.reasoning': 'Reasoning',
  'tokens.unavailable': 'n/a in this deployment',
  'tokens.total': 'Total',

  'models.title': 'By model',
  'models.route': 'provider/model',
  'models.calls': 'Calls',
  'models.total': 'Total tokens',
  'models.share': 'Share',
  'models.empty': 'No model call was metered on this day.',

  'rate.title': 'Consumption rate (local hours)',
  'rate.peak': 'Peak {value}/min',
  'rate.avg': 'Mean per active minute {value}/min',
  'rate.activeMinutes': 'Active minutes {count}',
  'rate.span': 'Span {count} min',
  'rate.bar': '{hour}:00 · {tokens} · {calls} calls',
  'rate.note': 'Minute buckets record what completed in that minute, not the rate being consumed.',

  'subagents.title': 'Subagents',
  'subagents.total': 'Opened',
  'subagents.spawningSessions': 'Spawning sessions',
  'subagents.maxPerSession': 'Max per session',
  'subagents.byPreset': 'By preset',
  'subagents.byModel': 'By model',
  'subagents.entry': '{name} · {count}',
  'subagents.none': 'No subagent was opened on this day.',
  'subagents.unrecorded': 'unrecorded',

  'sessions.title': 'Sessions',
  'sessions.count': '{count} sessions',
  'sessions.sortBy': 'Sort',
  'sessions.sortTokens': 'By tokens',
  'sessions.sortMessages': 'By messages',
  'sessions.sortTools': 'By tool calls',
  'sessions.showAll': 'Show all {count}',
  'sessions.showLess': 'Show fewer',
  'sessions.empty': 'No session activity on this day.',
  'sessions.colTitle': 'Title',
  'sessions.colStart': 'Start',
  'sessions.colKind': 'Kind',
  'sessions.colParent': 'Parent',
  'sessions.colSubagents': 'Subagents',
  'sessions.colMessages': 'Messages',
  'sessions.colTools': 'Tools',
  'sessions.colCompactions': 'Compactions',
  'sessions.colTokens': 'Tokens',
  'sessions.colModels': 'Models',
  'sessions.kindRoot': 'root',
  'sessions.kindSubagent': 'subagent',
  'sessions.messagesSplit': 'user {user} / assistant {assistant}',
  'sessions.toolsSplit': 'calls {calls} / results {results}',
} as const satisfies Record<CopyKey, string>

/** Values a copy key may interpolate into its `{placeholder}` slots. */
export type CopyParams = Record<string, string | number>

/**
 * A copy resolver bound to one locale source: every call takes the key union, so
 * a key missing from the dictionaries cannot reach it.
 */
export type Translator = (key: CopyKey, params?: CopyParams) => string

/** The locale service face this module reads the active locale from. */
export interface LocaleSnapshotSource {
  /**
   * Read the locale registry's current snapshot.
   * @returns the snapshot, whose `active` field names the language in force.
   */
  getSnapshot(): { active: string }
}

/** The attached locale service; undefined until the plugin activates. */
let localeService: LocaleSnapshotSource | undefined

/**
 * Bind the locale service the module-level {@link t} follows.
 * @param service - the service face, or undefined to fall back to the browser
 *   language (the plugin passes undefined on disposal).
 */
export function attachLocale(service: LocaleSnapshotSource | undefined): void {
  localeService = service
}

/**
 * Pick the dictionary for one locale id.
 * @param locale - a BCP-47 language tag or the locale registry's active id.
 * @returns the complete dictionary for that language; English for everything
 *   that does not name Chinese.
 */
export function dictionaryFor(locale: string): Record<CopyKey, string> {
  return locale.toLowerCase().startsWith('zh') ? zh : en
}

/**
 * Build a translator over one locale source.
 * @param active - reads the locale id in force at call time.
 * @returns the typed copy resolver.
 */
export function createTranslator(active: () => string): Translator {
  return (key, params) => interpolate(dictionaryFor(active())[key], params)
}

/**
 * Translate a copy key in the active locale.
 * @param key - the copy key.
 * @param params - values for the key's `{placeholder}` slots.
 * @returns the translated string.
 */
export function t(key: CopyKey, params?: CopyParams): string {
  return interpolate(dictionaryFor(activeLocale())[key], params)
}

/** The locale the module-level {@link t} resolves against. */
function activeLocale(): string {
  if (localeService !== undefined) return localeService.getSnapshot().active
  return typeof navigator !== 'undefined' ? navigator.language : 'en'
}

/**
 * Fill one template's `{placeholder}` slots.
 * @param template - the dictionary entry.
 * @param params - supplied values; a slot with no value keeps its literal
 *   `{name}`, which makes a wrong call site visible instead of printing
 *   `undefined`.
 * @returns the filled string.
 */
function interpolate(template: string, params?: CopyParams): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}
