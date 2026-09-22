/**
 * Browser half of dsh-token-perf.
 *
 * The plugin contributes one settings page (`settings.section`, id
 * `token-perf`) rendering the day dashboard, plus the dictionaries and the
 * style tag that page needs. Nothing else is registered: the page owns its own
 * header, navigation, and data reads through `/api/token-perf/day`.
 *
 * The nav row's label is read from the slot ledger, so it is both a thunk (a
 * projection re-reads it) and republished by a fresh registration on every
 * locale change — the ledger bump is what re-renders the shell's nav. The
 * registered component is a module-level reference, so React keeps the mounted
 * dashboard, and with it the day already read, across that re-registration.
 * @module dsh-token-perf/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { Dashboard } from './dashboard.tsx'
import { attachLocale, en, LOCALE_NS, t, zh } from './locales.ts'
import { injectStyles } from './styles.ts'

/** Services required before activation. */
export const inject = ['slots', 'locale'] as const

/** Nav position: after the shipped settings pages. */
const SECTION_ORDER = 35

/** The section id this plugin owns in `settings.section`. */
const SECTION_ID = 'token-perf'

/**
 * Register the settings page, its dictionaries, and its styles.
 * @param ctx - the client context carrying the injected services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-token-perf: dictionaries')

  ctx.effect(() => {
    attachLocale(ctx.locale)
    return () => { attachLocale(undefined) }
  }, 'dsh-token-perf: locale binding')

  ctx.effect(() => injectStyles(), 'dsh-token-perf: styles')

  ctx.effect(() => {
    let registration: (() => void) | undefined
    const install = (): void => {
      // Disposing the previous injection also disposes the registration it
      // installed, so a locale change republishes the label instead of
      // stacking a second nav row.
      registration?.()
      registration = ctx.slots.inject('settings.section', () => ctx.slots.register(
        {
          name: 'settings.section',
          id: SECTION_ID,
          order: SECTION_ORDER,
          label: () => t('settings.nav'),
        },
        Dashboard,
      ))
    }
    install()
    const off = ctx.locale.subscribe(install)
    return () => {
      off()
      registration?.()
      registration = undefined
    }
  }, 'dsh-token-perf: settings section')
}
