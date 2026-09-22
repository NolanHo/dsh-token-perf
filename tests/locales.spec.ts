import { describe, expect, it } from 'vitest'
import { createTranslator, dictionaryFor, en, LOCALE_NS, zh } from '../src/client/locales.ts'
import type { CopyKey } from '../src/client/locales.ts'

/** The `{placeholder}` names one template carries, in a stable order. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
}

describe('client dictionaries', () => {
  it('registers under one namespace', () => {
    expect(LOCALE_NS).toBe('dsh-token-perf')
  })

  it('covers exactly the same key set in both languages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('has no empty value', () => {
    const entries: Array<[string, string]> = [
      ...Object.entries(zh).map(([key, value]): [string, string] => [`zh.${key}`, value]),
      ...Object.entries(en).map(([key, value]): [string, string] => [`en.${key}`, value]),
    ]
    for (const [key, value] of entries) expect(value.trim(), key).not.toBe('')
  })

  it('keeps the same placeholders in both languages', () => {
    for (const key of Object.keys(zh) as CopyKey[]) {
      expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]))
    }
  })

  it('resolves the dictionary by language tag', () => {
    expect(dictionaryFor('zh')).toBe(zh)
    expect(dictionaryFor('zh-CN')).toBe(zh)
    expect(dictionaryFor('en-US')).toBe(en)
    expect(createTranslator(() => 'zh-CN')('settings.nav')).toBe(zh['settings.nav'])
    expect(createTranslator(() => 'en-US')('settings.nav')).toBe(en['settings.nav'])
  })

  it('fills placeholders and keeps an unfilled one literal', () => {
    const translate = createTranslator(() => 'en')
    expect(translate('state.loading', { date: '2026-09-21' })).toBe('Loading the report for 2026-09-21…')
    expect(translate('state.loading')).toBe('Loading the report for {date}…')
    expect(translate('error.http', { status: 404 })).toContain('404')
  })
})
