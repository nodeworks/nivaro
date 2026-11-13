import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import {
  DEFAULT_NOTICE_MESSAGE,
  ENVIRONMENT_NOTICE_DEFAULTS,
  normalizeNoticeSettings,
  resolveNotice
} from './environment-notice.js'

// Rob 2026-11-13: staging sign-in needs an unmissable "this is staging", configurable per
// environment in Nivaro.
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv
const D = ENVIRONMENT_NOTICE_DEFAULTS

describe('resolveNotice', () => {
  it('auto: shown off production with the environment name and the default sentence', () => {
    expect(resolveNotice(D, env({ NIVARO_ENVIRONMENT: 'staging' }))).toEqual({
      label: 'Staging',
      message: DEFAULT_NOTICE_MESSAGE,
      production_url: null,
      in_admin_app: true
    })
    expect(
      resolveNotice(D, env({ NIVARO_INSTANCE: 'staging', NODE_ENV: 'production' }))?.label
    ).toBe('Staging')
  })

  it('auto: nothing on production; on/off override the default either way', () => {
    expect(resolveNotice(D, env({ NIVARO_ENVIRONMENT: 'production' }))).toBeNull()
    expect(
      resolveNotice({ ...D, show: 'on' }, env({ NIVARO_ENVIRONMENT: 'production' }))?.label
    ).toBe('Production')
    expect(resolveNotice({ ...D, show: 'off' }, env({ NIVARO_ENVIRONMENT: 'staging' }))).toBeNull()
  })

  it('ENVIRONMENT_NOTICE=on|off wins over the stored value; cloud never shows it', () => {
    expect(
      resolveNotice(
        { ...D, show: 'off' },
        env({ NIVARO_ENVIRONMENT: 'staging', ENVIRONMENT_NOTICE: 'on' })
      )
    ).not.toBeNull()
    expect(
      resolveNotice(D, env({ NIVARO_ENVIRONMENT: 'staging', ENVIRONMENT_NOTICE: 'off' }))
    ).toBeNull()
    expect(
      resolveNotice(D, env({ NIVARO_ENVIRONMENT: 'staging', CLOUD_META_DB_URL: 'x' }))
    ).toBeNull()
  })

  it('own label, sentence and production link; the env link as fallback; never a link on production', () => {
    const s = normalizeNoticeSettings({
      label: '  Training ',
      message: 'Practice here.',
      production_url: 'https://efp.example.com/login'
    })
    expect(resolveNotice(s, env({ NIVARO_ENVIRONMENT: 'staging' }))).toMatchObject({
      label: 'Training',
      message: 'Practice here.',
      production_url: 'https://efp.example.com'
    })
    expect(
      resolveNotice(
        D,
        env({ NIVARO_ENVIRONMENT: 'staging', NIVARO_PRODUCTION_URL: 'https://p.example.com' })
      )?.production_url
    ).toBe('https://p.example.com')
    expect(
      resolveNotice({ ...s, show: 'on' }, env({ NIVARO_ENVIRONMENT: 'production' }))?.production_url
    ).toBeNull()
  })
})

describe('normalizeNoticeSettings', () => {
  it('drops what it cannot use', () => {
    expect(
      normalizeNoticeSettings({
        show: 'sometimes',
        label: '',
        message: 42,
        production_url: 'http://plain.example.com',
        in_admin_app: false
      })
    ).toEqual({
      show: 'auto',
      label: null,
      message: null,
      production_url: null,
      in_admin_app: false
    })
    expect(normalizeNoticeSettings(null)).toEqual(D)
  })
})
