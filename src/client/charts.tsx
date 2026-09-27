/**
 * The day page's three P0 marks: the ranked speed view, the de-replicated work
 * panel, and the retry badges — hand-rolled CSS grid, `--dsw-*` colours only.
 *
 * Every drawing here is a handful of positioned elements, so the module also
 * owns the panel's mark budget: the speed view is one bar plus one whisker per
 * route, the work panel is one bar per quantity plus seven small multiples per
 * metric, and no chart draws a mean, a second axis, or a legend. Class names
 * are built from {@link PREFIX} so the style tag can scope every rule it ships.
 * @module dsh-token-perf/client/charts
 */

import type { ReactNode } from 'react'
import type { ModelSpeed, RetrySignal, WorkDay } from '../aggregate/types.ts'
import { barPercent, compactCount, exactCount, formatDuration, percentLabel } from './format.ts'
import type { Translator } from './locales.ts'
import { PREFIX } from './styles.ts'

/** The two work quantities, each drawn on its own scale. */
type WorkMetric = 'output' | 'cacheRead'

const SECTION = `${PREFIX}-section`
const TITLE = `${PREFIX}-sectionTitle`
const NOTE = `${PREFIX}-note`
const LABEL = `${PREFIX}-label`
const NUM = `${PREFIX}-num`
const TRACK = `${PREFIX}-barTrack`
const FILL = `${PREFIX}-barFill`
const ROW = `${PREFIX}-workRow`
/** Speed-view column header; shares the row grid so the labels sit over their columns. */
const HEAD = `${PREFIX}-speedHead`

/** `provider/model`, or the label for a sample the wire carried no route for. */
function routeLabel(copy: Translator, provider: string, model: string): string {
  return provider === 'unknown' && model === 'unknown' ? copy('speed.routeUnknown') : `${provider}/${model}`
}

/**
 * Order the speed rows by p50 ascending, then by the larger sample.
 * @param speeds - the day's per-route speed rows.
 * @returns the rows in draw order; the sort is stable, so full ties keep the
 *   wire's own order.
 */
export function rankSpeeds(speeds: readonly ModelSpeed[]): ModelSpeed[] {
  return [...speeds].sort((left, right) => left.p50Ms - right.p50Ms || right.steps - left.steps)
}

/**
 * The ranked speed view.
 *
 * One row per `provider:model` — a sample the wire carried no route for keeps
 * its own `unknown` row — sorted by p50 ascending. The bar ends at p50 and the
 * whisker at p90, both measured on the panel's single scale (the largest p90),
 * so no mark is an average and no second axis exists. A header row names the
 * route, p50, p90, n, and output/step columns, and every row prints p50, p90,
 * n, and output/step as its own cells instead of leaving them to the row
 * tooltip, which repeats the whole row as one line. The title and note state
 * that the reading is an upper bound, because a step's duration includes
 * queueing and scheduling.
 * @param props - copy resolver and the day's per-route rows.
 * @returns the speed section; heading and note alone when no step had a
 *   measurable duration.
 */
export function SpeedView({ copy, speeds }: { copy: Translator; speeds: readonly ModelSpeed[] }): ReactNode {
  const rows = rankSpeeds(speeds)
  const scale = rows.reduce((max, row) => Math.max(max, row.p50Ms, row.p90Ms), 0)
  return (
    <section className={SECTION}>
      <h3 className={TITLE}>{copy('speed.title')}</h3>
      <p className={NOTE}>{copy('speed.note')}</p>
      {rows.length > 0
        ? (
            <>
              {/* The bar column carries no label: the note ties the bar to p50
                  and the whisker to p90, and the two numeric columns repeat
                  both readings exactly. */}
              <div className={HEAD}>
                <span>{copy('speed.colRoute')}</span>
                <span />
                <span className={NUM}>{copy('speed.colP50')}</span>
                <span className={NUM}>{copy('speed.colP90')}</span>
                <span className={NUM}>{copy('speed.colN')}</span>
                <span className={NUM}>{copy('speed.colOutput')}</span>
              </div>
              <ol className={`${PREFIX}-speed`}>
                {rows.map((row) => {
                  // A p90 under its own p50 is a host defect; the clamp keeps
                  // the whisker, the p90 column, and the tooltip reading alike.
                  const p90Ms = Math.max(row.p90Ms, row.p50Ms)
                  const label = routeLabel(copy, row.provider, row.model)
                  const p50 = formatDuration(row.p50Ms)
                  const p90 = formatDuration(p90Ms)
                  const n = exactCount(row.steps)
                  const output = compactCount(row.outputPerStep)
                  return (
                    <li
                      key={label}
                      className={`${PREFIX}-speedRow`}
                      title={copy('speed.row', { route: label, p50, p90, n, output })}
                    >
                      <code className={`${PREFIX}-speedRoute`}>{label}</code>
                      <span className={TRACK}>
                        <span className={FILL} style={{ width: `${barPercent(row.p50Ms, scale)}%` }} />
                        <span
                          className={`${PREFIX}-speedWhisker`}
                          style={{ left: `${barPercent(p90Ms, scale)}%` }}
                        />
                      </span>
                      <span className={NUM}>{p50}</span>
                      <span className={NUM}>{p90}</span>
                      <span className={NUM}>{n}</span>
                      <span className={NUM}>{output}</span>
                    </li>
                  )
                })}
              </ol>
            </>
          )
        : null}
    </section>
  )
}

