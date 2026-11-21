import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  pipelines: vi.fn(),
  jobs: vi.fn(),
  placement: vi.fn(),
  driver: vi.fn()
}))
vi.mock('../../../services/gitlab-client.js', () => ({
  gitlabPipelines: m.pipelines,
  gitlabJobs: m.jobs
}))
vi.mock('../../../services/hub/drivers.js', () => ({
  getPlacement: m.placement,
  getDriver: m.driver,
  driverCtx: () => ({
    provider: 'gitlab',
    base: 'https://g',
    project: 'a/b',
    token: 't',
    ref: null
  })
}))

import { listEnvironmentDeploys, versionFromSubject } from '../../../services/hub/deploys.js'

const driver = {
  id: 1,
  kind: 'gitlab',
  config: { branch: 'production', deploy_job: 'deploy_production' }
}

describe('hub deploys', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    m.placement.mockResolvedValue({ id: 3, driver_id: 1, target: {} })
    m.driver.mockResolvedValue(driver)
  })

  it('parses the version from the commit subject', () => {
    expect(versionFromSubject('chore: sync for nivaro 0.3.208')).toBe('0.3.208')
    expect(versionFromSubject('fix: something')).toBeNull()
    expect(versionFromSubject(undefined)).toBeNull()
  })

  it('maps pipelines with the deploy job and version', async () => {
    m.pipelines.mockResolvedValue([
      {
        id: 7,
        status: 'success',
        ref: 'production',
        sha: 'abcd1234',
        title: 'chore: sync for nivaro 0.3.208',
        web_url: 'u7',
        created_at: 'c',
        updated_at: 'f'
      }
    ])
    m.jobs.mockResolvedValue([
      {
        id: 1,
        name: 'build',
        status: 'success',
        started_at: null,
        finished_at: null,
        web_url: 'j1'
      },
      {
        id: 2,
        name: 'deploy_production',
        status: 'success',
        started_at: null,
        finished_at: null,
        web_url: 'j2'
      }
    ])
    const out = await listEnvironmentDeploys({ placement_id: 3 })
    expect(out.data).toEqual([
      {
        pipeline_id: 7,
        ref: 'production',
        sha: 'abcd1234',
        status: 'success',
        started_at: 'c',
        finished_at: 'f',
        web_url: 'u7',
        deploy_job: { status: 'success', web_url: 'j2' },
        version: '0.3.208'
      }
    ])
    // branch falls back to the driver's
    expect(m.pipelines.mock.calls[0][0].ref).toBe('production')
  })

  it('a pipeline without the job has deploy_job null', async () => {
    m.pipelines.mockResolvedValue([{ id: 8, status: 'failed', title: 'x' }])
    m.jobs.mockResolvedValue([
      { id: 1, name: 'build', status: 'success', started_at: null, finished_at: null, web_url: '' }
    ])
    const out = await listEnvironmentDeploys({ placement_id: 3 })
    expect(out.data[0].deploy_job).toBeNull()
    expect(out.data[0].version).toBeNull()
  })

  it('placement target branch beats the driver branch', async () => {
    m.placement.mockResolvedValue({ id: 3, driver_id: 1, target: { branch: 'staging' } })
    m.pipelines.mockResolvedValue([])
    await listEnvironmentDeploys({ placement_id: 3 })
    expect(m.pipelines.mock.calls[0][0].ref).toBe('staging')
  })

  it('no placement means NO_DRIVER', async () => {
    expect(await listEnvironmentDeploys({ placement_id: null })).toEqual({
      data: [],
      reason: 'NO_DRIVER'
    })
    m.placement.mockResolvedValue(null)
    expect(await listEnvironmentDeploys({ placement_id: 3 })).toEqual({
      data: [],
      reason: 'NO_DRIVER'
    })
  })

  it('GitLab failure is GITLAB_UNREACHABLE', async () => {
    m.pipelines.mockRejectedValue(new Error('GitLab answered 401'))
    await expect(listEnvironmentDeploys({ placement_id: 3 })).rejects.toMatchObject({
      code: 'GITLAB_UNREACHABLE'
    })
  })
})
