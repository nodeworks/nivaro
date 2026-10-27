import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { pipelineOutline } from './pipeline-outline.js'

/**
 * Reads a template's states + transitions and shapes them with pipelineOutline.
 * The one loader behind GET /pipelines/:id/outline and the Teams notification
 * card's transition buttons. Null = no such template.
 */
export async function loadPipelineOutline(
  templateId: string,
  caller: { isAdmin: boolean; role: string | null }
) {
  const template = await db('nivaro_workflow_templates')
    .where({ id: templateId })
    .first('id', 'name')
  if (!template) return null
  const [states, transitions] = await Promise.all([
    db('nivaro_workflow_states')
      .where({ template: templateId })
      .orderBy('sort')
      .orderBy('label')
      .select('id', 'key', 'label', 'color', 'sort', 'is_initial', 'is_terminal'),
    db('nivaro_workflow_transitions')
      .where({ template: templateId })
      .orderBy('sort')
      .orderBy('label')
      .select(
        'id',
        'label',
        'from_state',
        'to_state',
        'color',
        'sort',
        'group_label',
        'required_roles',
        'auto_trigger',
        'require_owner',
        ...((await hasColumn('nivaro_workflow_transitions', 'allow_creator'))
          ? ['allow_creator']
          : [])
      )
  ])
  const outline = pipelineOutline(states, transitions, caller)
  return { id: template.id, name: template.name ?? null, ...outline }
}
