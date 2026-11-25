import { describe, expect, it } from 'vitest'
import { RUN_ERROR_COPY } from '../hub-api'
import { sharedDraftErrors } from './SharedDeploymentForm'
import { modeWords, SHARED_COPY, sharedGitlabOf } from './shared-api'
import {
  GITLAB_UPGRADE_STEPS,
  logLineWords,
  runnerOf,
  stepStates,
  UPGRADE_COPY,
  UPGRADE_STEPS
} from './shared-upgrade-api'

// A registered shared deployment the Hub upgrades through its GitLab pipeline: how the admin
// reads it (settings.gitlab + a driver), the run's steps and the words for its codes.

const row = (over: Record<string, unknown> = {}) => ({
  mode: 'registered' as const,
  driver_id: 4 as number | null,
  settings: {
    gitlab: { source_branch: 'release', target_branch: 'shared', deploy_job: null }
  } as Record<string, unknown>,
  ...over
})

describe('a GitLab-run shared deployment', () => {
  it('is registered, names a driver and settings.gitlab; anything else is not', () => {
    expect(sharedGitlabOf(row())).toEqual({
      source_branch: 'release',
      target_branch: 'shared',
      pin_file: null,
      before_job: null,
      deploy_job: null
    })
    expect(sharedGitlabOf(row({ driver_id: null }))).toBeNull()
    expect(sharedGitlabOf(row({ settings: {} }))).toBeNull()
    expect(sharedGitlabOf(row({ mode: 'docker' }))).toBeNull()
    expect(modeWords(row()).label).toBe('Run by GitLab')
    expect(modeWords(row({ driver_id: null })).label).toBe('Run elsewhere')
  })

  it('its run shows the GitLab steps; a Docker run keeps its own', () => {
    const plan = { runner: 'gitlab' } as never
    expect(runnerOf({ plan })).toBe('gitlab')
    expect(runnerOf({ plan: null })).toBe('agent')
    expect(stepStates({ status: 'running', step: 'deploy', plan })).toEqual([
      'done',
      'running',
      'pending',
      'pending',
      'pending'
    ])
    expect(GITLAB_UPGRADE_STEPS.map((s) => s.key)).toEqual([
      'push',
      'deploy',
      'wait_version',
      'wait_schema',
      'verify'
    ])
    expect(stepStates({ status: 'running', step: 'apply' })).toEqual([
      'done',
      'running',
      'pending',
      'pending',
      'pending'
    ])
    expect(UPGRADE_STEPS[0].key).toBe('render')
    expect(logLineWords('push: started')).toBe('Pin the version in GitLab: started')
  })

  it('the form asks for the driver and a release branch only when the Hub upgrades it', () => {
    const draft = {
      name: 'One',
      key: 'shared-one',
      mode: 'registered' as const,
      driver_id: '',
      stack: '',
      link_url: 'https://shared-one.example.com',
      host_pattern: '',
      extensions: '',
      pins: '',
      pool_budget: '60',
      size: 'small' as const,
      redis: 'bundled' as const,
      upgrades: 'watch' as const,
      gl_driver_id: '',
      gl_source: '',
      gl_target: '',
      gl_pin: '',
      gl_before: '',
      gl_deploy: ''
    }
    expect(sharedDraftErrors(draft, true)).toEqual({})
    const gl = sharedDraftErrors(
      { ...draft, upgrades: 'gitlab', gl_target: 'has space', gl_pin: '../x' },
      true
    )
    expect(Object.keys(gl).sort()).toEqual(['gl_driver_id', 'gl_pin', 'gl_source', 'gl_target'])
    expect(
      sharedDraftErrors(
        { ...draft, upgrades: 'gitlab', gl_driver_id: '4', gl_source: 'main', gl_target: 'shared' },
        true
      )
    ).toEqual({})
    // The deploy branch is required, a git branch name, and not the release branch.
    const same = { ...draft, upgrades: 'gitlab' as const, gl_driver_id: '4', gl_source: 'main' }
    expect(Object.keys(sharedDraftErrors({ ...same, gl_target: '' }, true))).toEqual(['gl_target'])
    expect(Object.keys(sharedDraftErrors({ ...same, gl_target: 'main' }, true))).toEqual([
      'gl_target'
    ])
    expect(Object.keys(sharedDraftErrors({ ...same, gl_target: 'x.lock' }, true))).toEqual([
      'gl_target'
    ])
    expect(draft.gl_source).toBe('')
  })

  it('has plain words for the codes a GitLab plan, run and save stop with', () => {
    for (const c of [
      'GITLAB_UNREACHABLE',
      'NO_SOURCE_COMMIT',
      'PIN_CHANGED',
      'ALREADY_RUNS',
      'ROLLBACK_NOT_RECORDED',
      'ROLLBACK_NO_BUILD',
      'BRANCH_IN_USE',
      'BRANCH_BUSY',
      'PIPELINE_RUNNING',
      'LINK_UNREACHABLE'
    ])
      expect(UPGRADE_COPY[c]?.title).toBeTruthy()
    for (const c of [
      'DEPLOY_FAILED',
      'MERGE_REFUSED',
      'HEAD_MOVED',
      'DRIVER_CHANGED',
      'LINK_UNREACHABLE',
      'BRANCH_BUSY'
    ])
      expect(RUN_ERROR_COPY[c]?.title).toBeTruthy()
    for (const c of ['DRIVER_NOT_GITLAB', 'BAD_GITLAB', 'BRANCH_IN_USE'])
      expect(SHARED_COPY[c]?.title).toBeTruthy()
  })
})
