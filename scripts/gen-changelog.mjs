/**
 * Generates a user-friendly changelog using Claude.
 * Usage: node scripts/gen-changelog.mjs <fromRef> <toRef> [productName]
 * Outputs markdown to stdout.
 */
import { execFileSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';

const [, , fromRef, toRef, productName = 'Nivaro'] = process.argv;

if (!toRef) {
  console.error('Usage: node scripts/gen-changelog.mjs <fromRef> <toRef> [productName]');
  process.exit(1);
}

const logRange = fromRef ? `${fromRef}..${toRef}` : toRef;

const gitArgs = fromRef
  ? ['log', `${fromRef}..${toRef}`, '--pretty=format:%s|||%b|||%h', '--no-merges']
  : ['log', toRef, '--pretty=format:%s|||%b|||%h', '--no-merges'];

let rawCommits;
try {
  rawCommits = execFileSync('git', gitArgs, { encoding: 'utf8' }).trim();
} catch {
  console.error(`Failed to get commits for range: ${fromRef ? `${fromRef}..${toRef}` : toRef}`);
  process.exit(1);
}

if (!rawCommits) {
  console.log('No changes in this release.');
  process.exit(0);
}

// Parse commits — subject | body | hash
const commits = rawCommits
  .split('\n')
  .map(line => {
    const [subject, body, hash] = line.split('|||');
    return { subject: subject.trim(), body: body.trim(), hash: hash.trim() };
  })
  .filter(c => c.subject);

const commitText = commits
  .map(c => {
    const bodyPart = c.body ? `\n  Details: ${c.body}` : '';
    return `- [${c.hash}] ${c.subject}${bodyPart}`;
  })
  .join('\n');

const client = new Anthropic();

const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 1024,
  messages: [
    {
      role: 'user',
      content: `You are writing release notes for ${productName}, a headless CMS platform.

Convert these git commits into a user-friendly changelog for end users (not developers).

Rules:
- Group into sections: ## What's New, ## Improvements, ## Bug Fixes
- Skip sections with no items
- Skip internal/tooling commits (chore, ci, build, test, docs, refactor, wip, typo, deps, release)
- Each item: one clear sentence in plain language, no technical jargon
- Do not mention commit hashes, file names, or function names
- If nothing meaningful remains after filtering, write: "Internal maintenance and dependency updates."
- No intro text, no closing text, just the sections

Commits:
${commitText}`,
    },
  ],
});

process.stdout.write(response.content[0].text.trim() + '\n');
