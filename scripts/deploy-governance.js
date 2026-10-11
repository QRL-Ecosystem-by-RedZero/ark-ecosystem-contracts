/**
 * Deploys the ARK governance stack (ArkGovernance-Design.md §11) at stage S1:
 *
 *   ChunkedDeployer (this run's own: only its creator can use it, staking audit D19)
 *   ArkMultisig (proposer) + ArkMultisig (guardian)
 *   ArkTimelock(proposer multisig, guardian multisig)
 *   ArkToken (unless ARK_TOKEN names an existing one)
 *   VeArk(ark, protocol-owned incl. the timelock)                  G11
 *   ArkGovernorRules, ArkQDayOracle, ArkGovernor (chunked when large)
 *   VeArk.setGovernor, ArkQDayOracle.setGovernor                    one-shot
 *
 * and writes deployments/governance-<network>.json. It does NOT hand the
 * timelock to the governor (that is the S1 -> S2 step, `handOver`, a 30-day self-operation since 2026-09-30, taken by the
 * proposer multisig once the S1 exit conditions hold) and does NOT touch Ark
 * Staking: each staking contract's current governance must
 * `proposeGovernance(<timelock>)`, and the proposer multisig then schedules
 * `acceptGovernance()` on it through the timelock (48 h).
 *
 * Usage
 *   node scripts/deploy-governance.js --plan    # validate env + artifacts, no network
 *   node scripts/deploy-governance.js           # deploy (private networks only)
 *   node scripts/deploy-governance.js --profile testnet [--plan]
 *                                               # the time-compressed build (below)
 *
 * Build first: v3 chain  HYPC_DOCKER_IMAGE=hypc:local ARK_QRVM=1 npm run compile
 *              (build-qrvm/, used by default; GOV_BUILD_DIR overrides)
 *              testnet    HYPC_DOCKER_IMAGE=hypc:local ARK_QRVM=1 npm run compile -- --profile testnet
 *              (build-qrvm-testnet/, the default under --profile testnet)
 *
 * The record names the chain's genesis hash (`genesisHash`) and the profile the
 * artifacts were built at: a devnet rebuilt from genesis no longer holds this
 * stack, and a reader that finds a different genesis must treat the record as
 * stale (contracts/staking `scripts/lib/governance.js` does, and redeploys the
 * stack itself from the artifacts it vendors from here — see CLAUDE.md §2).
 *
 * Environment (.env or shell; shell wins)
 *   DEPLOYER_MNEMONIC              34-word ML-DSA-87 mnemonic of the deployer
 *   QRL_RPC_URL                    private RPC; ALLOW_PUBLIC_RPC=1 to override the guard
 *   GOV_PROPOSER_OWNERS            comma-separated Q addresses, S1 proposer multisig
 *   GOV_PROPOSER_THRESHOLD         k of the proposer multisig
 *   GOV_GUARDIAN_OWNERS            comma-separated Q addresses, guardian multisig
 *   GOV_GUARDIAN_THRESHOLD         k of the guardian multisig
 *   SEALER_ADDRESS, RELAYER_ADDRESS  refused as multisig owners (design §6.1);
 *                                  the deployer is refused too. ALLOW_SHARED_KEYS=1 overrides.
 *   ARK_TOKEN                      existing ArkToken; else one is deployed with
 *   ARK_INCENTIVES, ARK_TREASURY, ARK_CONTRIBUTORS, ARK_BACKSTOP,
 *   ARK_LIQUIDITY                  bucket holders (default: the deployer; the
 *                                  token refuses two buckets on one address, so
 *                                  a real deploy sets all five)
 *   VEARK_PROTOCOL_OWNED           extra protocol-owned addresses (treasury,
 *                                  backstop, incentives are added when set above)
 *   QDAY_ATTESTERS                 comma-separated, at most 9
 *   QDAY_ATTESTER_BOND             wei per attester, default 10000 * 10**18 (uncalibrated)
 *   QDAY_ADVISORY_COOLDOWN         seconds, default seven days of the profile (604800 spec,
 *                                  4200 testnet; uncalibrated)
 *   QDAY_COURT                     court allowed to slash bonds, default zero
 *   GOV_PROPOSAL_THRESHOLD_BPS     default 10   (0.1% of W, uncalibrated)
 *   GOV_QDAY_QUORUM_BPS            default 500  (Q_min 5% of W voting for, 100..5000; uncalibrated)
 *   GOV_OBJECTION_THRESHOLD_BPS    default 2000 (20% of principal, uncalibrated)
 *   GOV_ADMISSION_DEPOSIT          wei of ARK, default 5000 * 10**18
 *   GOV_BUILD_DIR                  artifact directory, default build-qrvm (build-qrvm-testnet under --profile testnet)
 *   GOV_NETWORK                    record name suffix, default the chain id
 */
