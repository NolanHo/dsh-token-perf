window.__ModuleLoader__.load({
	id: "dsh-token-perf",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/aggregate/day.ts
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
		//#region src/client/format.ts
		const COUNT_SCALES = [
			{
				threshold: 1e9,
				suffix: "B",
				decimals: 2
			},
			{
				threshold: 1e6,
				suffix: "M",
				decimals: 2
			},
			{
				threshold: 1e3,
				suffix: "k",
				decimals: 1
			}
		];
		const MILLISECONDS_PER_DAY = 864e5;
		const MILLISECONDS_PER_SECOND = 1e3;
		const MINUTES_PER_HOUR = 60;
		/**
		* Sum the five provider buckets.
		*
		* This is the panel's "total token" reading. It is also the denominator of the
		* composition bar, so a total of zero must stay representable rather than
		* throwing or dividing.
		* @param buckets - the five provider-reported buckets.
		* @returns the summed token count.
		*/
		function totalTokens(buckets) {
			return buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite + buckets.reasoning;
		}
		/**
		* Format a token count compactly: `942`, `12.3k`, `4.5M`, `1.23B`.
		* @param value - token count.
		* @returns the compact reading, rounded to one or two decimals per scale.
		*/
		function compactCount(value) {
			const magnitude = Math.abs(value);
			let index = COUNT_SCALES.findIndex((scale) => magnitude >= scale.threshold);
			if (index < 0) return String(Math.round(value));
			let scale = COUNT_SCALES[index];
			let scaled = Number((value / scale.threshold).toFixed(scale.decimals));
			while (Math.abs(scaled) >= 1e3 && index > 0) {
				index -= 1;
				scale = COUNT_SCALES[index];
				scaled = Number((value / scale.threshold).toFixed(scale.decimals));
			}
			return `${trimTrailingZeros(scaled.toFixed(scale.decimals))}${scale.suffix}`;
		}
		/**
		* Format an exact count with thousands separators: `1,234,567`.
		* @param value - token, message, or session count.
		* @returns the grouped digits.
		*/
		function exactCount(value) {
			const rounded = Math.round(value);
			const grouped = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
			return rounded < 0 ? `-${grouped}` : grouped;
		}
		/**
		* One value's share of a total, as a percentage in `[0, 100]`.
		*
		* A zero or negative total has no shares: every part reads zero rather than
		* `NaN`, which is what a bar width must receive.
		* @param part - the value being measured.
		* @param total - the day-wide denominator.
		* @returns the share in percent.
		*/
		function sharePercent(part, total) {
			if (!(total > 0) || !(part > 0)) return 0;
			return Math.min(100, part / total * 100);
		}
		/**
		* Format one value's share of a total: `93.3%`.
		* @param part - the value being measured.
		* @param total - the day-wide denominator.
		* @returns the percentage label; `<0.1%` for a part too small to round to it.
		*/
		function percentLabel(part, total) {
			if (!(total > 0) || !(part > 0)) return "0%";
			const percent = part / total * 100;
			if (percent < .1) return "<0.1%";
			return `${percent.toFixed(1)}%`;
		}
		/**
		* Two-digit label for one local hour of the rate chart.
		* @param hour - hour of day, 0 through 23.
		* @returns the zero-padded hour.
		*/
		function hourLabel(hour) {
			return String(hour).padStart(2, "0");
		}
		/**
		* Move one `YYYY-MM-DD` day key by whole days.
		*
		* Calendar arithmetic on the key itself: the result is zone-independent, so
		* stepping across a DST transition never lands on a repeated or skipped day.
		* @param date - a well-formed `YYYY-MM-DD` key.
		* @param days - signed number of days to add.
		* @returns the shifted key.
		*/
		function shiftDayKey(date, days) {
			const [year, month, day] = date.split("-").map(Number);
			const shifted = new Date(Date.UTC(year, month - 1, day) + days * MILLISECONDS_PER_DAY);
			const part = (value, width) => String(value).padStart(width, "0");
			return `${part(shifted.getUTCFullYear(), 4)}-${part(shifted.getUTCMonth() + 1, 2)}-${part(shifted.getUTCDate(), 2)}`;
		}
		/**
		* Render one instant as `YYYY-MM-DD HH:mm` in one zone.
		* @param timeMs - epoch milliseconds.
		* @param timeZone - IANA zone the reading is taken in.
		* @returns the zoned reading; the UTC reading when this runtime does not know
		*   the zone the host reported.
		*/
		function formatZoneTime(timeMs, timeZone) {
			try {
				const parts = new Intl.DateTimeFormat("en-US", {
					timeZone,
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hourCycle: "h23"
				}).formatToParts(new Date(timeMs));
				const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
				return `${read("year").padStart(4, "0")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
			} catch {
				return `${new Date(timeMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
			}
		}
		/**
		* Render a zone's offset from UTC: `UTC-07:00`.
		* @param offsetMinutes - minutes east of UTC at the day's start.
		* @returns the offset label.
		*/
		function formatUtcOffset(offsetMinutes) {
			const sign = offsetMinutes < 0 ? "-" : "+";
			const magnitude = Math.abs(offsetMinutes);
			return `UTC${sign}${String(Math.floor(magnitude / MINUTES_PER_HOUR)).padStart(2, "0")}:${String(magnitude % MINUTES_PER_HOUR).padStart(2, "0")}`;
		}
		/**
		* Render a wall-clock duration: `840 ms`, `1.2 s`.
		* @param durationMs - elapsed milliseconds.
		* @returns the duration label.
		*/
		function formatDuration(durationMs) {
			if (!(durationMs >= MILLISECONDS_PER_SECOND)) return `${Math.round(durationMs)} ms`;
			return `${(durationMs / MILLISECONDS_PER_SECOND).toFixed(1)} s`;
		}
		/**
		* Drop the fraction of a fixed-point reading when it is all zeros.
		* @param text - a `toFixed` result.
		* @returns `4.50` as `4.5`, `12.0` as `12`, and a whole number unchanged.
		*/
		function trimTrailingZeros(text) {
			if (!text.includes(".")) return text;
			return text.replace(/\.?0+$/, "");
		}
		//#endregion
		//#region src/client/locales.ts
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
		const LOCALE_NS = "dsh-token-perf";
		/** Simplified Chinese dictionary; its key set defines {@link CopyKey}. */
		const zh = {
			"settings.nav": "Token 分析",
			"page.title": "单日 Token 与工作流分析",
			"page.subtitle": "数据来自宿主会话数据库，按宿主本地日切分。",
			"header.prev": "前一天",
			"header.next": "后一天",
			"header.today": "今天",
			"header.dateLabel": "日期",
			"header.datePlaceholder": "YYYY-MM-DD",
			"header.view": "查看",
			"header.refresh": "刷新",
			"header.timezone": "时区 {zone}（{offset}）",
			"header.generated": "生成于 {time}，耗时 {duration}",
			"header.invalidDate": "请输入有效日期（YYYY-MM-DD）。",
			"header.skippedEvents": "另有 {count} 条事件无法解码，未计入任何合计。",
			"state.loading": "正在读取 {date} 的报告…",
			"state.empty.title": "{date} 没有任何活动",
			"state.empty.body": "这一天没有开启或活跃的会话，也没有计量到的模型调用。",
			"error.title": "无法读取当日报告",
			"error.bad-request": "请求的日期无效。请检查日期格式后重试。",
			"error.no-database": "宿主上找不到会话数据库。",
			"error.unsupported-schema": "会话数据库结构不受支持，可能与当前 DSH 版本不匹配。",
			"error.unreadable": "会话数据库无法读取。",
			"error.http": "宿主返回了 HTTP {status}。",
			"error.malformed": "宿主返回了无法解析的响应。",
			"error.network": "无法连接到宿主。",
			"error.hostMessage": "宿主信息：{message}",
			"error.retry": "重试",
			"summary.title": "概览",
			"summary.totalTokens": "总 token",
			"summary.exactCount": "精确 {count}",
			"summary.sessionsOpened": "开启会话",
			"summary.sessionsSplit": "根 {root} · 子代理 {subagent}",
			"summary.sessionsActive": "活跃会话",
			"summary.subagentsOpened": "开启子代理",
			"summary.messages": "消息",
			"summary.messagesSplit": "用户 {user} · 助手 {assistant}",
			"summary.toolCalls": "工具调用",
			"summary.toolResults": "工具结果 {count}",
			"summary.compactions": "上下文压缩",
			"summary.summaryTokens": "摘要 token {count}",
			"summary.llmCalls": "用量结算次数",
			"summary.llmCallsDetail": "助手消息 {assistant}，另含重试与摘要调用",
			"tokens.title": "Token 构成",
			"tokens.input": "输入",
			"tokens.output": "输出",
			"tokens.cacheRead": "缓存读取",
			"tokens.cacheWrite": "缓存写入",
			"tokens.reasoning": "推理",
			"tokens.unavailable": "本部署不适用",
			"tokens.total": "合计",
			"models.title": "按模型",
			"models.route": "provider/model",
			"models.calls": "调用",
			"models.total": "合计 token",
			"models.share": "占比",
			"models.empty": "这一天没有计量到的模型调用。",
			"rate.title": "消耗速率（本地小时）",
			"rate.peak": "峰值 {value}/分钟",
			"rate.avg": "活跃分钟均值 {value}/分钟",
			"rate.activeMinutes": "活跃分钟 {count}",
			"rate.span": "首末跨度 {count} 分钟",
			"rate.bar": "{hour}:00 · {tokens} · {calls} 次调用",
			"rate.note": "分钟桶记录的是该分钟完成的用量，不代表该分钟正在消耗的速率。",
			"subagents.title": "子代理",
			"subagents.total": "开启总数",
			"subagents.spawningSessions": "触发的会话",
			"subagents.maxPerSession": "单会话最多",
			"subagents.byPreset": "按 preset",
			"subagents.byModel": "按模型",
			"subagents.entry": "{name} · {count}",
			"subagents.none": "这一天没有开启子代理。",
			"subagents.unrecorded": "未记录",
			"sessions.title": "会话明细",
			"sessions.count": "共 {count} 个会话",
			"sessions.sortBy": "排序",
			"sessions.sortTokens": "按 token",
			"sessions.sortMessages": "按消息",
			"sessions.sortTools": "按工具调用",
			"sessions.showAll": "显示全部 {count} 个",
			"sessions.showLess": "收起",
			"sessions.empty": "这一天没有会话活动。",
			"sessions.colTitle": "标题",
			"sessions.colStart": "开始",
			"sessions.colKind": "类型",
			"sessions.colParent": "父会话",
			"sessions.colSubagents": "子代理",
			"sessions.colMessages": "消息",
			"sessions.colTools": "工具",
			"sessions.colCompactions": "压缩",
			"sessions.colTokens": "Token",
			"sessions.colModels": "模型",
			"sessions.kindRoot": "根",
			"sessions.kindSubagent": "子代理",
			"sessions.messagesSplit": "用户 {user} / 助手 {assistant}",
			"sessions.toolsSplit": "调用 {calls} / 结果 {results}"
		};
		/** English dictionary, checked complete against {@link CopyKey}. */
		const en = {
			"settings.nav": "Token Analytics",
			"page.title": "Daily token and workflow analytics",
			"page.subtitle": "Data comes from the host session store, split by the host local day.",
			"header.prev": "Previous day",
			"header.next": "Next day",
			"header.today": "Today",
			"header.dateLabel": "Date",
			"header.datePlaceholder": "YYYY-MM-DD",
			"header.view": "View",
			"header.refresh": "Refresh",
			"header.timezone": "Time zone {zone} ({offset})",
			"header.generated": "Generated {time}, took {duration}",
			"header.invalidDate": "Enter a valid date (YYYY-MM-DD).",
			"header.skippedEvents": "{count} further events could not be decoded and are in no total.",
			"state.loading": "Loading the report for {date}…",
			"state.empty.title": "No activity on {date}",
			"state.empty.body": "No session was opened or active on this day, and no model call was metered.",
			"error.title": "Could not load the day report",
			"error.bad-request": "The requested date is invalid. Check the format and try again.",
			"error.no-database": "The session database was not found on the host.",
			"error.unsupported-schema": "The session database schema is unsupported and may not match this DSH build.",
			"error.unreadable": "The session database could not be read.",
			"error.http": "The host answered HTTP {status}.",
			"error.malformed": "The host returned a response that could not be parsed.",
			"error.network": "The host could not be reached.",
			"error.hostMessage": "Host message: {message}",
			"error.retry": "Retry",
			"summary.title": "Overview",
			"summary.totalTokens": "Total tokens",
			"summary.exactCount": "exact {count}",
			"summary.sessionsOpened": "Sessions opened",
			"summary.sessionsSplit": "root {root} · subagent {subagent}",
			"summary.sessionsActive": "Sessions active",
			"summary.subagentsOpened": "Subagents opened",
			"summary.messages": "Messages",
			"summary.messagesSplit": "user {user} · assistant {assistant}",
			"summary.toolCalls": "Tool calls",
			"summary.toolResults": "tool results {count}",
			"summary.compactions": "Compactions",
			"summary.summaryTokens": "summary tokens {count}",
			"summary.llmCalls": "Usage settlements",
			"summary.llmCallsDetail": "assistant messages {assistant}, plus retries and summaries",
			"tokens.title": "Token composition",
			"tokens.input": "Input",
			"tokens.output": "Output",
			"tokens.cacheRead": "Cache read",
			"tokens.cacheWrite": "Cache write",
			"tokens.reasoning": "Reasoning",
			"tokens.unavailable": "n/a in this deployment",
			"tokens.total": "Total",
			"models.title": "By model",
			"models.route": "provider/model",
			"models.calls": "Calls",
			"models.total": "Total tokens",
			"models.share": "Share",
			"models.empty": "No model call was metered on this day.",
			"rate.title": "Consumption rate (local hours)",
			"rate.peak": "Peak {value}/min",
			"rate.avg": "Mean per active minute {value}/min",
			"rate.activeMinutes": "Active minutes {count}",
			"rate.span": "Span {count} min",
			"rate.bar": "{hour}:00 · {tokens} · {calls} calls",
			"rate.note": "Minute buckets record what completed in that minute, not the rate being consumed.",
			"subagents.title": "Subagents",
			"subagents.total": "Opened",
			"subagents.spawningSessions": "Spawning sessions",
			"subagents.maxPerSession": "Max per session",
			"subagents.byPreset": "By preset",
			"subagents.byModel": "By model",
			"subagents.entry": "{name} · {count}",
			"subagents.none": "No subagent was opened on this day.",
			"subagents.unrecorded": "unrecorded",
			"sessions.title": "Sessions",
			"sessions.count": "{count} sessions",
			"sessions.sortBy": "Sort",
			"sessions.sortTokens": "By tokens",
			"sessions.sortMessages": "By messages",
			"sessions.sortTools": "By tool calls",
			"sessions.showAll": "Show all {count}",
			"sessions.showLess": "Show fewer",
			"sessions.empty": "No session activity on this day.",
			"sessions.colTitle": "Title",
			"sessions.colStart": "Start",
			"sessions.colKind": "Kind",
			"sessions.colParent": "Parent",
			"sessions.colSubagents": "Subagents",
			"sessions.colMessages": "Messages",
			"sessions.colTools": "Tools",
			"sessions.colCompactions": "Compactions",
			"sessions.colTokens": "Tokens",
			"sessions.colModels": "Models",
			"sessions.kindRoot": "root",
			"sessions.kindSubagent": "subagent",
			"sessions.messagesSplit": "user {user} / assistant {assistant}",
			"sessions.toolsSplit": "calls {calls} / results {results}"
		};
		/** The attached locale service; undefined until the plugin activates. */
		let localeService;
		/**
		* Bind the locale service the module-level {@link t} follows.
		* @param service - the service face, or undefined to fall back to the browser
		*   language (the plugin passes undefined on disposal).
		*/
		function attachLocale(service) {
			localeService = service;
		}
		/**
		* Pick the dictionary for one locale id.
		* @param locale - a BCP-47 language tag or the locale registry's active id.
		* @returns the complete dictionary for that language; English for everything
		*   that does not name Chinese.
		*/
		function dictionaryFor(locale) {
			return locale.toLowerCase().startsWith("zh") ? zh : en;
		}
		/**
		* Translate a copy key in the active locale.
		* @param key - the copy key.
		* @param params - values for the key's `{placeholder}` slots.
		* @returns the translated string.
		*/
		function t(key, params) {
			return interpolate(dictionaryFor(activeLocale())[key], params);
		}
		/** The locale the module-level {@link t} resolves against. */
		function activeLocale() {
			if (localeService !== void 0) return localeService.getSnapshot().active;
			return typeof navigator !== "undefined" ? navigator.language : "en";
		}
		/**
		* Fill one template's `{placeholder}` slots.
		* @param template - the dictionary entry.
		* @param params - supplied values; a slot with no value keeps its literal
		*   `{name}`, which makes a wrong call site visible instead of printing
		*   `undefined`.
		* @returns the filled string.
		*/
		function interpolate(template, params) {
			if (params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => {
				const value = params[name];
				return value === void 0 ? match : String(value);
			});
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Style tag for the dsh-token-perf settings page.
		*
		* The client module system has no CSS build step, so the rules live in one
		* string installed as a `<style data-plugin-css="dsh-token-perf">` element by
		* the activation effect (never a CSS import, which the bundle purity gate
		* rejects). Selectors are literal and scoped by {@link PREFIX}; every color,
		* border, and font rides the shared `--dsw-*` tokens so the page follows the
		* active theme.
		* @module dsh-token-perf/client/styles
		*/
		/** Class-name prefix; every selector this plugin owns starts with it. */
		const PREFIX = "dstp";
		/** `data-plugin-css` ownership key: identifies the one style tag this plugin installs. */
		const STYLE_ID = "dsh-token-perf";
		const RULES = `
.${PREFIX}-page {
  display: flex; flex-direction: column; gap: 14px;
  width: 100%; max-width: 1100px;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
  font-size: var(--dsw-font-xs-13, 13px);
  line-height: 20px;
}
.${PREFIX}-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600; }
.${PREFIX}-subtitle { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-heading { display: flex; flex-direction: column; }

.${PREFIX}-header {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.${PREFIX}-nav { display: flex; align-items: center; gap: 6px; }
.${PREFIX}-dateForm { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.${PREFIX}-label { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-input {
  width: 132px; height: 28px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 6px;
  padding: 0 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.${PREFIX}-input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary);
}
.${PREFIX}-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.${PREFIX}-meta { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12, 12px); }
.${PREFIX}-invalid { margin: 0; color: var(--dsw-alias-state-error-primary); }

.${PREFIX}-button {
  height: 28px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 6px;
  padding: 0 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  cursor: pointer;
}
.${PREFIX}-button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-buttonActive {
  border-color: var(--dsw-alias-state-business-primary);
  color: var(--dsw-alias-state-business-primary);
}

.${PREFIX}-body { display: flex; flex-direction: column; gap: 16px; }
.${PREFIX}-section {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.${PREFIX}-sectionTitle { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
.${PREFIX}-note { margin: 0; color: var(--dsw-alias-label-tertiary); }

.${PREFIX}-cards {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px; margin: 0; padding: 0; list-style: none;
}
.${PREFIX}-card {
  display: flex; flex-direction: column; gap: 2px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.${PREFIX}-cardTitle { color: var(--dsw-alias-label-tertiary); font-size: var(--dsw-font-xxs-12, 12px); }
.${PREFIX}-cardValue { font-size: 18px; line-height: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.${PREFIX}-cardDetail { color: var(--dsw-alias-label-secondary); font-size: var(--dsw-font-xxs-12, 12px); font-variant-numeric: tabular-nums; }

.${PREFIX}-bar {
  display: flex; width: 100%; height: 12px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-3);
}
.${PREFIX}-barSegment { display: block; height: 100%; min-width: 1px; }
.${PREFIX}-barSegment[data-bucket='input'] { background: var(--dsw-alias-state-business-primary); }
.${PREFIX}-barSegment[data-bucket='output'] { background: var(--dsw-alias-state-success-primary); }
.${PREFIX}-barSegment[data-bucket='cacheRead'] { background: var(--dsw-alias-brand-primary); }
.${PREFIX}-barSegment[data-bucket='cacheWrite'] { background: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-barSegment[data-bucket='reasoning'] { background: var(--dsw-alias-state-error-primary); }
.${PREFIX}-barEmpty { background: var(--dsw-alias-border-l2); }

.${PREFIX}-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.${PREFIX}-row { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-rowLabel { flex: 1; min-width: 0; }
.${PREFIX}-rowValue { font-variant-numeric: tabular-nums; }
.${PREFIX}-rowShare { width: 64px; text-align: right; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.${PREFIX}-rowLabel[data-bucket]::before {
  content: ''; display: inline-block; width: 8px; height: 8px; margin-right: 6px;
  border-radius: 2px; background: var(--dsw-alias-border-l2); vertical-align: middle;
}
.${PREFIX}-rowLabel[data-bucket='input']::before { background: var(--dsw-alias-state-business-primary); }
.${PREFIX}-rowLabel[data-bucket='output']::before { background: var(--dsw-alias-state-success-primary); }
.${PREFIX}-rowLabel[data-bucket='cacheRead']::before { background: var(--dsw-alias-brand-primary); }
.${PREFIX}-rowLabel[data-bucket='cacheWrite']::before { background: var(--dsw-alias-state-warn-primary); }
.${PREFIX}-rowLabel[data-bucket='reasoning']::before { background: var(--dsw-alias-state-error-primary); }

.${PREFIX}-chart {
  display: grid; grid-template-columns: repeat(24, minmax(0, 1fr));
  align-items: end; gap: 2px;
  height: 96px;
  padding-top: 4px;
}
.${PREFIX}-column { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
.${PREFIX}-columnFill {
  display: block; width: 100%; min-height: 1px;
  border-radius: 2px 2px 0 0;
  background: var(--dsw-alias-state-business-primary);
}
.${PREFIX}-columnAxis {
  margin-top: 4px; text-align: center;
  color: var(--dsw-alias-label-tertiary); font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.${PREFIX}-stats { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 0; list-style: none; }
.${PREFIX}-stats li { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }

.${PREFIX}-breakdowns { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.${PREFIX}-breakdown { display: flex; flex-direction: column; gap: 4px; }
.${PREFIX}-breakdownTitle { margin: 0; font-size: 13px; line-height: 20px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.${PREFIX}-breakdownBar { display: block; width: 96px; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-3); }
.${PREFIX}-breakdownFill { display: block; height: 100%; border-radius: 3px; background: var(--dsw-alias-state-business-primary); }

.${PREFIX}-scroll { overflow-x: auto; }
.${PREFIX}-table { width: 100%; border-collapse: collapse; }
.${PREFIX}-table th, .${PREFIX}-table td {
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1);
}
.${PREFIX}-table th { color: var(--dsw-alias-label-tertiary); font-weight: 500; }
.${PREFIX}-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-num { text-align: right; font-variant-numeric: tabular-nums; }
.${PREFIX}-titleCell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.${PREFIX}-route { font-family: var(--dsw-font-family, monospace); }
.${PREFIX}-id { color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-models { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-badge {
  display: inline-block; padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 18px;
}
.${PREFIX}-badge[data-origin='subagent'] {
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-brand-primary);
}
.${PREFIX}-sort { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.${PREFIX}-loading, .${PREFIX}-empty { color: var(--dsw-alias-label-secondary); }
.${PREFIX}-empty {
  display: flex; flex-direction: column; gap: 6px;
  padding: 20px 12px;
  border: 0.5px dashed var(--dsw-alias-border-l3);
  border-radius: 10px;
}
.${PREFIX}-error {
  display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
  padding: 12px;
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.${PREFIX}-error p { margin: 0; }
.${PREFIX}-errorDetail { color: var(--dsw-alias-label-tertiary); }
`;
		/**
		* Install the plugin's style tag once per activation.
		*
		* A tag left by an earlier activation — an HMR rebuild re-running this module —
		* is replaced rather than reused, so the newest activation owns the one tag in
		* the document and its disposer really removes it.
		* @returns a disposer removing the tag this call installed.
		*/
		function injectStyles() {
			for (const stale of document.querySelectorAll(`style[data-plugin-css="${STYLE_ID}"]`)) stale.remove();
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-perf";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = RULES;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		/** Rows the session table shows before the "show all" toggle. */
		const SESSION_PREVIEW_LIMIT = 12;
		/** Copy key per host failure code; a new code makes this record a compile error. */
		const REPORT_ERROR_KEYS = {
			"bad-request": "error.bad-request",
			"no-database": "error.no-database",
			"unsupported-schema": "error.unsupported-schema",
			"unreadable": "error.unreadable"
		};
		/** The host error codes the envelope may carry. */
		const REPORT_ERROR_CODES = [
			"bad-request",
			"no-database",
			"unsupported-schema",
			"unreadable"
		];
		/** Copy key per session-table sort key. */
		const SESSION_SORT_KEYS = {
			tokens: "sessions.sortTokens",
			messages: "sessions.sortMessages",
			tools: "sessions.sortTools"
		};
		/** Display order and label of the five token buckets. */
		const TOKEN_ROWS = [
			["input", "tokens.input"],
			["output", "tokens.output"],
			["cacheRead", "tokens.cacheRead"],
			["cacheWrite", "tokens.cacheWrite"],
			["reasoning", "tokens.reasoning"]
		];
		/**
		* Buckets this deployment's providers never report (`cacheWrite`) or report
		* only for some routes (`reasoning`).
		*
		* The wire contract has one number per bucket and no availability flag, so a
		* zero cannot be told apart from "this provider never reports the bucket":
		* `cacheWriteTokens` is absent from all 222,722 stored assistant messages of
		* this deployment and `reasoningTokens` appears only on `deepseek-v4-pro`. A
		* zero for these two therefore renders as "n/a in this deployment" instead of
		* claiming a measured zero; a nonzero reading is always real and renders as one.
		*/
		const OPTIONAL_BUCKETS = /* @__PURE__ */ new Set(["cacheWrite", "reasoning"]);
		/** The counter fields `DayTotals` adds to the five buckets. */
		const TOTALS_COUNTERS = [
			"sessionsOpened",
			"sessionsActive",
			"subagents",
			"userMessages",
			"assistantMessages",
			"toolCalls",
			"toolResults",
			"compactions",
			"llmCalls"
		];
		/** The one failure reading a body that is not an envelope produces. */
		const MALFORMED = {
			ok: false,
			failure: { kind: "malformed" }
		};
		/**
		* Build the same-origin day source.
		* @param options - fetch face and route override.
		* @returns the source; transport and parsing failures come back as failures
		*   rather than as thrown errors.
		*/
		function createHttpSource(options = {}) {
			const endpoint = options.endpoint ?? "/api/token-perf/day";
			const fetchImpl = options.fetchImpl ?? runtimeFetch;
			return async (date) => {
				let response;
				try {
					response = await fetchImpl(`${endpoint}?date=${encodeURIComponent(date)}`, { credentials: "same-origin" });
				} catch {
					return {
						ok: false,
						failure: { kind: "network" }
					};
				}
				if (!response.ok) return {
					ok: false,
					failure: {
						kind: "http",
						status: response.status
					}
				};
				let body;
				try {
					body = await response.json();
				} catch {
					return MALFORMED;
				}
				return readEnvelope(body);
			};
		}
		/**
		* Resolve the runtime's fetch at call time, so a page that replaced it after
		* this module loaded still serves the request.
		* @param input - request URL.
		* @param init - request options, credentials pinned to the page's origin.
		* @returns the response.
		*/
		function runtimeFetch(input, init) {
			const impl = globalThis.fetch;
			if (typeof impl !== "function") throw new Error("dsh-token-perf: fetch is unavailable in this runtime");
			return impl(input, init);
		}
		/**
		* Validate one response body against the envelope the Host serves.
		* @param body - parsed JSON body.
		* @returns the report, the host's own failure, or `malformed`.
		*/
		function readEnvelope(body) {
			if (!isRecord(body)) return MALFORMED;
			if (body.ok === true && isDayReport(body.report)) return {
				ok: true,
				report: body.report
			};
			if (body.ok === false && isReportErrorCode(body.code)) return {
				ok: false,
				failure: {
					kind: "report",
					code: body.code,
					message: typeof body.message === "string" ? body.message : ""
				}
			};
			return MALFORMED;
		}
		/**
		* Check the fields the renderer dereferences.
		*
		* This is the HTTP wire boundary, so a partial or foreign body must not reach
		* the view: every field read below is read again by the components.
		* @param value - candidate report.
		* @returns whether the value meets the frozen `DayReport` reading.
		*/
		function isDayReport(value) {
			if (!isRecord(value)) return false;
			return typeof value.date === "string" && typeof value.timezone === "string" && isNumber(value.timezoneOffsetMinutes) && isNumber(value.generatedAt) && isNumber(value.durationMs) && isTotals(value.totals) && Array.isArray(value.byModel) && value.byModel.every(isModelUsage) && Array.isArray(value.sessions) && value.sessions.every(isSessionUsage) && isRate(value.rate) && isCompaction(value.compaction) && isSubagents(value.subagents);
		}
		/** Whether one value is the five-bucket reading. */
		function isBuckets(value) {
			return isRecord(value) && isNumber(value.input) && isNumber(value.output) && isNumber(value.cacheRead) && isNumber(value.cacheWrite) && isNumber(value.reasoning);
		}
		/** Whether one value carries the day counters on top of the buckets. */
		function isTotals(value) {
			if (!isBuckets(value)) return false;
			const totals = value;
			return TOTALS_COUNTERS.every((counter) => isNumber(totals[counter]));
		}
		/** Whether one value is a model table row. */
		function isModelUsage(value) {
			if (!isBuckets(value)) return false;
			const usage = value;
			return typeof usage.provider === "string" && typeof usage.model === "string" && isNumber(usage.calls);
		}
		/** Whether one value is a session table row. */
		function isSessionUsage(value) {
			if (!isBuckets(value)) return false;
			const session = value;
			if (typeof session.id !== "string") return false;
			if (session.origin !== "root" && session.origin !== "subagent") return false;
			if (session.title !== void 0 && typeof session.title !== "string") return false;
			if (session.parentId !== void 0 && typeof session.parentId !== "string") return false;
			if (session.agentPreset !== void 0 && typeof session.agentPreset !== "string") return false;
			if (!Array.isArray(session.models) || !session.models.every((model) => typeof model === "string")) return false;
			return [
				"createdAt",
				"lastActivityAt",
				"userMessages",
				"assistantMessages",
				"toolCalls",
				"toolResults",
				"compactions",
				"llmCalls",
				"subagents"
			].every((field) => isNumber(session[field]));
		}
		/** Whether one value is one hour of the rate chart. */
		function isRateBucket(value) {
			if (!isRecord(value)) return false;
			return isNumber(value.hour) && isNumber(value.tokens) && isNumber(value.calls);
		}
		/** Whether one value is the rate block, whose 24 buckets the chart indexes by hour. */
		function isRate(value) {
			if (!isRecord(value)) return false;
			return Array.isArray(value.buckets) && value.buckets.length === 24 && value.buckets.every(isRateBucket) && isNumber(value.peakPerMinute) && isNumber(value.avgPerActiveMinute) && isNumber(value.activeMinutes) && isNumber(value.spanMinutes);
		}
		/** Whether one value is the compaction block. */
		function isCompaction(value) {
			if (!isRecord(value)) return false;
			return isNumber(value.events) && isNumber(value.summaries) && isBuckets(value.summaryTokens);
		}
		/** Whether one value is the subagent block. */
		function isSubagents(value) {
			if (!isRecord(value)) return false;
			const counts = (entries, key) => Array.isArray(entries) && entries.every((entry) => {
				if (!isRecord(entry)) return false;
				return typeof entry[key] === "string" && isNumber(entry.count);
			});
			return isNumber(value.total) && isNumber(value.spawningSessions) && isNumber(value.maxPerSession) && counts(value.byPreset, "preset") && counts(value.byModel, "model");
		}
		/** Whether one value is a JSON object. */
		function isRecord(value) {
			return typeof value === "object" && value !== null;
		}
		/** Whether one value is a finite number. */
		function isNumber(value) {
			return typeof value === "number" && Number.isFinite(value);
		}
		/** Whether one value is one of the host's failure codes. */
		function isReportErrorCode(value) {
			return typeof value === "string" && REPORT_ERROR_CODES.includes(value);
		}
		/**
		* Create the page's day store.
		* @param options - day source, clock, zone, and opening day.
		* @returns the store the dashboard subscribes to.
		*/
		function createDashboardStore(options) {
			const now = options.now ?? Date.now;
			const load = options.load;
			let timeZone = options.timeZone;
			let snapshot = {
				status: "loading",
				date: options.initialDate ?? localDayKey(now(), timeZone ?? resolveHostTimeZone())
			};
			const listeners = /* @__PURE__ */ new Set();
			let requestToken = 0;
			const publish = (next) => {
				snapshot = next;
				for (const listener of listeners) listener();
			};
			const open = async (date) => {
				const token = requestToken + 1;
				requestToken = token;
				publish({
					status: "loading",
					date
				});
				let result;
				try {
					result = await load(date);
				} catch {
					if (token === requestToken) publish({
						status: "error",
						date,
						failure: { kind: "network" }
					});
					return;
				}
				if (token !== requestToken) return;
				if (result.ok) {
					timeZone = result.report.timezone;
					publish({
						status: "ready",
						date,
						report: result.report
					});
					return;
				}
				publish({
					status: "error",
					date,
					failure: result.failure
				});
			};
			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				getSnapshot: () => snapshot,
				getServerSnapshot: () => snapshot,
				open,
				refresh: () => open(snapshot.date),
				today: () => localDayKey(now(), timeZone ?? resolveHostTimeZone())
			};
		}
		/**
		* Whether the day carries no activity at all.
		*
		* A day with sessions but no metered call is not empty — the session table
		* still has rows worth reading — so every channel must be silent for the empty
		* state to replace the report body.
		* @param report - the day's report.
		* @returns whether the empty-day state applies.
		*/
		function isEmptyDay(report) {
			return report.sessions.length === 0 && report.byModel.length === 0 && report.totals.llmCalls === 0 && totalTokens(report.totals) === 0;
		}
		/**
		* Order the session table.
		* @param sessions - session rows from the report.
		* @param sort - the measure to sort by.
		* @returns a copy ordered by that measure, descending; equal measures keep the
		*   report's own token-descending order.
		*/
		function sortSessions(sessions, sort) {
			const measure = (session) => {
				switch (sort) {
					case "tokens": return totalTokens(session);
					case "messages": return session.userMessages + session.assistantMessages;
					case "tools": return session.toolCalls;
					default: return assertNever(sort);
				}
			};
			return [...sessions].sort((left, right) => measure(right) - measure(left));
		}
		/**
		* Fail loudly on a member a closed union gained.
		* @param value - the unreachable member.
		* @returns never; throws.
		*/
		function assertNever(value) {
			throw new Error(`dsh-token-perf: unhandled discriminant ${JSON.stringify(value)}`);
		}
		/**
		* Join class names, dropping the absent ones.
		* @param names - class names or false.
		* @returns the class attribute value.
		*/
		function cx(...names) {
			return names.filter((name) => name !== false && name !== "").join(" ");
		}
		/**
		* The settings page: one day's report with its own header and states.
		* @param props - copy resolver and the injectable data seams.
		* @returns the page element tree.
		*/
		function Dashboard(props) {
			const copy = props.t ?? t;
			const [owned] = (0, react.useState)(() => createDashboardStore({
				load: props.load ?? createHttpSource(),
				...props.now !== void 0 ? { now: props.now } : {},
				...props.initialDate !== void 0 ? { initialDate: props.initialDate } : {}
			}));
			const store = props.store ?? owned;
			const snapshot = (0, react.useSyncExternalStore)(store.subscribe, store.getSnapshot, store.getServerSnapshot);
			const [draft, setDraft] = (0, react.useState)(snapshot.date);
			const [invalidDraft, setInvalidDraft] = (0, react.useState)(false);
			const dateInputId = (0, react.useId)();
			(0, react.useEffect)(() => {
				setDraft(snapshot.date);
				setInvalidDraft(false);
			}, [snapshot.date]);
			(0, react.useEffect)(() => {
				if (props.store !== void 0) return;
				store.open(store.getSnapshot().date);
			}, [store, props.store]);
			const openDay = (date) => {
				store.open(date);
			};
			const submitDraft = () => {
				const next = draft.trim();
				if (!isLocalDayKey(next)) {
					setInvalidDraft(true);
					return;
				}
				setInvalidDraft(false);
				openDay(next);
			};
			const report = snapshot.status === "ready" ? snapshot.report : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx(`${PREFIX}-page`),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: cx(`${PREFIX}-heading`),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: cx(`${PREFIX}-title`),
							children: copy("page.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: cx(`${PREFIX}-subtitle`),
							children: copy("page.subtitle")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: cx(`${PREFIX}-header`),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: cx(`${PREFIX}-nav`),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: cx(`${PREFIX}-button`),
										title: copy("header.prev"),
										"aria-label": copy("header.prev"),
										onClick: () => {
											openDay(shiftDayKey(snapshot.date, -1));
										},
										children: "‹"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: cx(`${PREFIX}-button`),
										onClick: () => {
											openDay(store.today());
										},
										children: copy("header.today")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: cx(`${PREFIX}-button`),
										title: copy("header.next"),
										"aria-label": copy("header.next"),
										onClick: () => {
											openDay(shiftDayKey(snapshot.date, 1));
										},
										children: "›"
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								className: cx(`${PREFIX}-dateForm`),
								onSubmit: (event) => {
									event.preventDefault();
									submitDraft();
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: cx(`${PREFIX}-label`),
										htmlFor: dateInputId,
										children: copy("header.dateLabel")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: dateInputId,
										className: cx(`${PREFIX}-input`),
										type: "text",
										inputMode: "numeric",
										autoComplete: "off",
										spellCheck: false,
										placeholder: copy("header.datePlaceholder"),
										"aria-invalid": invalidDraft ? true : void 0,
										value: draft,
										onChange: (event) => {
											setDraft(event.target.value);
											setInvalidDraft(false);
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "submit",
										className: cx(`${PREFIX}-button`),
										children: copy("header.view")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: cx(`${PREFIX}-button`),
										onClick: () => {
											store.refresh();
										},
										children: copy("header.refresh")
									})
								]
							}),
							report !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
								className: cx(`${PREFIX}-meta`),
								children: [
									copy("header.timezone", {
										zone: report.timezone,
										offset: formatUtcOffset(report.timezoneOffsetMinutes)
									}),
									" · ",
									copy("header.generated", {
										time: formatZoneTime(report.generatedAt, report.timezone),
										duration: formatDuration(report.durationMs)
									})
								]
							}) : null,
							report !== void 0 && report.skippedEvents > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: cx(`${PREFIX}-invalid`),
								role: "status",
								children: copy("header.skippedEvents", { count: exactCount(report.skippedEvents) })
							}) : null,
							invalidDraft ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: cx(`${PREFIX}-invalid`),
								role: "alert",
								children: copy("header.invalidDate")
							}) : null
						]
					}),
					snapshot.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: cx(`${PREFIX}-loading`),
						role: "status",
						children: copy("state.loading", { date: snapshot.date })
					}) : null,
					snapshot.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ErrorPanel, {
						copy,
						failure: snapshot.failure,
						onRetry: () => {
							store.refresh();
						}
					}) : null,
					snapshot.status === "ready" && isEmptyDay(snapshot.report) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: cx(`${PREFIX}-empty`),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							className: cx(`${PREFIX}-sectionTitle`),
							children: copy("state.empty.title", { date: snapshot.date })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: cx(`${PREFIX}-note`),
							children: copy("state.empty.body")
						})]
					}) : null,
					snapshot.status === "ready" && !isEmptyDay(snapshot.report) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DayReportView, {
						copy,
						report: snapshot.report
					}) : null
				]
			});
		}
		/**
		* The loaded day: every panel of the report in reading order.
		* @param props - copy resolver and the day's report.
		* @returns the report body.
		*/
		function DayReportView({ copy, report }) {
			const dayTotal = totalTokens(report.totals);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx(`${PREFIX}-body`),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SummaryCards, {
						copy,
						report
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TokenComposition, {
						copy,
						buckets: report.totals
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelTable, {
						copy,
						models: report.byModel,
						dayTotal
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RateChart, {
						copy,
						rate: report.rate
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubagentPanel, {
						copy,
						stats: report.subagents
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionTable, {
						copy,
						sessions: report.sessions,
						timeZone: report.timezone
					})
				]
			});
		}
		/**
		* The day-wide counters as cards.
		* @param props - copy resolver and the day's report.
		* @returns the overview section.
		*/
		function SummaryCards({ copy, report }) {
			const totals = report.totals;
			const dayTotal = totalTokens(totals);
			const rootSessions = Math.max(0, totals.sessionsOpened - totals.subagents);
			const cards = [
				{
					id: "tokens",
					title: copy("summary.totalTokens"),
					value: compactCount(dayTotal),
					detail: copy("summary.exactCount", { count: exactCount(dayTotal) })
				},
				{
					id: "opened",
					title: copy("summary.sessionsOpened"),
					value: exactCount(totals.sessionsOpened),
					detail: copy("summary.sessionsSplit", {
						root: exactCount(rootSessions),
						subagent: exactCount(totals.subagents)
					})
				},
				{
					id: "active",
					title: copy("summary.sessionsActive"),
					value: exactCount(totals.sessionsActive)
				},
				{
					id: "subagents",
					title: copy("summary.subagentsOpened"),
					value: exactCount(totals.subagents)
				},
				{
					id: "messages",
					title: copy("summary.messages"),
					value: exactCount(totals.userMessages + totals.assistantMessages),
					detail: copy("summary.messagesSplit", {
						user: exactCount(totals.userMessages),
						assistant: exactCount(totals.assistantMessages)
					})
				},
				{
					id: "tools",
					title: copy("summary.toolCalls"),
					value: exactCount(totals.toolCalls),
					detail: copy("summary.toolResults", { count: exactCount(totals.toolResults) })
				},
				{
					id: "compactions",
					title: copy("summary.compactions"),
					value: exactCount(totals.compactions),
					detail: copy("summary.summaryTokens", { count: compactCount(totalTokens(report.compaction.summaryTokens)) })
				},
				{
					id: "calls",
					title: copy("summary.llmCalls"),
					value: exactCount(totals.llmCalls),
					detail: copy("summary.llmCallsDetail", { assistant: exactCount(totals.assistantMessages) })
				}
			];
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: cx(`${PREFIX}-section`),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
					className: cx(`${PREFIX}-sectionTitle`),
					children: copy("summary.title")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: cx(`${PREFIX}-cards`),
					children: cards.map((card) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: cx(`${PREFIX}-card`),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(`${PREFIX}-cardTitle`),
								children: card.title
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(`${PREFIX}-cardValue`),
								children: card.value
							}),
							card.detail !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(`${PREFIX}-cardDetail`),
								children: card.detail
							}) : null
						]
					}, card.id))
				})]
			});
		}
		/**
		* The five buckets as one share bar plus their numbers.
		* @param props - copy resolver and the day's buckets.
		* @returns the composition section.
		*/
		function TokenComposition({ copy, buckets }) {
			const total = totalTokens(buckets);
			const rows = TOKEN_ROWS.map(([bucket, key]) => ({
				bucket,
				key,
				value: buckets[bucket]
			}));
			const segments = rows.filter((row) => row.value > 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: cx(`${PREFIX}-section`),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: cx(`${PREFIX}-sectionTitle`),
						children: copy("tokens.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(`${PREFIX}-bar`),
						role: "img",
						"aria-label": copy("tokens.title"),
						children: segments.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: cx(`${PREFIX}-barSegment`, `${PREFIX}-barEmpty`),
							style: { width: "100%" }
						}) : segments.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: cx(`${PREFIX}-barSegment`),
							"data-bucket": row.bucket,
							style: { width: `${sharePercent(row.value, total)}%` },
							title: `${copy(row.key)} ${percentLabel(row.value, total)}`
						}, row.bucket))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
						className: cx(`${PREFIX}-rows`),
						children: rows.map((row) => {
							const reported = row.value > 0 || !OPTIONAL_BUCKETS.has(row.bucket);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
								className: cx(`${PREFIX}-row`),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: cx(`${PREFIX}-rowLabel`),
										"data-bucket": row.bucket,
										children: copy(row.key)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: cx(`${PREFIX}-rowValue`),
										children: reported ? exactCount(row.value) : copy("tokens.unavailable")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: cx(`${PREFIX}-rowShare`),
										children: reported ? percentLabel(row.value, total) : ""
									})
								]
							}, row.bucket);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: cx(`${PREFIX}-note`),
						children: [
							copy("tokens.total"),
							" ",
							exactCount(total)
						]
					})
				]
			});
		}
		/**
		* The per-route model table.
		* @param props - copy resolver, the model rows, and the day's token total.
		* @returns the model section.
		*/
		function ModelTable({ copy, models, dayTotal }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: cx(`${PREFIX}-section`),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
					className: cx(`${PREFIX}-sectionTitle`),
					children: copy("models.title")
				}), models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: cx(`${PREFIX}-note`),
					children: copy("models.empty")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: cx(`${PREFIX}-scroll`),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
						className: cx(`${PREFIX}-table`),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								scope: "col",
								children: copy("models.route")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								scope: "col",
								className: cx(`${PREFIX}-num`),
								children: copy("models.calls")
							}),
							TOKEN_ROWS.map(([bucket, key]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								scope: "col",
								className: cx(`${PREFIX}-num`),
								children: copy(key)
							}, bucket)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								scope: "col",
								className: cx(`${PREFIX}-num`),
								children: copy("models.total")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
								scope: "col",
								className: cx(`${PREFIX}-num`),
								children: copy("models.share")
							})
						] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: models.map((model) => {
							const total = totalTokens(model);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", {
									className: cx(`${PREFIX}-route`),
									children: [
										model.provider,
										"/",
										model.model
									]
								}) }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									className: cx(`${PREFIX}-num`),
									children: exactCount(model.calls)
								}),
								TOKEN_ROWS.map(([bucket]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									className: cx(`${PREFIX}-num`),
									title: exactCount(model[bucket]),
									children: compactCount(model[bucket])
								}, bucket)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									className: cx(`${PREFIX}-num`),
									title: exactCount(total),
									children: compactCount(total)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
									className: cx(`${PREFIX}-num`),
									children: percentLabel(total, dayTotal)
								})
							] }, `${model.provider}/${model.model}`);
						}) })]
					})
				})]
			});
		}
		/**
		* The 24 local-hour bars plus the peak, mean, and active-minute readings.
		* @param props - copy resolver and the rate block.
		* @returns the rate section.
		*/
		function RateChart({ copy, rate }) {
			const peak = rate.buckets.reduce((highest, bucket) => Math.max(highest, bucket.tokens), 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: cx(`${PREFIX}-section`),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: cx(`${PREFIX}-sectionTitle`),
						children: copy("rate.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(`${PREFIX}-chart`),
						role: "img",
						"aria-label": copy("rate.title"),
						children: rate.buckets.map((bucket) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: cx(`${PREFIX}-column`),
							title: copy("rate.bar", {
								hour: hourLabel(bucket.hour),
								tokens: exactCount(bucket.tokens),
								calls: exactCount(bucket.calls)
							}),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(`${PREFIX}-columnFill`),
								style: { height: `${peak > 0 ? sharePercent(bucket.tokens, peak) : 0}%` }
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(`${PREFIX}-columnAxis`),
								children: hourLabel(bucket.hour)
							})]
						}, bucket.hour))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
						className: cx(`${PREFIX}-stats`),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: copy("rate.peak", { value: compactCount(rate.peakPerMinute) }) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: copy("rate.avg", { value: compactCount(rate.avgPerActiveMinute) }) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: copy("rate.activeMinutes", { count: exactCount(rate.activeMinutes) }) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: copy("rate.span", { count: exactCount(rate.spanMinutes) }) })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: cx(`${PREFIX}-note`),
						children: copy("rate.note")
					})
				]
			});
		}
		/**
		* The subagent panel: how many were opened, by whom, and from which presets and
		* models — the reading a user optimizes their own delegation against.
		* @param props - copy resolver and the subagent block.
		* @returns the subagent section.
		*/
		function SubagentPanel({ copy, stats }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: cx(`${PREFIX}-section`),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: cx(`${PREFIX}-sectionTitle`),
						children: copy("subagents.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
						className: cx(`${PREFIX}-stats`),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
								copy("subagents.total"),
								" ",
								exactCount(stats.total)
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
								copy("subagents.spawningSessions"),
								" ",
								exactCount(stats.spawningSessions)
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
								copy("subagents.maxPerSession"),
								" ",
								exactCount(stats.maxPerSession)
							] })
						]
					}),
					stats.total === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: cx(`${PREFIX}-note`),
						children: copy("subagents.none")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: cx(`${PREFIX}-breakdowns`),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Breakdown, {
							copy,
							title: copy("subagents.byPreset"),
							fallback: copy("subagents.unrecorded"),
							entries: stats.byPreset.map((entry) => ({
								name: entry.preset,
								count: entry.count
							})),
							total: stats.total
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Breakdown, {
							copy,
							title: copy("subagents.byModel"),
							fallback: copy("subagents.unrecorded"),
							entries: stats.byModel.map((entry) => ({
								name: entry.model,
								count: entry.count
							})),
							total: stats.total
						})]
					})
				]
			});
		}
		/**
		* One descending count list with a share bar per row.
		* @param props - copy resolver, heading, empty-name fallback, rows, and the total.
		* @returns the breakdown list.
		*/
		function Breakdown({ copy, title, fallback, entries, total }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx(`${PREFIX}-breakdown`),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					className: cx(`${PREFIX}-breakdownTitle`),
					children: title
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: cx(`${PREFIX}-rows`),
					children: entries.map((entry) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
						className: cx(`${PREFIX}-row`),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: cx(`${PREFIX}-rowLabel`),
							children: copy("subagents.entry", {
								name: entry.name === "" ? fallback : entry.name,
								count: exactCount(entry.count)
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: cx(`${PREFIX}-breakdownBar`),
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(`${PREFIX}-breakdownFill`),
								style: { width: `${sharePercent(entry.count, total)}%` }
							})
						})]
					}, entry.name))
				})]
			});
		}
		/**
		* The session table: one row per session, sortable, capped until expanded.
		* @param props - copy resolver, session rows, and the zone start times render in.
		* @returns the sessions section.
		*/
		function SessionTable({ copy, sessions, timeZone }) {
			const [sort, setSort] = (0, react.useState)("tokens");
			const [expanded, setExpanded] = (0, react.useState)(false);
			const ordered = (0, react.useMemo)(() => sortSessions(sessions, sort), [sessions, sort]);
			const visible = expanded ? ordered : ordered.slice(0, SESSION_PREVIEW_LIMIT);
			const sortKeys = Object.keys(SESSION_SORT_KEYS);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: cx(`${PREFIX}-section`),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: cx(`${PREFIX}-sectionTitle`),
						children: copy("sessions.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: cx(`${PREFIX}-sort`),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(`${PREFIX}-label`),
								children: copy("sessions.sortBy")
							}),
							sortKeys.map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: cx(`${PREFIX}-button`, sort === key && `dstp-buttonActive`),
								"aria-pressed": sort === key,
								onClick: () => {
									setSort(key);
								},
								children: copy(SESSION_SORT_KEYS[key])
							}, key)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: cx(`${PREFIX}-note`),
								children: copy("sessions.count", { count: exactCount(ordered.length) })
							})
						]
					}),
					ordered.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: cx(`${PREFIX}-note`),
						children: copy("sessions.empty")
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: cx(`${PREFIX}-scroll`),
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: cx(`${PREFIX}-table`),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: copy("sessions.colTitle")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: copy("sessions.colStart")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: copy("sessions.colKind")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: copy("sessions.colParent")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									className: cx(`${PREFIX}-num`),
									children: copy("sessions.colSubagents")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									className: cx(`${PREFIX}-num`),
									children: copy("sessions.colMessages")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									className: cx(`${PREFIX}-num`),
									children: copy("sessions.colTools")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									className: cx(`${PREFIX}-num`),
									children: copy("sessions.colCompactions")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									className: cx(`${PREFIX}-num`),
									children: copy("sessions.colTokens")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: copy("sessions.colModels")
								})
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: visible.map((session) => {
								const total = totalTokens(session);
								const title = session.title ?? "";
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
									"data-session": session.id,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: cx(`${PREFIX}-titleCell`),
											children: title.trim() === "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
												className: cx(`${PREFIX}-id`),
												title: session.id,
												children: session.id
											}) : title
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: formatZoneTime(session.createdAt, timeZone) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: cx(`${PREFIX}-badge`),
											"data-origin": session.origin,
											children: session.origin === "root" ? copy("sessions.kindRoot") : copy("sessions.kindSubagent")
										}) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: session.parentId !== void 0 && session.parentId !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
											className: cx(`${PREFIX}-id`),
											title: session.parentId,
											children: session.parentId
										}) : "—" }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: cx(`${PREFIX}-num`),
											children: exactCount(session.subagents)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											className: cx(`${PREFIX}-num`),
											title: copy("sessions.messagesSplit", {
												user: exactCount(session.userMessages),
												assistant: exactCount(session.assistantMessages)
											}),
											children: [
												exactCount(session.userMessages),
												" / ",
												exactCount(session.assistantMessages)
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
											className: cx(`${PREFIX}-num`),
											title: copy("sessions.toolsSplit", {
												calls: exactCount(session.toolCalls),
												results: exactCount(session.toolResults)
											}),
											children: [
												exactCount(session.toolCalls),
												" / ",
												exactCount(session.toolResults)
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: cx(`${PREFIX}-num`),
											children: exactCount(session.compactions)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: cx(`${PREFIX}-num`),
											title: exactCount(total),
											children: compactCount(total)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
											className: cx(`${PREFIX}-models`),
											children: session.models.length === 0 ? "—" : session.models.join(" · ")
										})
									]
								}, session.id);
							}) })]
						})
					}),
					ordered.length > visible.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: cx(`${PREFIX}-button`),
						onClick: () => {
							setExpanded(true);
						},
						children: copy("sessions.showAll", { count: exactCount(ordered.length) })
					}) : null,
					expanded && ordered.length > SESSION_PREVIEW_LIMIT ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: cx(`${PREFIX}-button`),
						onClick: () => {
							setExpanded(false);
						},
						children: copy("sessions.showLess")
					}) : null
				]
			});
		}
		/**
		* The failure state: the mapped copy for the host's code, plus a retry seat.
		* @param props - copy resolver, the failure, and the retry handler.
		* @returns the error panel.
		*/
		function ErrorPanel({ copy, failure, onRetry }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: cx(`${PREFIX}-error`),
				role: "alert",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: cx(`${PREFIX}-sectionTitle`),
						children: copy("error.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: copy(failureKey(failure), failureParams(failure)) }),
					failure.kind === "report" && failure.message !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: cx(`${PREFIX}-errorDetail`),
						children: copy("error.hostMessage", { message: failure.message })
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: cx(`${PREFIX}-button`),
						onClick: onRetry,
						children: copy("error.retry")
					})
				]
			});
		}
		/**
		* The copy key for one failure.
		* @param failure - the failure to describe.
		* @returns the key whose copy explains it.
		*/
		function failureKey(failure) {
			switch (failure.kind) {
				case "report": return REPORT_ERROR_KEYS[failure.code];
				case "http": return "error.http";
				case "malformed": return "error.malformed";
				case "network": return "error.network";
				default: return assertNever(failure);
			}
		}
		/**
		* The placeholder values the failure's copy line needs.
		* @param failure - the failure being described.
		* @returns `{ status }` for an HTTP failure, whose copy carries the slot;
		*   undefined for every other failure, whose copy carries none.
		*/
		function failureParams(failure) {
			return failure.kind === "http" ? { status: failure.status } : void 0;
		}
		//#endregion
		//#region src/client/index.tsx
		/** Services required before activation. */
		const inject = ["slots", "locale"];
		/** Nav position: after the shipped settings pages. */
		const SECTION_ORDER = 35;
		/** The section id this plugin owns in `settings.section`. */
		const SECTION_ID = "token-perf";
		/**
		* Register the settings page, its dictionaries, and its styles.
		* @param ctx - the client context carrying the injected services.
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(LOCALE_NS, {
				zh,
				en
			}), "dsh-token-perf: dictionaries");
			ctx.effect(() => {
				attachLocale(ctx.locale);
				return () => {
					attachLocale(void 0);
				};
			}, "dsh-token-perf: locale binding");
			ctx.effect(() => injectStyles(), "dsh-token-perf: styles");
			ctx.effect(() => {
				let registration;
				const install = () => {
					registration?.();
					registration = ctx.slots.inject("settings.section", () => ctx.slots.register({
						name: "settings.section",
						id: SECTION_ID,
						order: SECTION_ORDER,
						label: () => t("settings.nav")
					}, Dashboard));
				};
				install();
				const off = ctx.locale.subscribe(install);
				return () => {
					off();
					registration?.();
					registration = void 0;
				};
			}, "dsh-token-perf: settings section");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map