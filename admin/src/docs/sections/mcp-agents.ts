import type { DocSection } from '../types.js'

/**
 * Agents working with people (#3210 agent triggers, #3220 ask_human, #3223 agents as task
 * assignees).
 */
export const mcpAgentsDocs: DocSection = {
  id: 'mcp-agents',
  label: 'Agents that work with people',
  content: [
    { type: 'h1', id: 'mcp-agents', text: 'Agents that work with people' },
    {
      type: 'p',
      text: 'An assistant connected over MCP can do more than answer when spoken to: a record event can **wake** it, it can **ask a person** a question and wait for the answer, and it can be **handed a task** like a colleague. In every case it acts as the person it is connected for — their role, field access and User Scopes decide what it sees and changes.'
    },

    {
      type: 'h2',
      id: 'mcp-agent-triggers',
      text: 'Agent triggers — wake an agent on a record event'
    },
    {
      type: 'p',
      text: 'MCP → **Agent triggers** (administrators). A trigger watches one collection and wakes a remote agent or routine when a record is **created**, **changed** or **moves** to a state — optionally only for records matching its conditions (`field` / comparison / value, all must hold; dotted names follow a relation) and only for the states you list. Nivaro then POSTs a JSON body to the trigger’s HTTPS endpoint:'
    },
    {
      type: 'pre',
      code: '{\n  "type": "nivaro.agent_trigger",\n  "delivery_id": "6f0c…",          // same on every retry: drop repeats\n  "trigger": { "id": 3, "name": "Review new POs" },\n  "instructions": "Check the vendor…",\n  "event": "create",                // create | update | transition | flow\n  "collection": "purchase_orders", "item": "4821",\n  "changed_fields": [],             // update only\n  "transition": null,               // transition: label, from_state, to_state\n  "record": { "id": 4821, … },      // as the trigger OWNER reads it\n  "link": "https://<your-nivaro>/collections/purchase_orders/4821",\n  "mcp_url": "https://<your-nivaro>/api/mcp"\n}'
    },
    {
      type: 'ul',
      items: [
        '**Owner.** The record is read as the trigger’s owner (you, or a service account you pick): a field they cannot read is never sent, and a record they cannot see is not sent at all (the delivery is logged as skipped, with the reason). Leave "Sends" empty for every field the owner may read, or list the fields.',
        '**Signature.** Headers `X-Nivaro-Signature: sha256=<hex>` — HMAC-SHA256 of `<X-Nivaro-Timestamp>.<raw body>` with the trigger’s signing secret — plus `X-Nivaro-Timestamp` (unix seconds), `X-Nivaro-Delivery`, `X-Nivaro-Event`, `X-Nivaro-Attempt`. Refuse timestamps older than five minutes.',
        '**Delivery.** HTTPS only, through the SSRF guard, 15 s per attempt, redirects never followed. A 2xx is delivered. A 5xx, 408, 409, 425, 429 or no answer is retried — 30 s, 2 min, 10 min, 30 min, 2 h, 6 h — up to the trigger’s attempts; any other 4xx is final at once.',
        '**Dead letters.** A wake-up that gives up is kept as a dead letter (the owner is notified once): **Retry** sends the same signed body once more, **Discard** drops it. Every wake-up is in the trigger’s log with the body sent and the endpoint’s answer.',
        '**Preview** shows the exact body one record would produce, read as the owner, without sending. **Send a test** posts a signed test ping (`type: nivaro.agent_trigger.test`, no record).',
        'From a flow, the **Wake an agent** operation posts the same body for the flow’s record (the trigger’s own events and conditions are not applied — the flow decides).'
      ]
    },
    {
      type: 'note',
      text: 'An assistant can never create or change agent triggers itself: the routes refuse every MCP tool call and connected-app token. The woken agent calls back through `mcp_url` with its own connection to read more or act.'
    },

    { type: 'h2', id: 'mcp-ask-human', text: 'ask_human — an agent asks a person' },
    {
      type: 'p',
      text: 'The MCP tool `ask_human` posts a question — free text, or up to ten choices — to a person’s inbox: to the connection’s own person by default, or to anyone by user id (`find_people`). It arrives as a notification and at the top of **My Work** under *Questions from assistants*, where a choice is one click and free text is a short reply; a free-text question can also be answered straight from the notification.'
    },
    {
      type: 'ul',
      items: [
        '`get_human_answer {question_id, wait_seconds}` reads the answer, holding the call up to 25 s for it. `my_work` lists answers the connection has not collected (once each). In a live MCP session (`/api/mcp?live=1`) subscribe to the question’s `resource_uri` (`nivaro://question/<id>`) and a resources/updated notice arrives the moment it is answered, expires or is withdrawn.',
        'Only the person asked can answer, and only from their own signed-in browser — never through MCP, an API key, an OAuth token, a static token or View-as. An agent cannot answer its own question.',
        'Questions expire (default 24 hours, 5 minutes to 7 days via `expires_in_minutes`). `cancel_question` withdraws one. A connection may have 25 open questions, 5 to any one person.',
        'REST: `POST /api/agent-questions`, `GET /api/agent-questions/:id?wait=`, `GET /mine`, `GET /asked?status=`, `POST /:id/answer` (session only), `POST /:id/cancel`.'
      ]
    },

    { type: 'h2', id: 'mcp-agent-tasks', text: 'Agents as task assignees' },
    {
      type: 'p',
      text: 'On a record’s Tasks, **An agent** hands a task to one of your connected assistants (an OAuth app or an API key; an administrator can pick anyone’s). The task stays assigned to the person the agent acts for — so it shows in their My Work with the agent’s name — and the agent finds it in `my_work` → `agent_tasks`. It picks it up with `update_task` (status `in_progress`), finishes with `complete_task`, and can hand itself new tasks with `create_task` `agent: "self"`.'
    },
    {
      type: 'ul',
      items: [
        'REST: `POST /api/tasks` and `PATCH /api/tasks/:id` take `agent` (`o<grant id>` | `k<api key id>`, `"self"` from an agent connection; `null` takes it back). `GET /api/tasks/agents` lists the connections you may hand tasks to; `GET /api/tasks?agent=mine` lists the calling connection’s tasks.',
        'Reassigning the task to someone else takes it back from the agent. The task’s history says when it was handed to an agent and taken back.'
      ]
    }
  ]
}
