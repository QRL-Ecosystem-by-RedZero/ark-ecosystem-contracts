/**
 * Prints ArkTimelock's compiled delay table: every parameter key (name, keccak,
 * delay, step limit) and every selector (signature, 4-byte id, delay). The
 * `K_` keys are ArkStakeParams fields, the `O_` keys the valuation oracle's; a
 * relative step (`RELATIVE`, arkReferencePrice) prints as bps of the value in
 * force.
 *
 * The names and signatures are read from contracts/utils/ArkGovTables.hyp and
 * every delay is asked of the BUILT timelock on the local harness, so the table
 * printed is the table deployed, not a transcription of it. `T_` keys are the
 * treasury router's (and the timelock's own spend cap); the per-phase families
 * the table computes rather than lists (the emission vault's channel cells,
 * Qurrl's minter keys) are generated here from the same field names. The staking
 * repository mirrors the key names from this output (CLAUDE.md §4.6).
 *
 *   node scripts/governance-keys.js            # markdown
 *   node scripts/governance-keys.js --json
 */
const fs = require('fs');
const path = require('path');
const { keccak256, toUtf8Bytes, Interface } = require('ethers');
const { Chain, ACCOUNTS, artifact } = require('../test/harness');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'utils', 'ArkGovTables.hyp'), 'utf8');
const DAY = 86400;
const RELATIVE = 1n << 255n;
const fmt = (s) => (s % DAY === 0 && s >= 3 * DAY ? `${s / DAY} days` : `${s / 3600} hours`);

async function main() {
  const chain = await Chain.create();
  const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [ACCOUNTS.admin, ACCOUNTS.guardian]);

  const keys = [];
  const TARGET = { K: 'ArkStakeParams', O: 'ArkReferenceOracle', T: 'ArkTreasuryRouter' };
  const named = [...SRC.matchAll(/bytes32 internal constant ([KOT]_\w+) = keccak256\("([^"]+)"\);/g)].map((m) => ({
    name: m[2],
    target: m[2] === 'arkSpendCapBps' ? 'ArkTimelock' : TARGET[m[1][0]],
  }));
  // The per-phase families the table computes rather than lists.
  const perPhase = (fields, target) => fields.flatMap((f) => [0, 1, 2, 3, 4].map((p) => ({ name: `${f}@${p}`, target })));
  const generated = [
    ...perPhase(['emissionStaking', 'emissionAcorn', 'emissionGovernance', 'emissionLiquidity'], 'ArkEmissionVault'),
    ...perPhase(['acornCap', 'qrlCap', 'fusionCap', 'reqPts', 'reqPtsMin', 'reqPtsMax', 'mintFee', 'mintFeeMin',
      'mintFeeMax', 'fusionFee', 'walletLimit', 'mintDuration', 'fusionDuration', 'lockBaseFee'], 'QurrlPhaseMinter'),
  ];
  for (const m of [...named, ...generated]) {
    const [delay, step] = await tl.call('keyRule', [keccak256(toUtf8Bytes(m.name))]);
    if (delay === 0n) throw new Error(`the built timelock does not know ${m.name}`);
    const relative = (step & RELATIVE) !== 0n;
    keys.push({
      name: m.name,
      target: m.target,
      key: keccak256(toUtf8Bytes(m.name)),
      delay: Number(delay),
      step: Number(relative ? step ^ RELATIVE : step),
      relative,
    });
  }

  const selectors = [];
  for (const m of SRC.matchAll(/bytes4 internal constant (\w+) =\s*bytes4\(keccak256\("([^"]+)"\)\);/g)) {
    const id = keccak256(toUtf8Bytes(m[2])).slice(0, 10);
    let delay;
    try {
      // The selector plus enough zero words to decode any static argument list.
      delay = Number(await tl.call('delayFor', [id + '00'.repeat(64 * 4)]));
    } catch (e) {
      delay = m[2].startsWith('setParamsDiff') ? 'max over keys' : `refused (${e.message})`;
    }
    if (m[2].startsWith('setThreatStage')) {
      delay = Number(await tl.call('delayFor', [new Interface(artifact('ParamsDouble').abi).encodeFunctionData('setThreatStage', [1, 2])]));
    }
    // A zero step is refused; ArkPhase's setPhase is asked for 0 -> 1.
    if (m[2].startsWith('setPhase')) {
      delay = Number(await tl.call('delayFor', [new Interface(artifact('ArkPhase').abi).encodeFunctionData('setPhase', [0, 1])]));
    }
    selectors.push({ signature: m[2], selector: id, delay });
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ keys, selectors }, null, 2));
    return;
  }
  console.log('| Key (field) | Target | keccak256 | Delay | Step limit |\n| --- | --- | --- | --- | ---: |');
  for (const k of keys.sort((a, b) => a.delay - b.delay || a.name.localeCompare(b.name))) {
    const step = k.relative ? `${k.step} bps of the value in force` : k.step || '—';
    console.log(`| \`${k.name}\` | ${k.target} | \`${k.key}\` | ${fmt(k.delay)} | ${step} |`);
  }
  console.log('\n| Selector | Id | Delay |\n| --- | --- | --- |');
  for (const s of selectors) console.log(`| \`${s.signature}\` | \`${s.selector}\` | ${typeof s.delay === 'number' ? fmt(s.delay) : s.delay} |`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
