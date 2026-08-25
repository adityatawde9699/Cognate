import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = 'dist';
const forbiddenNames = /(^|\/)(\.env(?!\.example$)(?:\..*)?|relay-data\.json(?:\.tmp)?|.*\.(?:db|sqlite|sqlite3|tsbuildinfo))$/i;
const violations = [];

function trackedRuntimeData() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .filter((path) => existsSync(path))
      .filter((path) => forbiddenNames.test(path));
  } catch {
    return [];
  }
}

function visit(path) {
  const relative = path.replaceAll('\\', '/');
  if (forbiddenNames.test(relative)) {
    violations.push(relative);
    return;
  }

  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) visit(join(path, name));
    return;
  }
}

if (!existsSync(root)) {
  console.error('Build verification failed: dist/ does not exist.');
  process.exit(1);
}

violations.push(...trackedRuntimeData());
visit(root);

if (violations.length) {
  console.error('Build verification failed; local data markers were found in the frontend artifact:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log('Build verification passed: no local data files or storage markers found in dist/.');