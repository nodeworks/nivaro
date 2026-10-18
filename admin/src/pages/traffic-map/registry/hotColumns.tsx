import type { ComponentType, ReactNode } from 'react'
import type { HotRow } from '../HotEntities'
import type { TrafficModel } from '../model'
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

/** Controls in the Hot entities header (right side): a sort or filter a feature owns (#2144). */
export interface HotHeaderItem extends Registered {
  Component: ComponentType
}
export const hotHeaderItems: HotHeaderItem[] = []

/**
 * Re-order or filter the hot rows (#2144: by health). Applied in order to the full ranked list
 * before it is cut to the table's length; return the rows unchanged when inactive.
 */
export interface HotRowTransform extends Registered {
  active(): boolean
  apply(rows: HotRow[], model: TrafficModel, win: number): HotRow[]
}
export const hotRowTransforms: HotRowTransform[] = []

/** The hot rows after every active transform (a throwing one is skipped). */
export function transformHotRows(rows: HotRow[], model: TrafficModel, win: number): HotRow[] {
  let out = rows
  for (const t of hotRowTransforms) {
    try {
      if (t.active()) out = t.apply(out, model, win)
    } catch {
      /* a broken transform leaves the rows alone */
    }
  }
  return out
}

/** True when some transform is active (the page then ranks the whole list before cutting). */
export function hotRowsTransformed(): boolean {
  return hotRowTransforms.some((t) => {
    try {
      return t.active()
    } catch {
      return false
    }
  })
}