/**
 * One work row: a labelled bar whose track is that quantity's own full scale.
 *
 * The track is per-row, so the day's own output and cache read each fill their
 * own bar even though they differ by orders of magnitude; a row without a
 * metric is the thin prefix-replica baseline, drawn on the window's event count
 * rather than on either token scale.
 * @param props - the row's label, value, scale maximum, optional metric, and
 *   the exact reading to print instead of the compact one.
 * @returns the row's grid cells.
 */
function WorkRow(
  { label, value, max, metric, detail }: {
    label: string
    value: number
    max: number
    metric?: WorkMetric
    detail?: string
  },
): ReactNode {
  return (
    <div className={ROW}>
      <span className={LABEL}>{label}</span>
      <span className={TRACK}>
        <span
          className={FILL}
          data-metric={metric}
          data-base={metric === undefined ? 'true' : undefined}
          style={{ width: `${barPercent(value, max)}%` }}
        />
      </span>
      <span className={NUM}>{detail ?? compactCount(value)}</span>
    </div>
  )
}

/**
 * One metric's seven-day small multiples, oldest first.
 *
 * Each day is one bar scaled to that metric's own window maximum, so the two
 * metrics never share a linear axis. The rows carry their exact per-day numbers
 * in the tooltip; the shared date axis under both metrics names the days.
 * @param props - the window's days, the metric to draw, the row label, and
 *   that metric's scale maximum.
 * @returns the label cell and the bar column.
 */
function TrendRow(
  { days, metric, label, max }: {
    days: readonly WorkDay[]
    metric: WorkMetric
    label: string
    max: number
  },
): ReactNode {
  return (
    <>
      <span className={LABEL}>{label}</span>
      <span
        className={`${PREFIX}-trendBars`}
        data-metric={metric}
        title={days.map(day => `${day.date.slice(5)} ${compactCount(day[metric])}`).join(' · ')}
      >
        {days.map(day => (
          <span
            key={day.date}
            className={FILL}
            style={{ height: `${barPercent(day[metric], max)}%` }}
          />
        ))}
      </span>
    </>
  )
}

/**
 * The de-replicated work panel.
 *
 * Output and cache read are drawn on separate scales, each on the seven-day
 * maximum its small multiples share, plus the removed prefix replicas as a thin
 * baseline on the window's event count rather than either token scale. One
 * shared date axis under both metrics names the seven days, oldest first, so a
 * reader can tie a bar to its day without opening the tooltip.
 * @param props - copy resolver, the day's own work reading, and the trailing
 *   seven-day window that ends on that day.
 * @returns the work section.
 */
export function WorkPanel(
  { copy, work, trend }: { copy: Translator; work: WorkDay; trend: readonly WorkDay[] },
): ReactNode {
  const days = trend.length > 0 ? trend : [work]
  const outputMax = Math.max(work.output, ...days.map(day => day.output))
  const cacheMax = Math.max(work.cacheRead, ...days.map(day => day.cacheRead))
  const windowEvents = work.events + work.replicaEvents
  return (
    <section className={SECTION}>
      <h3 className={TITLE}>{copy('work.title')}</h3>
      <p className={NOTE}>{copy('work.note')}</p>
      <div className={`${PREFIX}-work`}>
        <WorkRow label={copy('work.output')} value={work.output} max={outputMax} metric="output" />
        <WorkRow label={copy('work.cacheRead')} value={work.cacheRead} max={cacheMax} metric="cacheRead" />
        <WorkRow
          label={copy('work.baseline')}
          value={work.replicaEvents}
          max={windowEvents}
          detail={`${exactCount(work.replicaEvents)} / ${exactCount(windowEvents)}`}
        />
        <div className={`${PREFIX}-trend`}>
          <TrendRow days={days} metric="output" label={copy('work.output')} max={outputMax} />
          <TrendRow days={days} metric="cacheRead" label={copy('work.cacheRead')} max={cacheMax} />
          {/* One axis for both metrics: their bars share the seven day slots. */}
          <span className={LABEL}>{copy('work.trendAxis')}</span>
          <span className={`${PREFIX}-trendAxis`}>
            {days.map(day => (
              <span key={day.date} className={`${PREFIX}-trendTick`}>{day.date.slice(5)}</span>
            ))}
          </span>
        </div>
      </div>
    </section>
  )
}

/**
 * One badge per retry window the host flagged as triggered.
 *
 * A window below the host's threshold renders nothing at all — no heading, no
 * empty frame, no placeholder — so the row exists only when it has something to
 * report. The badge carries the route, the retry share, the settled count, and
 * the Wilson lower bound the trigger was decided on.
 * @param props - copy resolver and the host's retry rows, including the ones
 *   that did not trigger.
 * @returns the badge row, or `null` when no window triggered.
 */
export function RetryBadges(
  { copy, retries }: { copy: Translator; retries: readonly RetrySignal[] },
): ReactNode {
  const rows = retries.filter(row => row.triggered)
  if (rows.length === 0) return null
  return (
    <div className={`${PREFIX}-retry`}>
      <span className={LABEL}>{copy('retry.title')}</span>
      {rows.map(row => (
        <span key={`${row.provider}/${row.model}`} className={`${PREFIX}-retryBadge`}>
          {copy('retry.badge', {
            route: routeLabel(copy, row.provider, row.model),
            share: percentLabel(row.share, 1),
            n: exactCount(row.settled),
            lower: percentLabel(row.wilsonLower, 1),
          })}
        </span>
      ))}
    </div>
  )
}
