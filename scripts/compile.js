/**
 * Compiles contracts/**\/*.hyp with the Hyperion compiler (@theqrl/hypc) and
 * writes artifacts (abi + bytecode) to build/, ABIs to abi/.
 *
 * Differences from a Solidity/solc setup worth knowing:
 *  - `language` must be "Hyperion"; hypc rejects "Solidity" outright.
 *  - Output lives under `zvm` (Zond Virtual Machine), not `evm`; the QIP-55
 *    compiler line renamed it `qrvm`.
 *  - The version pragma is `pragma hyperion >=0.0.1;`.
 *
 * TWO COMPILER LINES
 * -----------------------------------------------------------------
 * The npm module is hypc 0.0.2, the v2 line, and is what the local test harness
 * runs. The QRL testnet v3 chain (QIP-55: 64-byte addresses, 512-bit QRVM) needs
 * the hyperion main compiler: set HYPC_BIN (a native binary) or
 * HYPC_DOCKER_IMAGE (e.g. hypc:local) AND ARK_QRVM=1 (or --qrvm). The v3 build
 * then lands in build-qrvm/ and abi-qrvm/, never over build/. It compiles only
 * the governance stack and what it imports (QRVM_ROOTS): the rest of this tree
 * still spells denominations `ether`, which the v3 compiler rejects, and is not
 * deployed to v3 from here.
 *
 * BUILD PROFILES (scripts/lib/profile.js)
 * ---------------------------------------
 * `--profile testnet` (or `rapid`) compiles the governance stack alone, on
 * either line, with every `N days` / `N hours` scaled by the profile's one
 * factor — the clock Ark Staking's testnet deployment runs on — into
 * `build<-qrvm>-testnet/`, never over a spec build. No ABI is written: a
 * profile changes durations, never an interface. Each artifact records the
 * profile it was built at (`profile: { name, day }`), which is what
 * contracts/staking's `vendor-governance.js` checks before it vendors it.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Runs --standard-json through whichever compiler the environment names. */
