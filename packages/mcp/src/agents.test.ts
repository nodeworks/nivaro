import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSubscribableUri } from './record-resource.js'
import { connect, type Handler, mockClient, textOf } from './test-utils.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

const Q = '0b8f3c1e-1111-4a2b-9c3d-123456789abc'
const question = (over: Record<string, unknown> = {}) => ({
  id: Q,
  status: 'open',
  question: 'Ship the order today?',
  choices: ['Yes', 'No'],
  allow_text: false,
  collection: 'orders',
  item: '7',
  asked_by: 'Claude',
  asked_for: 'u-1',
  asked_for_name: 'Rob Lee',
  recipient: 'u-1',
  recipient_name: 'Rob Lee',
  answer: null,
  answer_choice: null,
  answered_at: null,
  expires_at: '2026-10-30T12:00:00.000Z',
  created_at: '2026-10-29T12:00:00.000Z',
  ...over
})

const call = (name: string, args: Record<string, unknown> = {}) =>
  mcp.callTool({ name, arguments: args })

describe('agent tools (#3220, #3223)', () => {
  beforeEach(async () => {
    answer = () => ({ data: [] })
    const mock = mockClient((c) => answer(c))
    calls = mock.calls
    mcp = (await connect(mock.client)).mcp
  })
  afterEach(async () => {
    await mcp.close()
  })

  it('ask_human posts the question and says how to read the answer', async () => {
    answer = () => ({ data: question() })
    const body = textOf(
      await call('ask_human', {
        question: 'Ship the order today?',
        choices: ['Yes', 'No'],
        collection: 'orders',
        id: 7
      })
    )
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/agent-questions',
      _body: { question: 'Ship the order today?', choices: ['Yes', 'No'], item: '7' }
    })
    expect(body).toMatchObject({
      question_id: Q,
      status: 'open',
      choices: ['Yes', 'No'],
      free_text_allowed: false,
      record: { collection: 'orders', id: '7' },
      resource_uri: `nivaro://question/${Q}`
    })
    expect(body.next).toMatch(/get_human_answer/)
  })

  it('ask_human with wait_seconds reads the question back holding for the answer', async () => {
    answer = (c) =>
      c._method === 'POST'
        ? { data: question() }
        : { data: question({ status: 'answered', answer_choice: 'Yes', answered_at: 't' }) }
    const body = textOf(await call('ask_human', { question: 'Ship it?', wait_seconds: 10 }))
    expect(calls[1]).toMatchObject({
      _method: 'GET',
      _path: `/agent-questions/${Q}`,
      _params: { wait: 10 }
    })
    expect(body).toMatchObject({ status: 'answered', answer: 'Yes' })
    expect(body.next).toBeUndefined()
  })

  it('refuses a record half-given', async () => {
    const res = await call('ask_human', { question: 'x', collection: 'orders' })
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('get_human_answer waits 20 s by default and returns the answer with a note', async () => {
    answer = () => ({
      data: question({ status: 'answered', answer_choice: 'No', answer: 'Stock is short' })
    })
    const body = textOf(await call('get_human_answer', { question_id: Q }))
    expect(calls[0]).toMatchObject({ _path: `/agent-questions/${Q}`, _params: { wait: 20 } })
    expect(body).toMatchObject({ answer: 'No', note: 'Stock is short' })
  })

  it('cancel_question posts the cancel', async () => {
    answer = () => ({ data: question({ status: 'cancelled' }) })
    const body = textOf(await call('cancel_question', { question_id: Q }))
    expect(calls[0]).toMatchObject({ _method: 'POST', _path: `/agent-questions/${Q}/cancel` })
    expect(body.status).toBe('cancelled')
  })

  it('update_task patches only what was given, and refuses an empty change', async () => {
    answer = () => ({ data: { id: 4, title: 'Call', status: 'in_progress', agent_name: 'Claude' } })
    const body = textOf(await call('update_task', { task_id: 4, status: 'in_progress' }))
    expect(calls[0]).toMatchObject({
      _method: 'PATCH',
      _path: '/tasks/4',
      _body: { status: 'in_progress' }
    })
    expect(body).toMatchObject({ id: 4, status: 'in_progress', agent_name: 'Claude' })
    const empty = await call('update_task', { task_id: 4 })
    expect(empty.isError).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('create_task passes agent "self" through', async () => {
    answer = () => ({ data: { id: 9, title: 'Chase', status: 'open', delegated_from: null } })
    await call('create_task', { collection: 'orders', id: 7, title: 'Chase', agent: 'self' })
    expect(calls[0]).toMatchObject({ _path: '/tasks', _body: { agent: 'self', item: '7' } })
  })

  it('my_work shows agent tasks, answers and questions for an agent connection', async () => {
    answer = () => ({
      data: {
        owned: [],
        owned_total: 0,
        tasks: [],
        team_tasks: [],
        requested: [],
        approvals: [],
        notifications: [],
        questions: [question({ id: Q })],
        agent: { connection: 'k12' },
        agent_tasks: [{ id: 3, title: 'Reconcile', status: 'open', agent_name: 'Ops bot' }],
        answers: [question({ status: 'answered', answer: 'Go ahead' })],
        counts: {}
      }
    })
    const body = textOf(await call('my_work'))
    expect(body.agent_tasks).toEqual([
      { id: 3, title: 'Reconcile', status: 'open', agent_name: 'Ops bot' }
    ])
    expect(body.answers[0]).toMatchObject({ question_id: Q, answer: 'Go ahead' })
    expect(body.questions_for_you[0]).toMatchObject({ question_id: Q, status: 'open' })
  })

  it('my_work leaves the agent sections out for a person', async () => {
    answer = () => ({
      data: {
        owned: [],
        owned_total: 0,
        tasks: [],
        team_tasks: [],
        requested: [],
        approvals: [],
        notifications: [],
        questions: [],
        counts: {}
      }
    })
    const body = textOf(await call('my_work'))
    expect(body.agent_tasks).toBeUndefined()
    expect(body.answers).toBeUndefined()
    expect(body.questions_for_you).toBeUndefined()
  })

  it('reads a question resource', async () => {
    answer = () => ({ data: question() })
    const res = await mcp.readResource({ uri: `nivaro://question/${Q}` })
    expect(calls[0]).toMatchObject({ _path: `/agent-questions/${Q}` })
    expect(JSON.parse(String((res.contents[0] as { text: string }).text))).toMatchObject({
      question_id: Q
    })
  })
})

describe('parseSubscribableUri', () => {
  it('maps a question URI to the questions table and keeps record URIs', () => {
    expect(parseSubscribableUri(`nivaro://question/${Q.toUpperCase()}`)).toEqual({
      collection: 'nivaro_agent_questions',
      id: Q
    })
    expect(parseSubscribableUri('nivaro://record/orders/7')).toEqual({
      collection: 'orders',
      id: '7'
    })
    expect(parseSubscribableUri('nivaro://question/not-a-uuid')).toBeNull()
  })
})
