import type { ReactNode } from 'react'
import type { HotRow } from '../HotEntities'
import type { Registered } from './registry'

/**
 * Extra Hot entities columns, appended after the built-in ones. `cell` gets the row; read model
 * figures through useTrafficMap() in a component if the row does not carry them.
 */
export interface HotColumn extends Registered {
  header: string
  align?: 'left' | 'right'
  cell(row: HotRow): ReactNode
}

export const hotColumns: HotColumn[] = []

/** Safe cell: a throwing `cell` renders an empty cell. */
export function hotCell(c: HotColumn, row: HotRow): ReactNode {
  try {
    return c.cell(row)
  } catch {
    return null
  }
}