function makeCompiler() {
  const bin = process.env.HYPC_BIN;
  const image = process.env.HYPC_DOCKER_IMAGE;
  const cli = (cmd, args, label) => ({
    label,
    compile(input) {
      const run = spawnSync(cmd, [...args, '--standard-json'], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (run.error) throw run.error;
      if (run.status !== 0) throw new Error(`${label} exited ${run.status}: ${run.stderr}`);
      return run.stdout;
    },
    version() {
      const run = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8' });
      const m = (run.stdout || '').match(/Version:\s*(\S+)/);
      return m ? m[1] : (run.stdout || '').trim().split('\n').pop();
    },
  });
  if (bin) return cli(bin, [], `hypc (${bin})`);
  if (image) return cli('docker', ['run', '--rm', '-i', image], `hypc (docker ${image})`);
  const npm = require('@theqrl/hypc');
  return { label: 'hypc (npm)', compile: (input) => npm.compile(input), version: () => npm.version() };
}

// Asked for, never inferred; refused without an override compiler, because npm
// hypc 0.0.2 predates QRVM 512-bit codegen and mislabelling its output would be
// worse than stopping.
const QRVM = process.env.ARK_QRVM === '1' || process.argv.includes('--qrvm');
if (QRVM && !process.env.HYPC_BIN && !process.env.HYPC_DOCKER_IMAGE) {
  console.error('ARK_QRVM=1 needs HYPC_BIN or HYPC_DOCKER_IMAGE: npm @theqrl/hypc 0.0.2 predates QRVM 512-bit codegen');
  process.exit(1);
}
const hypc = makeCompiler();
const { fromArgv, rewriteSources } = require('./lib/profile');

let PROFILE;
try {
  PROFILE = fromArgv();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const PROFILED = PROFILE.name !== 'spec';

const ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(ROOT, 'contracts');
const OUT = path.join(ROOT, `${QRVM ? 'build-qrvm' : 'build'}${PROFILE.suffix}`);
const ABI_DIR = PROFILED ? null : path.join(ROOT, QRVM ? 'abi-qrvm' : 'abi');

/** What the v3 build compiles: the governance stack, the token it locks, and their imports. */
const QRVM_ROOTS = [
  'ArkToken.hyp', 'VeArk.hyp', 'ArkTimelock.hyp', 'ArkMultisig.hyp', 'ArkGovernorRules.hyp',
  'ArkGovernor.hyp', 'ArkQDayOracle.hyp', 'ArkPhase.hyp', 'ChunkedDeployer.hyp', 'ArkEmissionVault.hyp', 'ArkTreasuryRouter.hyp',
];
const QRVM_OWN = QRVM_ROOTS.map((f) => f.replace(/\.hyp$/, ''));

/** Our own contracts, as opposed to vendored OpenZeppelin. */
const OWN = [
  'ArkToken', 'VeArk', 'ArkTimelock', 'ArkMultisig', 'ArkGovernorRules', 'ArkGovernor', 'ArkQDayOracle', 'ArkPhase', 'ChunkedDeployer', 'ArkEmissionVault', 'ArkTreasuryRouter',
];

const EIP170_LIMIT = 24576;

/**
 * Largest creation payload the QRL RPC proxy accepts in one request: the body
 * cap is 50KB and an ML-DSA-87 signature plus public key adds ~7.2KB to every
 * transaction, on top of hex encoding. Anything larger needs a ChunkedDeployer.
 */
const DIRECT_DEPLOY_LIMIT = 18000;

function collectSources(dir, base = '') {
  const sources = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(sources, collectSources(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.hyp')) {
      sources[rel] = { content: fs.readFileSync(path.join(dir, entry.name), 'utf8') };
    }
  }
  return sources;
}

/** The import closure of `roots` within `all`, keyed like `all`. */
function closure(all, roots) {
  const out = {};
  const visit = (rel) => {
    if (out[rel] || !all[rel]) return;
    out[rel] = all[rel];
    for (const m of all[rel].content.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
  };
  roots.forEach(visit);
  return out;
}

function main() {
  const all = collectSources(CONTRACTS);
  // A profiled build is the governance stack alone on both lines: the
  // insurance contracts are not deployed at a compressed clock from here.
  const selected = QRVM || PROFILED ? closure(all, QRVM_ROOTS) : all;
  let sources = selected;
  if (PROFILED) {
    const r = rewriteSources(selected, PROFILE, (file) => file.startsWith('lib/'));
    sources = r.sources;
    console.log(`profile ${PROFILE.name}: one day is ${PROFILE.day} s, ${r.rewrites.length} durations rewritten`);
  }
  console.log(`hypc ${hypc.version()}`);
  console.log(`compiling ${Object.keys(sources).length} Hyperion sources...\n`);

  const input = {
    language: 'Hyperion',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        // Each compiler line ignores the selection key it does not know.
        '*': {
          '*': [
            'abi',
            'zvm.bytecode.object',
            'zvm.deployedBytecode.object',
            'qrvm.bytecode.object',
            'qrvm.deployedBytecode.object',
          ],
        },
      },
    },
  };

  const output = JSON.parse(hypc.compile(JSON.stringify(input)));

  let fatal = false;
  let warnings = 0;
  for (const err of output.errors || []) {
    if (err.severity === 'error') {
      fatal = true;
      console.error(err.formattedMessage);
    } else if (!/SPDX/.test(err.formattedMessage)) {
      warnings++;
      console.warn('warn:', err.formattedMessage.split('\n')[0]);
    }
  }
  if (fatal) process.exit(1);

  fs.mkdirSync(OUT, { recursive: true });
  if (ABI_DIR) fs.mkdirSync(ABI_DIR, { recursive: true });

  const sizes = {};
  for (const [file, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, c] of Object.entries(contracts)) {
      const vm = c.qrvm || c.zvm;
      const bytecode = vm && vm.bytecode && vm.bytecode.object;
      if (!bytecode) continue; // interface or abstract contract
      fs.writeFileSync(
        path.join(OUT, `${name}.json`),
        JSON.stringify(
          {
            contractName: name,
            sourceName: file,
            compiler: { name: 'hypc', version: hypc.version() },
            profile: { name: PROFILE.name, day: PROFILE.day },
            abi: c.abi,
            bytecode: '0x' + bytecode,
            deployedBytecode: '0x' + vm.deployedBytecode.object,
          },
          null,
          2,
        ),
      );
      if (ABI_DIR) fs.writeFileSync(path.join(ABI_DIR, `${name}.json`), JSON.stringify(c.abi, null, 2));
      sizes[name] = {
        init: bytecode.length / 2,
        runtime: vm.deployedBytecode.object.length / 2,
      };
    }
  }

  console.log('\n%s %s %s', 'contract'.padEnd(20), 'init'.padStart(8), 'runtime'.padStart(8));
  let over = false;
  for (const n of QRVM || PROFILED ? QRVM_OWN : OWN) {
    if (!sizes[n]) {
      console.log('%s %s', n.padEnd(20), '   MISSING');
      over = true;
      continue;
    }
    const flags = [];
    if (sizes[n].runtime > EIP170_LIMIT) flags.push(`EXCEEDS EIP-170 ${EIP170_LIMIT}`);
    if (sizes[n].init > DIRECT_DEPLOY_LIMIT) flags.push('needs chunked deploy');
    if (sizes[n].runtime > EIP170_LIMIT) over = true;
    console.log(
      '%s %s %s%s',
      n.padEnd(20),
      String(sizes[n].init).padStart(8),
      String(sizes[n].runtime).padStart(8),
      flags.length ? '  << ' + flags.join(', ') : '',
    );
  }
  if (over) process.exit(1);

  console.log(`\n${warnings} warning(s). artifacts -> ${path.basename(OUT)}/${ABI_DIR ? `, ABIs -> ${path.basename(ABI_DIR)}/` : ''}`);
}

main();
