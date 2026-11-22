// The deploy key marker (ruling P3-22): the one line deploy.sh and the swarm manager's
// nivaro-hub-deploy print (exit 77) when this app's deploy key is not installed or the stack is
// bound to another key. Pure, so the deploy template's tests read exactly the Hub's matcher.

/** The marker line deploy.sh and the manager's nivaro-hub-deploy print (exit 77). */
export const KEY_NOT_INSTALLED = 'NIVARO_HUB_KEY_NOT_INSTALLED'

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes in job logs
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g
const SECTION = /section_(start|end):\d+:[A-Za-z0-9_.-]+(\[[^\]]*\])?/g
/** GitLab's timestamped log prefix: `2024-07-02T08:05:44.123456Z 01O ` (stream + flags). */
const STAMP = /^\d{4}-\d\d-\d\dT[0-9:.]+Z \d+[OE]\+? ?/

/**
 * Whether a job log holds the marker as a line of its own (colour codes and GitLab section
 * markers removed, split on CR / LF, the timestamp prefix removed, trimmed). deploy.sh drops
 * every remote stderr line that still holds the marker after the first two removals, so only
 * its own line can match here.
 */
export function hasKeyNotInstalledLine(log: string): boolean {
  const clean = String(log ?? '')
    .replace(ANSI, '')
    .replace(SECTION, '')
  return clean
    .split(/\r\n|\n|\r/)
    .some((line) => line.replace(STAMP, '').trim() === KEY_NOT_INSTALLED)
}
