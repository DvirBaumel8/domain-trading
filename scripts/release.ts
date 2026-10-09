// npm run release -- <X.Y.Z> "<one-line summary>"
// Moves every version spot of a release together, so nothing is edited by hand (Dvir, 9 Oct 2026: fewer manual steps):
//   package.json + package-lock.json, the "**Version X.Y.Z** (<date>)" line of docs/contract/README.md, the "(contract vX.Y.Z)"
//   labels in endpoints/formats/jobs/reports/selection.md, a CHANGELOG heading (stub when missing) and docs/releases/vX.Y.Z.md
//   (stub when missing), then `npm run evidence`. It never commits, pushes, tags or calls production.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const [version, summary] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !summary) {
  console.error('usage: npm run release -- X.Y.Z "one-line summary"');
  process.exit(1);
}

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const write = (p: string, s: string) => writeFileSync(join(ROOT, p), s);
const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' }); // YYYY-MM-DD, IDT
const human = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'short', year: 'numeric' }); // 9 Oct 2026

const pkg = JSON.parse(read('package.json')) as { version: string };
const old = pkg.version;
if (old === version) console.log(`package.json is already ${version}`);
else execSync(`npm version ${version} --no-git-tag-version`, { cwd: ROOT, stdio: 'ignore' });

const readme = 'docs/contract/README.md';
const r = read(readme).replace(/\*\*Version \d+\.\d+\.\d+\*\* \([^)]*\)/, `**Version ${version}** (${human})`);
write(readme, r);

for (const f of ['endpoints', 'formats', 'jobs', 'reports', 'selection']) {
  const p = `docs/contract/${f}.md`;
  write(p, read(p).replace(/\(contract v\d+\.\d+\.\d+\)/g, `(contract v${version})`));
}

const cl = 'docs/contract/CHANGELOG.md';
const changelog = read(cl);
if (!changelog.includes(`## ${version} (`)) {
  const at = changelog.search(/^## \d+\.\d+\.\d+ \(/m);
  const entry = `## ${version} (${day}): ${summary}\nRelease note: \`docs/releases/v${version}.md\`.\n\n`;
  write(cl, at < 0 ? `${changelog}\n${entry}` : changelog.slice(0, at) + entry + changelog.slice(at));
}

const note = `docs/releases/v${version}.md`;
if (!existsSync(join(ROOT, note))) write(note, `# Release v${version} (${human})\n\n**Contract:** ${version}. ${summary}\n\n- **What changed:**\n- **How to test it:**\n`);

execSync('npm run evidence', { cwd: ROOT, stdio: 'inherit' });
console.log(`release ${old} -> ${version}: version spots updated; review the CHANGELOG entry and ${note}, then commit, push and tag v${version}`);
