import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const pkgPath = 'package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const bump = process.argv[2];
let newVersion;

if (bump === 'major') newVersion = `${major + 1}.0.0`;
else if (bump === 'minor') newVersion = `${major}.${minor + 1}.0`;
else if (bump === 'patch') newVersion = `${major}.${minor}.${patch + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) newVersion = bump;
else {
  console.error('Usage: pnpm release patch|minor|major|<version>');
  console.error(`Current version: ${pkg.version}`);
  process.exit(1);
}

const tag = `v${newVersion}`;
const tag2 = `@app-${newVersion}`;

pkg.version = newVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const run = (args) => {
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(['add', 'package.json']);
run(['commit', '-m', `chore: release nivaro@${newVersion}`]);
run(['tag', tag]);

// Rebuild the changelog AFTER tagging, so this release is in it, then amend it
// onto the release commit and move the tags to match. Generating it before the
// tag would always leave the newest version missing from its own notes.
const gen = spawnSync('node', ['scripts/build-changelog.mjs'], { stdio: 'inherit' });
if (gen.status === 0) {
  run(['add', 'changelog.json']);
  run(['commit', '--amend', '--no-edit']);
  run(['tag', '-f', tag]);
}
run(['tag', '-f', tag2]);
run(['push', 'origin', 'HEAD']);
run(['push', 'origin', tag]);
run(['push', 'origin', tag2]);

console.log(`\n✓ nivaro@${newVersion} tagged as ${tag} and ${tag2} and pushed`);
