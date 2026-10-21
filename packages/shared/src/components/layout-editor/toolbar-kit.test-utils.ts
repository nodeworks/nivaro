import { act } from 'react'

// Test helpers for the editor's top bar menus (toolbar-kit BarMenu): a tool's
// row exists only while its menu is open.

const trigger = (menu: string) =>
  document.querySelector(`[data-bar-menu="${menu}"]`) as HTMLElement | null

/** Open a top bar menu ("Tools", "AI", "More", "Save options") so its rows render. */
export async function openBarMenu(menu: string): Promise<void> {
  const btn = trigger(menu)
  if (!btn) throw new Error(`no "${menu}" menu in the top bar`)
  if (btn.getAttribute('aria-expanded') !== 'true')
    await act(async () => {
      btn.click()
    })
}

/** Close a top bar menu left open (an on / off row keeps it open). Waits for
 *  Radix to hand focus back to the menu's button (it does so a tick later). */
export async function closeBarMenu(menu: string): Promise<void> {
  const btn = trigger(menu)
  if (btn?.getAttribute('aria-expanded') !== 'true') return
  await act(async () => {
    btn.click()
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** Open `menu`, click the row matching `selector`, and leave no menu open. */
export async function pickBarRow(menu: string, selector: string): Promise<void> {
  await openBarMenu(menu)
  const row = document.querySelector(`[data-bar-menu-list="${menu}"] ${selector}`)
  if (!row) throw new Error(`no ${selector} row in the "${menu}" menu`)
  await act(async () => {
    ;(row as HTMLElement).click()
  })
  await closeBarMenu(menu)
}
