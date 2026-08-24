/**
 * Fiscal calendar helpers (#343). The instance's fiscal-year start month
 * lives on nivaro_settings.fiscal_year_start_month; hosts hydrate it via
 * setFiscalStartMonth (ItemEditForm does this from /settings). Convention:
 * a fiscal year is NAMED for the calendar year it ends in when the start
 * month is not January (Oct 2025 with start month 10 → FY2026).
 */

let _startMonth = 1

export function setFiscalStartMonth(m: number | null | undefined): void {
  const n = Number(m)
  _startMonth = Number.isFinite(n) && n >= 1 && n <= 12 ? n : 1
}

export function getFiscalStartMonth(): number {
  return _startMonth
}

export function fiscalYearOf(d: Date, startMonth = _startMonth): number {
  const month = d.getMonth() + 1
  if (startMonth <= 1) return d.getFullYear()
  return month >= startMonth ? d.getFullYear() + 1 : d.getFullYear()
}

export function fiscalQuarterOf(d: Date, startMonth = _startMonth): number {
  const offset = (d.getMonth() + 1 - startMonth + 12) % 12
  return Math.floor(offset / 3) + 1
}

/** "FY2026-Q1" — the FiscalPeriodField storage format. */
export function fiscalPeriodOf(d: Date, startMonth = _startMonth): string {
  return `FY${fiscalYearOf(d, startMonth)}-Q${fiscalQuarterOf(d, startMonth)}`
}
