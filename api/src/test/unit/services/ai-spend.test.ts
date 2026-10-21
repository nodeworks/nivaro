import { describe, expect, it } from 'vitest'
import { priceFor, setPriceOverrides } from '../../../services/ai-log.js'
import {
  type BudgetCap,
  DEFAULT_QUALITY,
  normalizeBills,
  normalizeCatalogue,
  normalizePrices,
  parseQualityConfig
} from '../../../services/ai-quality.js'
import {
  capAlerts,
  daysInMonth,
  explainGap,
  monthlyLimit,
  nextMonth,
  parseBillsCsv,
  pct,
  prevMonth,
  priceSource,
  project
} from '../../../services/ai-spend.js'

const cap = (o: Partial<BudgetCap> = {}): BudgetCap => ({
  id: 'c1',
  who: 'everyone',
  who_id: null,
  feature: null,
  pooled: false,
  daily_usd: 1,
  cheaper_model: null,
  ...o
})

describe('AI spend forecast (#2473)', () => {
  it('does month arithmetic across year ends and leap years', () => {
    expect(nextMonth('2026-12')).toBe('2027-01')
    expect(prevMonth('2027-01')).toBe('2026-12')
    expect(daysInMonth('2028-02')).toBe(29)
    expect(daysInMonth('2026-10')).toBe(31)
  })

  it('projects the month from spend so far plus the recent daily rate', () => {
    // $10 in 10 days, last 7 finished days cost $14 ($2/day), 21 days left
    expect(project(10, 14, 7, 10, 31)).toBeCloseTo(10 + 2 * 21)
  })

  it('falls back to the month-to-date pace on the first day', () => {
    expect(project(3, 0, 0, 1.5, 30)).toBeCloseTo(3 + (3 / 1.5) * 28.5)
    expect(project(0, 0, 0, 0.25, 30)).toBe(0)
  })

  it('never projects below what is already spent', () => {
    expect(project(50, 0, 7, 31, 31)).toBe(50)
  })

  it('compares with last month, null when there is none', () => {
    expect(pct(150, 100)).toBe(50)
    expect(pct(10, 0)).toBeNull()
  })

  it('turns a daily cap into a month limit', () => {
    expect(monthlyLimit(cap({ daily_usd: 2 }), 30)).toBe(60)
  })

  it('flags a person whose projection passes the cap', () => {
    const names = new Map([['U1', 'Ada Lovelace']])
    const alerts = capAlerts(
      [cap({ daily_usd: 1 })],
      [
        { user: 'U1', feature: 'chat', role: null, mtd: 20, recent: 14 },
        { user: 'U2', feature: 'chat', role: null, mtd: 1, recent: 1 }
      ],
      '2026-10',
      31,
      10,
      7,
      names
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].key).toBe('2026-10:budget:c1')
    expect(alerts[0].message).toContain('Ada Lovelace')
    expect(alerts[0].limit_usd).toBe(31)
  })

  it('judges a pooled cap on the shared total and a feature cap on that feature', () => {
    const cells = [
      { user: 'U1', feature: 'chat', role: null, mtd: 10, recent: 7 },
      { user: 'U2', feature: 'generate', role: null, mtd: 10, recent: 7 }
    ]
    const names = new Map<string, string>()
    const pooled = capAlerts(
      [cap({ pooled: true, daily_usd: 1 })],
      cells,
      '2026-10',
      31,
      10,
      7,
      names
    )
    expect(pooled).toHaveLength(1)
    const generate = capAlerts(
      [cap({ pooled: true, feature: 'generate', daily_usd: 5 })],
      cells,
      '2026-10',
      31,
      10,
      7,
      names
    )
    expect(generate).toHaveLength(0)
  })
})

describe('AI spend reconciliation (#2764)', () => {
  it('parses month,model,usd lines with or without a header and a $', () => {
    expect(
      parseBillsCsv(
        'month,model,usd\n2026-09,claude-4-6-sonnet,"$412.50"\n2026-09,claude-4-5-haiku,12\n2026-10,88'
      )
    ).toEqual({
      '2026-09': { 'claude-4-6-sonnet': 412.5, 'claude-4-5-haiku': 12 },
      '2026-10': { '*': 88 }
    })
  })

  it('keeps only well-formed months, models and amounts', () => {
    expect(normalizeBills({ '2026-13': { a: 1 }, '2026-09': { a: -2, b: 3 }, nope: {} })).toEqual({
      '2026-09': { b: 3 }
    })
  })

  it('lets a price set by an admin beat the built-in one, and says where a price came from', () => {
    const prices = normalizePrices({
      'claude-4-6-sonnet': { input: 2, output: 10 },
      bad: { input: 'x' }
    })
    expect(prices).toEqual({ 'claude-4-6-sonnet': { input: 2, output: 10, cached: 2 } })
    setPriceOverrides(prices)
    expect(priceFor('claude-4-6-sonnet')?.input).toBe(2)
    expect(priceFor('claude-4-5-haiku')?.input).toBe(0.9)
    const cfg = { ...DEFAULT_QUALITY, prices }
    expect(priceSource('claude-4-6-sonnet', cfg)).toBe('setting')
    expect(priceSource('claude-4-5-haiku', cfg)).toBe('built-in')
    expect(priceSource('mystery', cfg)).toBe('none')
    setPriceOverrides({})
    expect(priceFor('claude-4-6-sonnet')?.input).toBe(2.7)
  })

  it('names the likely cause of a gap', () => {
    const base = { billed_usd: 120 as number | null, gap_pct: 16.7 as number | null }
    const row = (o: object) => ({
      ...base,
      models: [
        {
          model: 'a',
          logged_usd: 50,
          billed_usd: 60,
          gap_usd: 10,
          factor: 1.2,
          price_source: 'built-in' as const,
          calls: 4
        },
        {
          model: 'b',
          logged_usd: 50,
          billed_usd: 60,
          gap_usd: 10,
          factor: 1.2,
          price_source: 'built-in' as const,
          calls: 4
        }
      ],
      ...o
    })
    expect(explainGap(row({}))).toContain('prices are probably out of date')
    expect(explainGap(row({ gap_pct: 1 }))).toBe('The log matches the bill.')
    expect(explainGap(row({ billed_usd: null }))).toContain('Enter the')
    expect(
      explainGap(
        row({
          models: [
            {
              model: 'x',
              logged_usd: 0,
              billed_usd: 5,
              gap_usd: 5,
              factor: null,
              price_source: 'none',
              calls: 9
            }
          ]
        })
      )
    ).toContain('no price')
    expect(explainGap(row({ gap_pct: -20 }))).toContain('log is higher')
  })

  it('reads the new config keys leniently', () => {
    const cfg = parseQualityConfig(
      JSON.stringify({
        _quality: {
          prices: { m: { input: 1, output: 2 } },
          bills: { '2026-09': { '*': 10 } },
          forecast_alert_pct: 25,
          catalogue: { enabled: false }
        }
      })
    )
    expect(cfg.forecast_alert_pct).toBe(25)
    expect(cfg.catalogue).toEqual({ enabled: false, auto_trial: true, auto_trial_max_usd: 1 })
    expect(parseQualityConfig(null).forecast_alert_pct).toBeNull()
    expect(normalizeCatalogue({ auto_trial_max_usd: 'x' }).auto_trial_max_usd).toBe(1)
  })
})