const fs = require('fs');
const path = require('path');
const qrl = require('./qrl-v3');

const DIRECT_DEPLOY_LIMIT = 18000;
const ZERO = 'Q' + '0'.repeat(128);
const PLAN = process.argv.includes('--plan');
const { fromArgv } = require('./lib/profile');
const PROFILE = fromArgv();

const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const big = (v, d) => (v === undefined || v === '' ? d : BigInt(v));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Fills the buckets the environment leaves unset, each on its own address
 * (ArkToken reverts `DuplicateBucket`): incentives stay with the deployer, the
 * treasury goes to the timelock (its holder by design), and contributors,
 * backstop and liquidity go to inert placeholder addresses nobody signs from.
 * A mainnet deploy sets all five (ArkAllocation-Design.md §4).
 */
function defaultBuckets(buckets, deployer, timelock) {
  const placeholder = (k) => 'Q' + '0'.repeat(127) + String(k);
  const fallback = [deployer, timelock, placeholder(1), placeholder(2), placeholder(3)];
  return buckets.map((b, i) => b || fallback[i]);
}

function config(env, deployer) {
  const c = {
    buildDir: path.resolve(qrl.ROOT, env.GOV_BUILD_DIR || `build-qrvm${PROFILE.suffix}`),
    proposerOwners: list(env.GOV_PROPOSER_OWNERS),
    proposerThreshold: num(env.GOV_PROPOSER_THRESHOLD, 0),
    guardianOwners: list(env.GOV_GUARDIAN_OWNERS),
    guardianThreshold: num(env.GOV_GUARDIAN_THRESHOLD, 0),
    ark: env.ARK_TOKEN || '',
    // Unset buckets are filled at deploy time (`defaultBuckets`): the token
    // refuses two buckets on one address, so "the deployer" cannot be the
    // default for all five.
    buckets: ['ARK_INCENTIVES', 'ARK_TREASURY', 'ARK_CONTRIBUTORS', 'ARK_BACKSTOP', 'ARK_LIQUIDITY'].map((k) => env[k] || null),
    protocolOwned: list(env.VEARK_PROTOCOL_OWNED),
    attesters: list(env.QDAY_ATTESTERS),
    attesterBond: big(env.QDAY_ATTESTER_BOND, 10000n * 10n ** 18n),
    // Seconds, a constructor argument: the profile's rewrite cannot reach it, so
    // its default is scaled here (seven of the profile's days).
    advisoryCooldown: num(env.QDAY_ADVISORY_COOLDOWN, 7 * PROFILE.day),
    court: env.QDAY_COURT || ZERO,
    proposalThresholdBps: num(env.GOV_PROPOSAL_THRESHOLD_BPS, 10),
    qdayQuorumBps: num(env.GOV_QDAY_QUORUM_BPS, 500),
    objectionThresholdBps: num(env.GOV_OBJECTION_THRESHOLD_BPS, 2000),
    admissionDeposit: big(env.GOV_ADMISSION_DEPOSIT, 5000n * 10n ** 18n),
  };
  for (const k of ['ARK_TREASURY', 'ARK_BACKSTOP', 'ARK_INCENTIVES']) {
    if (env[k] && !c.protocolOwned.some((a) => same(a, env[k]))) c.protocolOwned.push(env[k]);
  }

  const errors = [];
  if (!c.proposerOwners.length || c.proposerThreshold < 1 || c.proposerThreshold > c.proposerOwners.length) {
    errors.push('GOV_PROPOSER_OWNERS / GOV_PROPOSER_THRESHOLD: need k-of-n with 1 <= k <= n');
  }
  if (!c.guardianOwners.length || c.guardianThreshold < 1 || c.guardianThreshold > c.guardianOwners.length) {
    errors.push('GOV_GUARDIAN_OWNERS / GOV_GUARDIAN_THRESHOLD: need k-of-n with 1 <= k <= n');
  }
  if (c.attesters.length > 9) errors.push('QDAY_ATTESTERS: at most 9');
  if (!(c.qdayQuorumBps >= 100 && c.qdayQuorumBps <= 5000)) errors.push('GOV_QDAY_QUORUM_BPS: 100..5000 (ArkGovernor refuses others)');
  if (env.ALLOW_SHARED_KEYS !== '1') {
    const operational = [deployer, env.SEALER_ADDRESS, env.RELAYER_ADDRESS].filter(Boolean);
    for (const o of [...c.proposerOwners, ...c.guardianOwners]) {
      if (operational.some((x) => same(x, o))) {
        errors.push(`${o} is the deployer, sealer or relayer; governance keys must be separate (design §6.1)`);
      }
    }
  }
  return { c, errors };
}

