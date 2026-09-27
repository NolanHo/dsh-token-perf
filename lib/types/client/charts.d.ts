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
import type { ReactNode } from 'react';
import type { ModelSpeed, RetrySignal, WorkDay } from '../aggregate/types.ts';
import type { Translator } from './locales.ts';
/**
 * Order the speed rows by p50 ascending, then by the larger sample.
 * @param speeds - the day's per-route speed rows.
 * @returns the rows in draw order; the sort is stable, so full ties keep the
 *   wire's own order.
 */
export declare function rankSpeeds(speeds: readonly ModelSpeed[]): ModelSpeed[];
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
export declare function SpeedView({ copy, speeds }: {
    copy: Translator;
    speeds: readonly ModelSpeed[];
}): ReactNode;
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
export declare function WorkPanel({ copy, work, trend }: {
    copy: Translator;
    work: WorkDay;
    trend: readonly WorkDay[];
}): ReactNode;
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
export declare function RetryBadges({ copy, retries }: {
    copy: Translator;
    retries: readonly RetrySignal[];
}): ReactNode;
