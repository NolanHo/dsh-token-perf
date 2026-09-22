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
export declare const LOCALE_NS = "dsh-token-perf";
/** Simplified Chinese dictionary; its key set defines {@link CopyKey}. */
export declare const zh: {
    readonly 'settings.nav': "Token 分析";
    readonly 'page.title': "单日 Token 与工作流分析";
    readonly 'page.subtitle': "数据来自宿主会话数据库，按宿主本地日切分。";
    readonly 'header.prev': "前一天";
    readonly 'header.next': "后一天";
    readonly 'header.today': "今天";
    readonly 'header.dateLabel': "日期";
    readonly 'header.datePlaceholder': "YYYY-MM-DD";
    readonly 'header.view': "查看";
    readonly 'header.refresh': "刷新";
    readonly 'header.timezone': "时区 {zone}（{offset}）";
    readonly 'header.generated': "生成于 {time}，耗时 {duration}";
    readonly 'header.invalidDate': "请输入有效日期（YYYY-MM-DD）。";
    readonly 'state.loading': "正在读取 {date} 的报告…";
    readonly 'state.empty.title': "{date} 没有任何活动";
    readonly 'state.empty.body': "这一天没有开启或活跃的会话，也没有计量到的模型调用。";
    readonly 'error.title': "无法读取当日报告";
    readonly 'error.bad-request': "请求的日期无效。请检查日期格式后重试。";
    readonly 'error.no-database': "宿主上找不到会话数据库。";
    readonly 'error.unsupported-schema': "会话数据库结构不受支持，可能与当前 DSH 版本不匹配。";
    readonly 'error.unreadable': "会话数据库无法读取。";
    readonly 'error.http': "宿主返回了 HTTP {status}。";
    readonly 'error.malformed': "宿主返回了无法解析的响应。";
    readonly 'error.network': "无法连接到宿主。";
    readonly 'error.hostMessage': "宿主信息：{message}";
    readonly 'error.retry': "重试";
    readonly 'summary.title': "概览";
    readonly 'summary.totalTokens': "总 token";
    readonly 'summary.exactCount': "精确 {count}";
    readonly 'summary.sessionsOpened': "开启会话";
    readonly 'summary.sessionsSplit': "根 {root} · 子代理 {subagent}";
    readonly 'summary.sessionsActive': "活跃会话";
    readonly 'summary.subagentsOpened': "开启子代理";
    readonly 'summary.messages': "消息";
    readonly 'summary.messagesSplit': "用户 {user} · 助手 {assistant}";
    readonly 'summary.toolCalls': "工具调用";
    readonly 'summary.toolResults': "工具结果 {count}";
    readonly 'summary.compactions': "上下文压缩";
    readonly 'summary.summaryTokens': "摘要 token {count}";
    readonly 'summary.llmCalls': "模型调用（计量）";
    readonly 'tokens.title': "Token 构成";
    readonly 'tokens.input': "输入";
    readonly 'tokens.output': "输出";
    readonly 'tokens.cacheRead': "缓存读取";
    readonly 'tokens.cacheWrite': "缓存写入";
    readonly 'tokens.reasoning': "推理";
    readonly 'tokens.unavailable': "本部署不适用";
    readonly 'tokens.total': "合计";
    readonly 'models.title': "按模型";
    readonly 'models.route': "provider/model";
    readonly 'models.calls': "调用";
    readonly 'models.total': "合计 token";
    readonly 'models.share': "占比";
    readonly 'models.empty': "这一天没有计量到的模型调用。";
    readonly 'rate.title': "消耗速率（本地小时）";
    readonly 'rate.peak': "峰值 {value}/分钟";
    readonly 'rate.avg': "活跃分钟均值 {value}/分钟";
    readonly 'rate.activeMinutes': "活跃分钟 {count}";
    readonly 'rate.span': "首末跨度 {count} 分钟";
    readonly 'rate.bar': "{hour}:00 · {tokens} · {calls} 次调用";
    readonly 'rate.note': "分钟桶记录的是该分钟完成的用量，不代表该分钟正在消耗的速率。";
    readonly 'subagents.title': "子代理";
    readonly 'subagents.total': "开启总数";
    readonly 'subagents.spawningSessions': "触发的会话";
    readonly 'subagents.maxPerSession': "单会话最多";
    readonly 'subagents.byPreset': "按 preset";
    readonly 'subagents.byModel': "按模型";
    readonly 'subagents.entry': "{name} · {count}";
    readonly 'subagents.none': "这一天没有开启子代理。";
    readonly 'subagents.unrecorded': "未记录";
    readonly 'sessions.title': "会话明细";
    readonly 'sessions.count': "共 {count} 个会话";
    readonly 'sessions.sortBy': "排序";
    readonly 'sessions.sortTokens': "按 token";
    readonly 'sessions.sortMessages': "按消息";
    readonly 'sessions.sortTools': "按工具调用";
    readonly 'sessions.showAll': "显示全部 {count} 个";
    readonly 'sessions.showLess': "收起";
    readonly 'sessions.empty': "这一天没有会话活动。";
    readonly 'sessions.colTitle': "标题";
    readonly 'sessions.colStart': "开始";
    readonly 'sessions.colKind': "类型";
    readonly 'sessions.colParent': "父会话";
    readonly 'sessions.colSubagents': "子代理";
    readonly 'sessions.colMessages': "消息";
    readonly 'sessions.colTools': "工具";
    readonly 'sessions.colCompactions': "压缩";
    readonly 'sessions.colTokens': "Token";
    readonly 'sessions.colModels': "模型";
    readonly 'sessions.kindRoot': "根";
    readonly 'sessions.kindSubagent': "子代理";
    readonly 'sessions.messagesSplit': "用户 {user} / 助手 {assistant}";
    readonly 'sessions.toolsSplit': "调用 {calls} / 结果 {results}";
};
/** The copy key union, fixed by the Chinese dictionary. */
export type CopyKey = keyof typeof zh;
/** English dictionary, checked complete against {@link CopyKey}. */
export declare const en: {
    readonly 'settings.nav': "Token Analytics";
    readonly 'page.title': "Daily token and workflow analytics";
    readonly 'page.subtitle': "Data comes from the host session store, split by the host local day.";
    readonly 'header.prev': "Previous day";
    readonly 'header.next': "Next day";
    readonly 'header.today': "Today";
    readonly 'header.dateLabel': "Date";
    readonly 'header.datePlaceholder': "YYYY-MM-DD";
    readonly 'header.view': "View";
    readonly 'header.refresh': "Refresh";
    readonly 'header.timezone': "Time zone {zone} ({offset})";
    readonly 'header.generated': "Generated {time}, took {duration}";
    readonly 'header.invalidDate': "Enter a valid date (YYYY-MM-DD).";
    readonly 'state.loading': "Loading the report for {date}…";
    readonly 'state.empty.title': "No activity on {date}";
    readonly 'state.empty.body': "No session was opened or active on this day, and no model call was metered.";
    readonly 'error.title': "Could not load the day report";
    readonly 'error.bad-request': "The requested date is invalid. Check the format and try again.";
    readonly 'error.no-database': "The session database was not found on the host.";
    readonly 'error.unsupported-schema': "The session database schema is unsupported and may not match this DSH build.";
    readonly 'error.unreadable': "The session database could not be read.";
    readonly 'error.http': "The host answered HTTP {status}.";
    readonly 'error.malformed': "The host returned a response that could not be parsed.";
    readonly 'error.network': "The host could not be reached.";
    readonly 'error.hostMessage': "Host message: {message}";
    readonly 'error.retry': "Retry";
    readonly 'summary.title': "Overview";
    readonly 'summary.totalTokens': "Total tokens";
    readonly 'summary.exactCount': "exact {count}";
    readonly 'summary.sessionsOpened': "Sessions opened";
    readonly 'summary.sessionsSplit': "root {root} · subagent {subagent}";
    readonly 'summary.sessionsActive': "Sessions active";
    readonly 'summary.subagentsOpened': "Subagents opened";
    readonly 'summary.messages': "Messages";
    readonly 'summary.messagesSplit': "user {user} · assistant {assistant}";
    readonly 'summary.toolCalls': "Tool calls";
    readonly 'summary.toolResults': "tool results {count}";
    readonly 'summary.compactions': "Compactions";
    readonly 'summary.summaryTokens': "summary tokens {count}";
    readonly 'summary.llmCalls': "Metered model calls";
    readonly 'tokens.title': "Token composition";
    readonly 'tokens.input': "Input";
    readonly 'tokens.output': "Output";
    readonly 'tokens.cacheRead': "Cache read";
    readonly 'tokens.cacheWrite': "Cache write";
    readonly 'tokens.reasoning': "Reasoning";
    readonly 'tokens.unavailable': "n/a in this deployment";
    readonly 'tokens.total': "Total";
    readonly 'models.title': "By model";
    readonly 'models.route': "provider/model";
    readonly 'models.calls': "Calls";
    readonly 'models.total': "Total tokens";
    readonly 'models.share': "Share";
    readonly 'models.empty': "No model call was metered on this day.";
    readonly 'rate.title': "Consumption rate (local hours)";
    readonly 'rate.peak': "Peak {value}/min";
    readonly 'rate.avg': "Mean per active minute {value}/min";
    readonly 'rate.activeMinutes': "Active minutes {count}";
    readonly 'rate.span': "Span {count} min";
    readonly 'rate.bar': "{hour}:00 · {tokens} · {calls} calls";
    readonly 'rate.note': "Minute buckets record what completed in that minute, not the rate being consumed.";
    readonly 'subagents.title': "Subagents";
    readonly 'subagents.total': "Opened";
    readonly 'subagents.spawningSessions': "Spawning sessions";
    readonly 'subagents.maxPerSession': "Max per session";
    readonly 'subagents.byPreset': "By preset";
    readonly 'subagents.byModel': "By model";
    readonly 'subagents.entry': "{name} · {count}";
    readonly 'subagents.none': "No subagent was opened on this day.";
    readonly 'subagents.unrecorded': "unrecorded";
    readonly 'sessions.title': "Sessions";
    readonly 'sessions.count': "{count} sessions";
    readonly 'sessions.sortBy': "Sort";
    readonly 'sessions.sortTokens': "By tokens";
    readonly 'sessions.sortMessages': "By messages";
    readonly 'sessions.sortTools': "By tool calls";
    readonly 'sessions.showAll': "Show all {count}";
    readonly 'sessions.showLess': "Show fewer";
    readonly 'sessions.empty': "No session activity on this day.";
    readonly 'sessions.colTitle': "Title";
    readonly 'sessions.colStart': "Start";
    readonly 'sessions.colKind': "Kind";
    readonly 'sessions.colParent': "Parent";
    readonly 'sessions.colSubagents': "Subagents";
    readonly 'sessions.colMessages': "Messages";
    readonly 'sessions.colTools': "Tools";
    readonly 'sessions.colCompactions': "Compactions";
    readonly 'sessions.colTokens': "Tokens";
    readonly 'sessions.colModels': "Models";
    readonly 'sessions.kindRoot': "root";
    readonly 'sessions.kindSubagent': "subagent";
    readonly 'sessions.messagesSplit': "user {user} / assistant {assistant}";
    readonly 'sessions.toolsSplit': "calls {calls} / results {results}";
};
/** Values a copy key may interpolate into its `{placeholder}` slots. */
export type CopyParams = Record<string, string | number>;
/**
 * A copy resolver bound to one locale source: every call takes the key union, so
 * a key missing from the dictionaries cannot reach it.
 */