function describeArtifacts(buildDir) {
  const names = ['ChunkedDeployer', 'ArkMultisig', 'ArkTimelock', 'ArkToken', 'VeArk', 'ArkGovernorRules', 'ArkQDayOracle', 'ArkGovernor'];
  const out = {};
  for (const n of names) {
    const art = qrl.artifact(n, buildDir);
    out[n] = {
      init: qrl.sizeOf(art.bytecode),
      runtime: qrl.sizeOf(art.deployedBytecode),
      route: qrl.sizeOf(art.bytecode) > DIRECT_DEPLOY_LIMIT ? 'chunked' : 'direct',
      compiler: art.compiler && art.compiler.version,
      profile: art.profile ? art.profile.name : 'spec',
    };
    if (out[n].profile !== PROFILE.name) {
      throw new Error(`${n} in ${path.relative(qrl.ROOT, buildDir)} was built at profile ${out[n].profile}, not ${PROFILE.name}`);
    }
  }
  return out;
}

async function main() {
  const env = qrl.loadEnv();

  if (PLAN) {
    const { c, errors } = config(env, env.DEPLOYER_ADDRESS || '<deployer>');
    const arts = describeArtifacts(c.buildDir);
    console.log(`build dir ${path.relative(qrl.ROOT, c.buildDir)}`);
    console.table(arts);
    console.log(JSON.stringify({ ...c, attesterBond: String(c.attesterBond), admissionDeposit: String(c.admissionDeposit) }, null, 2));
    if (errors.length) {
      console.error('\nconfiguration errors:\n  ' + errors.join('\n  '));
      process.exit(1);
    }
    console.log('\nplan ok; nothing was sent');
    return;
  }

  const { web3, account } = qrl.connect(env);
  const me = account.address;
  const { c, errors } = config(env, me);
  if (errors.length) throw new Error('configuration errors:\n  ' + errors.join('\n  '));
  const art = (n) => qrl.artifact(n, c.buildDir);
  const chainId = String(await web3.qrl.getChainId());
  const genesis = await web3.qrl.getBlock(0);
  const log = (s) => console.log(s);
  log(`deployer ${me}\nchain ${chainId}\nbuild ${path.relative(qrl.ROOT, c.buildDir)}`);

  const send = (to, abi, method, args) => qrl.sendRaw(web3, account, { to, data: qrl.encodeCall(web3, abi, method, args) });
  const put = async (name, args, chunked) => {
    const a = art(name);
    const addr =
      qrl.sizeOf(a.bytecode) > DIRECT_DEPLOY_LIMIT
        ? await qrl.deployChunked(web3, account, chunked, art('ChunkedDeployer'), a, args, { log })
        : await qrl.deploy(web3, account, a, args);
    log(`   ${name.padEnd(18)} ${addr}`);
    return addr;
  };

  const d = {};
  d.ChunkedDeployer = await put('ChunkedDeployer', []);
  d.ProposerMultisig = await put('ArkMultisig', [c.proposerOwners, c.proposerThreshold]);
  d.GuardianMultisig = await put('ArkMultisig', [c.guardianOwners, c.guardianThreshold]);
  d.ArkTimelock = await put('ArkTimelock', [d.ProposerMultisig, d.GuardianMultisig]);
  const buckets = defaultBuckets(c.buckets, me, d.ArkTimelock);
  d.ArkToken = c.ark || (await put('ArkToken', [...buckets, Math.floor(Date.now() / 1000)]));
  const protocolOwned = [...c.protocolOwned, d.ArkTimelock];
  d.VeArk = await put('VeArk', [d.ArkToken, protocolOwned]);
  d.ArkGovernorRules = await put('ArkGovernorRules', []);
  d.ArkQDayOracle = await put('ArkQDayOracle', [d.ArkTimelock, c.court, c.attesterBond, c.advisoryCooldown, c.attesters]);
  d.ArkGovernor = await put(
    'ArkGovernor',
    [
      d.VeArk,
      d.ArkTimelock,
      d.ArkGovernorRules,
      d.ArkToken,
      d.ArkQDayOracle,
      c.proposalThresholdBps,
      c.qdayQuorumBps,
      c.objectionThresholdBps,
      c.admissionDeposit,
    ],
    d.ChunkedDeployer,
  );

  await send(d.VeArk, art('VeArk').abi, 'setGovernor', [d.ArkGovernor]);
  await send(d.ArkQDayOracle, art('ArkQDayOracle').abi, 'setGovernor', [d.ArkGovernor]);

  // Read back what the stage rests on, rather than trusting the sends.
  const view = (addr, name, method, args = []) => new web3.qrl.Contract(art(name).abi, addr).methods[method](...args).call();
  const proposer = await view(d.ArkTimelock, 'ArkTimelock', 'proposer');
  const guardian = await view(d.ArkTimelock, 'ArkTimelock', 'guardian');
  const veGov = await view(d.VeArk, 'VeArk', 'governor');
  if (!same(proposer, d.ProposerMultisig) || !same(guardian, d.GuardianMultisig) || !same(veGov, d.ArkGovernor)) {
    throw new Error('post-deploy wiring does not match: refusing to write the record');
  }

  const record = {
    network: env.GOV_NETWORK || chainId,
    chainId,
    genesisHash: String(genesis.hash).toLowerCase(),
    profile: PROFILE.name,
    stage: 'S1',
    deployedAt: new Date().toISOString(),
    deployer: me,
    buildDir: path.relative(qrl.ROOT, c.buildDir),
    artifacts: describeArtifacts(c.buildDir),
    addresses: d,
    parameters: {
      buckets: c.ark ? null : Object.fromEntries(['incentives', 'treasury', 'contributors', 'backstop', 'liquidity'].map((n, i) => [n, buckets[i]])),
      proposerOwners: c.proposerOwners,
      proposerThreshold: c.proposerThreshold,
      guardianOwners: c.guardianOwners,
      guardianThreshold: c.guardianThreshold,
      protocolOwned,
      attesters: c.attesters,
      attesterBond: String(c.attesterBond),
      advisoryCooldown: c.advisoryCooldown,
      court: c.court,
      proposalThresholdBps: c.proposalThresholdBps,
      qdayQuorumBps: c.qdayQuorumBps,
      objectionThresholdBps: c.objectionThresholdBps,
      admissionDeposit: String(c.admissionDeposit),
      uncalibrated: ['proposalThresholdBps', 'qdayQuorumBps', 'objectionThresholdBps', 'attesterBond', 'advisoryCooldown'],
    },
    next: [
      'each Ark Staking contract: governance.proposeGovernance(ArkTimelock)',
      'proposer multisig: timelock.schedule(<staking contract>, acceptGovernance()) then execute after 48 h',
      'attesters: ArkQDayOracle.postBond() with at least attesterBond',
      'S1 -> S2 (design §7): proposer multisig calls ArkTimelock.setGovernor(ArkGovernor), then schedules the self-operation ArkTimelock.handOver(ArkGovernor) (30 days, objectable at S1; re-audit 2026-09-30, SWAPGOV-03)',
    ],
  };
  const dir = path.join(qrl.ROOT, 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `governance-${record.network}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  log(`\nrecord -> ${path.relative(qrl.ROOT, file)}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
