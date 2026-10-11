/**
 * Exports every Hyperion source under contracts/ as a plain .txt file in txt/.
 *
 * The point is portability: .hyp opens nowhere, so review tools, mail clients
 * and auditors get the same bytes under an extension everything will display.
 * Nothing is compiled here and no import is resolved -- each source is copied
 * verbatim, with a header naming the path it came from so the tree can be
 * reconstructed from the text alone.
 *
 * Options:
 *   --flat     one directory level, path separators folded into the file name
 *   --own      skip vendored OpenZeppelin (lib/) and test-only mocks/
 *   --bundle   also write txt/_bundle.txt, every source concatenated in order
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(ROOT, 'contracts');
const OUT = path.join(ROOT, 'txt');

const args = new Set(process.argv.slice(2));
const FLAT = args.has('--flat');
const OWN_ONLY = args.has('--own');
const BUNDLE = args.has('--bundle');

/** Vendored or test-only trees, excluded by --own. */
const EXCLUDED = ['lib/', 'mocks/'];

function collect(dir, base = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...collect(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.hyp')) found.push(rel);
  }
  return found;
}

/** Removes previously generated .txt files, then prunes the empty directories. */
function clean(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clean(p);
      if (fs.readdirSync(p).length === 0) fs.rmdirSync(p);
    } else if (entry.name.endsWith('.txt')) {
      fs.unlinkSync(p);
    }
  }
}

function main() {
  if (!fs.existsSync(CONTRACTS)) {
    console.error('no contracts/ directory found');
    process.exit(1);
  }

  let sources = collect(CONTRACTS);
  if (OWN_ONLY) sources = sources.filter((rel) => !EXCLUDED.some((skip) => rel.startsWith(skip)));
  if (sources.length === 0) {
    console.error('no .hyp sources matched');
    process.exit(1);
  }

  clean(OUT);
  fs.mkdirSync(OUT, { recursive: true });

  const bundle = [];
  let bytes = 0;

  for (const rel of sources) {
    const content = fs.readFileSync(path.join(CONTRACTS, rel), 'utf8');
    const header = `// source: contracts/${rel}\n\n`;
    const target = FLAT
      ? path.join(OUT, rel.replace(/\//g, '__').replace(/\.hyp$/, '.txt'))
      : path.join(OUT, rel.replace(/\.hyp$/, '.txt'));

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, header + content);
    bytes += content.length;

    if (BUNDLE) {
      bundle.push(`${'='.repeat(78)}\n// contracts/${rel}\n${'='.repeat(78)}\n\n${content}`);
    }
    console.log(path.relative(ROOT, target).split(path.sep).join('/'));
  }

  fs.writeFileSync(
    path.join(OUT, 'INDEX.txt'),
    [
      `Quantum Ark - Hyperion sources exported as text`,
      `generated ${new Date().toISOString()}`,
      `${sources.length} file(s), ${bytes} bytes of source`,
      '',
      ...sources.map((rel) => `contracts/${rel}`),
      '',
    ].join('\n'),
  );

  if (BUNDLE) fs.writeFileSync(path.join(OUT, '_bundle.txt'), bundle.join('\n\n'));

  console.log(`\n${sources.length} source(s) -> txt/${BUNDLE ? ' (+ _bundle.txt)' : ''}`);
}

main();
