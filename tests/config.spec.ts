import { describe, expect, it } from 'vitest'
import { resolveHostTimeZone } from '../src/aggregate/day.ts'
import { Config } from '../src/config.ts'

describe('Config', () => {
  it('resolves every host-derived default', () => {
    const config = Config({})
    expect(config.cacheTtlMs).toBe(30_000)
    expect(config.timeZone).toBe(resolveHostTimeZone())
    expect(config.dictionaryPath).toMatch(/^\/.*\/zstd-dictionary\.bin$/)
    expect(config.databasePath).toBeUndefined()
  })

  it('keeps explicitly configured values', () => {
    const config = Config({
      databasePath: '/var/lib/dsh/sessions.sqlite',
      dictionaryPath: '/opt/dsh/dictionary.bin',
      timeZone: 'UTC',
      cacheTtlMs: 5,
    })
    expect(config).toEqual({
      databasePath: '/var/lib/dsh/sessions.sqlite',
      dictionaryPath: '/opt/dsh/dictionary.bin',
      timeZone: 'UTC',
      cacheTtlMs: 5,
    })
  })

  it('accepts zero as the cache lifetime that disables caching', () => {
    expect(Config({ cacheTtlMs: 0 }).cacheTtlMs).toBe(0)
  })

  it('rejects a negative or non-numeric cache lifetime', () => {
    expect(() => Config({ cacheTtlMs: -1 })).toThrow()
    expect(() => Config({ cacheTtlMs: 'soon' as unknown as number })).toThrow()
  })

  it('rejects a mistyped path or zone', () => {
    expect(() => Config({ databasePath: 7 as unknown as string })).toThrow()
    expect(() => Config({ timeZone: ['UTC'] as unknown as string })).toThrow()
  })
})
