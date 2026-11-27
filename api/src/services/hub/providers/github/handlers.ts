import { bad, HANDLERS, type Handler } from './resources.js'
import { EXTRA_HANDLERS } from './resources-extra.js'

/** Every GitHub type's handler: the Task 5 types (resources.ts) and the Task 19 ones. */
const ALL: Record<string, Handler> = { ...HANDLERS, ...EXTRA_HANDLERS }

export function handlerFor(type: string): Handler {
  const h = ALL[type]
  if (!h) bad('UNKNOWN_TYPE', `GitHub has no resource type ${type}.`)
  return h
}