export type Translator = (key: CopyKey, params?: CopyParams) => string;
/** The locale service face this module reads the active locale from. */
export interface LocaleSnapshotSource {
    /**
     * Read the locale registry's current snapshot.
     * @returns the snapshot, whose `active` field names the language in force.
     */
    getSnapshot(): {
        active: string;
    };
}
/**
 * Bind the locale service the module-level {@link t} follows.
 * @param service - the service face, or undefined to fall back to the browser
 *   language (the plugin passes undefined on disposal).
 */
export declare function attachLocale(service: LocaleSnapshotSource | undefined): void;
/**
 * Pick the dictionary for one locale id.
 * @param locale - a BCP-47 language tag or the locale registry's active id.
 * @returns the complete dictionary for that language; English for everything
 *   that does not name Chinese.
 */
export declare function dictionaryFor(locale: string): Record<CopyKey, string>;
/**
 * Build a translator over one locale source.
 * @param active - reads the locale id in force at call time.
 * @returns the typed copy resolver.
 */
export declare function createTranslator(active: () => string): Translator;
/**
 * Translate a copy key in the active locale.
 * @param key - the copy key.
 * @param params - values for the key's `{placeholder}` slots.
 * @returns the translated string.
 */
export declare function t(key: CopyKey, params?: CopyParams): string;
