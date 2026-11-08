/**
 * A Teams card move refused because someone else is editing the record right
 * now (record-transition.ts lockedMoveRefusal). A card has no "move anyway",
 * so it says who is editing and points to the record (army 11 review).
 */
export function teamsLockedMoveText(holder: string | null | undefined): string {
  const who = typeof holder === 'string' && holder.trim() ? holder.trim() : 'Someone else'
  return `${who} is editing this record right now. Try again once they have saved, or open it in Nivaro.`
}
