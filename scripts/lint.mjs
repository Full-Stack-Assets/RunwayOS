import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targets = ['README.md', 'docs'];
const failures = [];

function walk(currentPath) {
  const stat = fs.statSync(currentPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(currentPath)) {
      walk(path.join(currentPath, entry));
    }
    return;
  }

  if (!/\.(md|ya?ml)$/i.test(currentPath) && path.basename(currentPath) !== 'README.md') {
    return;
  }

  const content = fs.readFileSync(currentPath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    if (/\t+$/.test(line) || / {3,}$/.test(line)) {
      failures.push(`${path.relative(root, currentPath)}:${index + 1} has trailing whitespace`);
    }
  });

  if (!content.endsWith('\n')) {
    failures.push(`${path.relative(root, currentPath)} is missing a trailing newline`);
  }
}

for (const target of targets) {
  walk(path.join(root, target));
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
