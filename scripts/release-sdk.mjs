import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const pkgPath = 'packages/sdk/package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const bump = process.argv[2];
let newVersion;

if (bump === 'major') newVersion = `${major + 1}.0.0`;
else if (bump === 'minor') newVersion = `${major}.${minor + 1}.0`;
else if (bump === 'patch') newVersion = `${major}.${minor}.${patch + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(bump)) newVersion = bump;
else {
  console.error('Usage: pnpm sdk:release patch|minor|major|<version>');
  console.error(`Current version: ${pkg.version}`);
  process.exit(1);
}

const tag = `@sdk-${newVersion}`;

pkg.version = newVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const run = (args) => {
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(['add', 'packages/sdk/package.json']);
run(['commit', '-m', `chore: release @nivaro/sdk@${newVersion}`]);
run(['tag', tag]);
run(['push', 'origin', 'HEAD']);
run(['push', 'origin', tag]);

// NOTE: never push to the `public` remote here — the public GitHub repo
// only receives the FILTERED history via scripts/publish-github.sh.

console.log(`\n✓ @nivaro/sdk@${newVersion} tagged as ${tag} and pushed`);
