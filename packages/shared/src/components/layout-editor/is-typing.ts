/** Is the key going into a text box (where its own undo, ⌘D, arrows win)? */
export const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null
  if (!t?.closest) return false
  return (
    t.isContentEditable ||
    !!t.closest(
      'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])'
    )
  )
}
