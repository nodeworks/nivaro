import { createContext, useContext } from 'react'

export interface AddendumHint {
  id: string
  title: string
  status: string
}

export type AddendumFieldMap = Record<string, AddendumHint[]>

export const AddendumFieldContext = createContext<AddendumFieldMap>({})
export const useAddendumFields = () => useContext(AddendumFieldContext)

// O2M row-level context — proposed rows per field per active addendum
export interface AddendumO2MEntry {
  addendumId: string
  addendumTitle: string
  addendumStatus: string
  rows: Array<Record<string, unknown>>
  /** Settled addendum (approved / reverted / imported): the lines BEFORE it,
   *  so the grid diffs rows (= after) against these instead of the live lines. */
  baseRows?: Array<Record<string, unknown>>
}

export type AddendumO2MMap = Record<string, AddendumO2MEntry[]>

export const AddendumO2MContext = createContext<AddendumO2MMap>({})
export const useAddendumO2M = () => useContext(AddendumO2MContext)

// Global addendum view selection — 'original' or an addendum id
export const AddendumViewContext = createContext<string>('original')
export const useAddendumView = () => useContext(AddendumViewContext)
