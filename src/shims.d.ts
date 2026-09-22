/**
 * Cordis context augmentation for the DSH services this plugin injects.
 *
 * A third-party plugin resolves outside the DSH monorepo's single cordis
 * instance, so the upstream augmentations do not reach this Context — the
 * members below mirror the actual runtime shapes. `@deepseek-ai/cordis` is the
 * resolvable type entry point: the bare `cordis` package ships a declaration
 * file whose extensionless relative re-exports NodeNext cannot resolve.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Route match kind: `exact` matches the pathname verbatim; `prefix` also matches `path/<anything>`. */
export type WebRouteKind = 'exact' | 'prefix'

/** One named HTTP route this plugin claims on the host webserver. */
export interface WebRoute {
  kind: WebRouteKind
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** The host webserver face this plugin uses (`@deepseek-ai/dsh-host-webserver`). */
export interface WebServerService {
  /**
   * Add a named HTTP route.
   * @param route - kind, path, and the handler owning the response lifecycle.
   * @returns a disposer removing the registration.
   */
  register(route: WebRoute): () => void
}

/** Registration options the client slot core accepts (minimal external surface). */
export interface SlotRegisterOptions {
  name: string
  id?: string
  order?: number
  label?: string | (() => string)
  priority?: number
  /** Locale namespace key: the slot core re-registers on its change. */
  locale?: string
  /** Provider of the props the registrant's component receives alongside the owner share. */
  inject?: () => Record<string, unknown>
}

/** The client slot registry, provided by the web client runtime. */
export interface SlotsService {
  register(options: SlotRegisterOptions, component: unknown): () => void
  inject(key: string, callback: () => (() => void) | void): () => void
  entries(key: string): readonly unknown[]
  getVersion(key: string): number
}

/** The client locale service, provided by the locale plugin. */
export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  /** Bind one namespace: returns a (key, params?) => translated-string thunk. */
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  getSnapshot(): { active: string }
  subscribe(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The DSH-vendored lifecycle helper (auto-disposes the returned disposer). */
    effect(execute: () => (() => void) | void, label?: string): () => void
    /** Scoped service injection: the callback runs once every named service is available. */
    inject(deps: readonly string[], callback: (ctx: Context) => void): () => void
    /** Resolve a service by name, `undefined` when it is not provided. */
    get(name: string): unknown
    /** Subscribe to a harness event; `global` lifts the listener above plugin isolation. */
    on(name: string, listener: (...args: never[]) => void, options?: { global?: boolean }): () => void
    /** The host webserver, present once `@deepseek-ai/dsh-host-webserver` is composed. */
    webServer: WebServerService
    /** The UI slot registry (provided by the client runtime). */
    slots: SlotsService
    /** The client locale service (provided by the locale plugin). */
    locale: LocaleService
  }
}
