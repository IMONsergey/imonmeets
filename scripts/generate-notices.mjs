import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const rows = [];
const sections = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.includes('node_modules/') || entry.dev || entry.link || !existsSync(join(path, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license || 'See package');
  rows.push(`| ${pkg.name} | ${pkg.version} | ${license} |`);
  for (const name of readdirSync(path).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name))) {
    try {
      const text = readFileSync(join(path, name), 'utf8');
      sections.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version} - ${name}\n${'='.repeat(72)}\n${text}\n`);
    } catch { /* A package may use a directory for supplementary licensing. */ }
  }
}
writeFileSync('THIRD_PARTY_NOTICES.md', `# Third-party components\n\nGenerated from the locked installed production dependencies. The application license does not replace these licenses. Full packaged license/notice texts are preserved in [third-party-licenses.txt](apps/web/public/third-party-licenses.txt) and are distributed with the client at /third-party-licenses.txt. Runtime node_modules also retain original license files. Review additional service images and optional model/media assets separately.\n\nLiveKit server and optional Egress are Apache-2.0. Valkey uses BSD-3-Clause and provides the Redis-compatible coordination service. PostgreSQL and Mailpit retain their respective service licenses. Service-image dependencies must also retain their notices when distributed.\n\n| Package | Version | Declared license |\n| --- | --- | --- |\n${rows.sort().join('\n')}\n`);
mkdirSync('apps/web/public', { recursive: true });
writeFileSync('apps/web/public/third-party-licenses.txt', 'Third-party software license texts distributed with IMON Meets.\n' + sections.join('\n'));
console.log(`Recorded ${rows.length} installed production package notices.`);
