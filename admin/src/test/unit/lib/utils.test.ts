import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  cn,
  formatDate,
  formatRelative,
  formatNumber,
  formatFileSize,
  titleCase,
} from '@/lib/utils'

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar')
  })

  it('handles conditional classes', () => {
    expect(cn('base', false && 'skipped', 'included')).toBe('base included')
    expect(cn('base', true && 'yes')).toBe('base yes')
  })

  it('dedupes tailwind conflicts — last one wins', () => {
    const result = cn('p-4', 'p-2')
    expect(result).toBe('p-2')
  })

  it('handles undefined and null gracefully', () => {
    expect(cn(undefined, null, 'valid')).toBe('valid')
  })

  it('returns empty string for no args', () => {
    expect(cn()).toBe('')
  })
})

describe('formatDate', () => {
  it('formats a date string to a readable form', () => {
    // Use a fixed date to avoid timezone-sensitive failures
    const result = formatDate('2024-01-15T12:00:00Z')
    expect(result).toMatch(/Jan/)
    expect(result).toMatch(/15/)
    expect(result).toMatch(/2024/)
  })

  it('accepts a Date object', () => {
    const result = formatDate(new Date('2024-06-15T12:00:00Z'))
    expect(result).toMatch(/Jun/)
    expect(result).toMatch(/2024/)
  })

  it('accepts custom Intl options', () => {
    const result = formatDate('2024-03-20', { month: 'long' })
    expect(result).toMatch(/March/)
  })
})

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-11T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for < 1 minute ago', () => {
    const d = new Date('2024-06-11T11:59:30Z')
    expect(formatRelative(d)).toBe('just now')
  })

  it('returns minutes ago for < 1 hour', () => {
    const d = new Date('2024-06-11T11:45:00Z')
    expect(formatRelative(d)).toBe('15m ago')
  })

  it('returns hours ago for < 24 hours', () => {
    const d = new Date('2024-06-11T09:00:00Z')
    expect(formatRelative(d)).toBe('3h ago')
  })

  it('returns days ago for < 7 days', () => {
    const d = new Date('2024-06-08T12:00:00Z')
    expect(formatRelative(d)).toBe('3d ago')
  })

  it('returns a formatted date string for >= 7 days ago', () => {
    const d = new Date('2024-05-01T12:00:00Z')
    const result = formatRelative(d)
    expect(result).toMatch(/May/)
    expect(result).toMatch(/2024/)
  })
})

describe('formatNumber', () => {
  it('formats a number with locale separators', () => {
    expect(formatNumber(1000)).toBe('1,000')
    expect(formatNumber(1000000)).toBe('1,000,000')
  })

  it('returns em dash for null', () => {
    expect(formatNumber(null)).toBe('—')
  })

  it('returns em dash for undefined', () => {
    expect(formatNumber(undefined)).toBe('—')
  })

  it('formats zero', () => {
    expect(formatNumber(0)).toBe('0')
  })

  it('formats negative numbers', () => {
    expect(formatNumber(-500)).toBe('-500')
  })
})

describe('formatFileSize', () => {
  it('returns em dash for null', () => {
    expect(formatFileSize(null)).toBe('—')
  })

  it('returns em dash for undefined', () => {
    expect(formatFileSize(undefined)).toBe('—')
  })

  it('formats bytes', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('formats kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024 - 1)).toMatch(/KB/)
  })

  it('formats megabytes', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })

  it('formats gigabytes', () => {
    expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB')
    expect(formatFileSize(1024 * 1024 * 1024 * 1.5)).toBe('1.50 GB')
  })
})

describe('titleCase', () => {
  it('converts snake_case to Title Case', () => {
    expect(titleCase('hello_world')).toBe('Hello World')
  })

  it('capitalises first letter of each word', () => {
    expect(titleCase('my field name')).toBe('My Field Name')
  })

  it('handles already-capitalised words', () => {
    expect(titleCase('FirstName')).toBe('FirstName')
  })

  it('handles single word', () => {
    expect(titleCase('title')).toBe('Title')
  })

  it('handles empty string', () => {
    expect(titleCase('')).toBe('')
  })

  it('replaces multiple underscores', () => {
    expect(titleCase('first_last_name')).toBe('First Last Name')
  })
})
