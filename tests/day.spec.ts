/**
 * Behavior of the local-calendar-day helpers.
 *
 * The zone cases are chosen so a constant offset cannot pass: Los Angeles
 * changes offset across the two 2026 transition days, while Shanghai does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLocalDayKey, localDayBounds, localDayKey, resolveHostTimeZone } from '../src/aggregate/day.ts'

const HOUR = 3_600_000
const DAY = 86_400_000
const FIFTEEN_MINUTES = 900_000
const LOS_ANGELES = 'America/Los_Angeles'
const SHANGHAI = 'Asia/Shanghai'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('localDayBounds', () => {
  it('resolves the verified reference day in America/Los_Angeles', () => {
    expect(localDayBounds('2026-09-21', LOS_ANGELES)).toEqual({ start: 1789974000000, end: 1790060400000 })
  })

  it('makes the spring-forward day 23 hours long', () => {
    const { start, end } = localDayBounds('2026-03-08', LOS_ANGELES)
    expect(start).toBe(1772956800000)
    expect(end).toBe(1773039600000)
    expect(end - start).toBe(23 * HOUR)
  })

  it('makes the fall-back day 25 hours long', () => {
    const { start, end } = localDayBounds('2026-11-01', LOS_ANGELES)
    expect(start).toBe(1793516400000)
    expect(end).toBe(1793606400000)
    expect(end - start).toBe(25 * HOUR)
  })

  it('reads the zone offset in force at each boundary instead of a constant one', () => {
    // Los Angeles is UTC-8 in January and UTC-7 in July, so one fixed offset cannot serve both.
    expect(localDayBounds('2026-01-15', LOS_ANGELES).start - Date.UTC(2026, 0, 15)).toBe(8 * HOUR)
    expect(localDayBounds('2026-07-15', LOS_ANGELES).start - Date.UTC(2026, 6, 15)).toBe(7 * HOUR)
  })

  it('resolves a fixed-offset zone to its constant UTC+8 midnight', () => {
    expect(localDayBounds('2026-09-21', SHANGHAI)).toEqual({ start: 1789920000000, end: 1790006400000 })
    expect(localDayBounds('2026-07-15', SHANGHAI).end - localDayBounds('2026-07-15', SHANGHAI).start).toBe(DAY)
  })

  it('keeps the range half-open and contiguous across a transition', () => {
    expect(localDayBounds('2026-03-08', LOS_ANGELES).end).toBe(localDayBounds('2026-03-09', LOS_ANGELES).start)
    expect(localDayBounds('2026-11-01', LOS_ANGELES).end).toBe(localDayBounds('2026-11-02', LOS_ANGELES).start)
  })
})

describe('localDayKey', () => {
  it('round-trips every instant of a local day back to that day', () => {
    const cases = [
      ['2026-09-21', LOS_ANGELES],
      ['2026-03-08', LOS_ANGELES],
      ['2026-11-01', LOS_ANGELES],
      ['2026-09-21', SHANGHAI],
    ] as const
    for (const [date, timeZone] of cases) {
      const { start, end } = localDayBounds(date, timeZone)
      for (let time = start; time < end; time += FIFTEEN_MINUTES) expect(localDayKey(time, timeZone)).toBe(date)
      expect(localDayKey(end - 1, timeZone)).toBe(date)
    }
  })

  it('advances to the next day exactly at the exclusive end', () => {
    const { start, end } = localDayBounds('2026-03-08', LOS_ANGELES)
    expect(localDayKey(start - 1, LOS_ANGELES)).toBe('2026-03-07')
    expect(localDayKey(start, LOS_ANGELES)).toBe('2026-03-08')
    expect(localDayKey(end - 1, LOS_ANGELES)).toBe('2026-03-08')
    expect(localDayKey(end, LOS_ANGELES)).toBe('2026-03-09')
  })

  it('reports the zone-local calendar day rather than the UTC one', () => {
    // 2026-09-20T17:30:00Z is still the 20th in Los Angeles but already the 21st in Shanghai.
    const instant = Date.UTC(2026, 8, 20, 17, 30)
    expect(localDayKey(instant, LOS_ANGELES)).toBe('2026-09-20')
    expect(localDayKey(instant, SHANGHAI)).toBe('2026-09-21')
  })

  it('zero-pads single-digit months and days', () => {
    expect(localDayKey(Date.UTC(2026, 0, 5, 12), 'UTC')).toBe('2026-01-05')
  })
})

describe('isLocalDayKey', () => {
  it('accepts zero-padded real calendar dates', () => {
    expect(isLocalDayKey('2026-09-21')).toBe(true)
    expect(isLocalDayKey('2024-02-29')).toBe(true)
    expect(isLocalDayKey('1999-12-31')).toBe(true)
  })

  it('rejects impossible dates, unpadded fields, and other malformed strings', () => {
    const rejected = [
      '2026-02-30',
      '2026-09-31',
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-9-1',
      '26-09-21',
      '2026-09-21T00:00:00Z',
      '2026-09-2 1',
      '',
    ]
    for (const value of rejected) expect(isLocalDayKey(value), value).toBe(false)
  })
})

describe('resolveHostTimeZone', () => {
  it('reports a zone the platform can resolve', () => {
    const zone = resolveHostTimeZone()
    expect(zone.length).toBeGreaterThan(0)
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone })).not.toThrow()
  })

  it('falls back to UTC when Intl reports no zone', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat')
    spy.mockReturnValue({ resolvedOptions: () => ({ timeZone: '' }) } as unknown as Intl.DateTimeFormat)
    expect(resolveHostTimeZone()).toBe('UTC')
    spy.mockReturnValue({ resolvedOptions: () => ({}) } as unknown as Intl.DateTimeFormat)
    expect(resolveHostTimeZone()).toBe('UTC')
  })
})
