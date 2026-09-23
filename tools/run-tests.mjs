// Runs every tests/*.test.mjs file with node and reports pass/fail.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filter = process.argv[2] || '';
const files = fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.test.mjs') && f.includes(filter)).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join('tests', f)], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}`);
  if (!ok) console.log((r.stdout || '') + (r.stderr || ''));
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
