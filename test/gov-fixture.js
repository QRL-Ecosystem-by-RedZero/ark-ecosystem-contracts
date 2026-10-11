/**
 * Shared helpers for the governance suite: ArkTimelock, ArkMultisig, VeArkV2,
 * ArkGovernor(+Rules) and ArkQDayOracle.
 */
const { Interface, keccak256, toUtf8Bytes } = require('ethers');
const { Chain, ACCOUNTS, artifact } = require('./harness');

const DAY = 86400;
const HOUR = 3600;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;
const MAX_LOCK = 4 * YEAR;
const ONE = 10n ** 18n;

const key = (name) => keccak256(toUtf8Bytes(name));
const sel = (sig) => keccak256(toUtf8Bytes(sig)).slice(0, 10);

const paramsIface = () => new Interface(artifact('ParamsDouble').abi);

/** `setParamsDiff` calldata from [[name, expected, value], ...]. */
function diff(changes) {
  return paramsIface().encodeFunctionData('setParamsDiff', [
    changes.map(([name, expected, value]) => ({ key: key(name), expected, value })),
  ]);
}

function stage(from, to) {
  return paramsIface().encodeFunctionData('setThreatStage', [from, to]);
}

/** Extra deterministic accounts beyond the harness set. */
function addr(n) {
  return '0x' + n.toString(16).padStart(2, '0').repeat(20);
}

/** Moves the chain to `offset` seconds past the next epoch boundary. */
function toNextEpoch(chain, offset = 60) {
  const t = Number(chain.timestamp);
  const next = (Math.floor(t / WEEK) + 1) * WEEK;
  chain.advanceTime(next - t + offset);
}

function epochOf(chain) {
  return BigInt(Math.floor(Number(chain.timestamp) / WEEK));
}

async function deployArkToken(chain) {
  // alice holds the 45% incentives bucket and funds everyone else in the tests.
  return chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'uint64'],
    [ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.attester, ACCOUNTS.guardian, ACCOUNTS.mallory, chain.timestamp],
  );
}

const KIND = {
  AttesterSetChange: 5,
  RenounceAdmin: 7,
  StakingParameter: 8,
  StakingThreatStage: 9,
  StakingAdmission: 10,
  StakingDelisting: 11,
  StakingValidatorBatch: 12,
  StakingQDayRatification: 13,
  StakingCourtEscalation: 14,
  EcosystemPhase: 15,
  EcosystemRestoration: 16,
};
const STATE = {
  None: 0n,
  Pending: 1n,
  Active: 2n,
  Defeated: 3n,
  Succeeded: 4n,
  Queued: 5n,
  Executed: 6n,
  Cancelled: 7n,
  Expired: 8n,
  Contested: 9n,
};
const VOTE = { Against: 0, For: 1, Abstain: 2 };

/** Voters and their locks (4 years): weight ~4x amount. */
const VOTERS = {
  big: addr(0xb1), // 1,000,000 ARK, ~65% of W
  mid: addr(0xb2), // 250,000, ~16%
  small: addr(0xb3), // 100,000, ~6.5%
  tiny: addr(0xb4), // 30,000, ~2%, delegated to mid
  dust: addr(0xb5), // 1 ARK
};
const TREASURY = addr(0xe1);
const ATTESTERS = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => addr(0xc0 + i));
const ATTESTER_BOND = 10n ** 18n;

/**
 * The whole stack at stage S2: ArkTimelock's proposer is ArkGovernor.
 *
 * Before the handover the deployer, as S1 proposer, wires the court and the
 * objection source through 30-day operations, exactly as a multisig would.
 */
async function deployGovernance({ wire = true } = {}) {
  const chain = await Chain.create();
  const ark = await deployArkToken(chain);
  const ve = await chain.deploy('VeArk', ['address', 'address[]'], [ark.address, [TREASURY]]);
  const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [ACCOUNTS.admin, ACCOUNTS.guardian]);
  const rules = await chain.deploy('ArkGovernorRules');
  const qday = await chain.deploy(
    'ArkQDayOracle',
    ['address', 'address', 'uint256', 'uint64', 'address[]'],
    [tl.address, '0x' + '00'.repeat(20), ATTESTER_BOND, 7 * DAY, ATTESTERS],
  );
  const gov = await chain.deploy(
    'ArkGovernor',
    ['address', 'address', 'address', 'address', 'address', 'uint16', 'uint16', 'uint16', 'uint256'],
    [ve.address, tl.address, rules.address, ark.address, qday.address, 10, 500, 2000, 5000n * ONE],
  );
  await ve.send('setGovernor', [gov.address]);
  await qday.send('setGovernor', [gov.address]);

  const params = await chain.deploy('ParamsDouble', ['address'], [tl.address]);
  for (const [name, lo, hi, v] of [
    ['threatStage1Bps', 1850, 4000, 1850],
    ['indemnityBps', 5000, 10000, 10000],
    // An ordinary 14-day key with no step; its outer bound (1 - pmlFloorBps <= 5,000).
    ['maxAssetShareBps', 1, 5000, 250],
    ['releaseBoundBps', 1, 2500, 2500],
  ]) {
    await params.send('defineParam', [key(name), lo, hi, v]);
  }
  const court = await chain.deploy('CourtDouble');
  await court.send('setGovernor', [gov.address]);
  const source = await chain.deploy('ObjectionSourceDouble');

  // The handover is a 30-day self-operation to the governor named once
  // (re-audit 2026-09-30, SWAPGOV-03), queued beside the wiring.
  await tl.send('setGovernor', [gov.address]);
  const opOf = (res) => tl.events(res, 'Scheduled')[0].args.opId;
  const ops = [];
  if (wire) {
    ops.push(opOf(await tl.send('schedule', [gov.address, gov.iface.encodeFunctionData('setCourt', [court.address])])));
    ops.push(opOf(await tl.send('schedule', [gov.address, gov.iface.encodeFunctionData('setObjectionSource', [source.address])])));
  }
  ops.push(opOf(await tl.send('schedule', [tl.address, tl.iface.encodeFunctionData('handOver', [gov.address])])));
  chain.advanceTime(30 * DAY + 1);
  for (const op of ops) await tl.send('execute', [op]);

  for (const [who, amount] of [
    [VOTERS.big, 1_000_000n],
    [VOTERS.mid, 250_000n],
    [VOTERS.small, 100_000n],
    [VOTERS.tiny, 30_000n],
    [VOTERS.dust, 1n],
  ]) {
    await ark.send('transfer', [who, amount * ONE], { from: ACCOUNTS.alice });
    await ark.send('approve', [ve.address, 10n ** 30n], { from: who });
    await ve.send('createLock', [amount * ONE, chain.timestamp + BigInt(MAX_LOCK)], { from: who });
  }
  await ve.send('delegate', [VOTERS.mid], { from: VOTERS.tiny });
  await ark.send('approve', [gov.address, 10n ** 30n], { from: ACCOUNTS.alice });
  for (const a of ATTESTERS) {
    await chain.fund(a);
    await qday.send('postBond', [], { from: a, value: ATTESTER_BOND });
  }
  chain.mine();
  return { chain, ark, ve, tl, rules, qday, gov, params, court, source };
}

/** Proposes and returns the id. */
async function propose(ctx, kind, actions, from = VOTERS.big, uri = 'ipfs://rationale') {
  const res = await ctx.gov.send(
    'propose',
    [kind, actions.map((a) => a[0]), actions.map((a) => a[2] || 0n), actions.map((a) => a[1]), uri],
    { from },
  );
  return ctx.gov.events(res, 'ProposalCreated')[0].args.id;
}

/** Moves into the proposal's round and opens it; votes are possible from the next block. */
async function openRoundFor(ctx, id) {
  const { round } = await ctx.gov.call('proposalOf', [id]);
  while (epochOf(ctx.chain) < round) toNextEpoch(ctx.chain);
  await ctx.gov.send('openRound', []);
  ctx.chain.mine();
}

async function vote(ctx, id, voter, support) {
  const res = await ctx.gov.send('castVote', [id, support], { from: voter });
  return ctx.gov.events(res, 'VoteCast')[0].args;
}

async function endVoting(ctx, id) {
  const end = await ctx.gov.call('voteEndOf', [id]);
  const now = ctx.chain.timestamp;
  if (end >= now) ctx.chain.advanceTime(Number(end - now) + 1);
}

module.exports = {
  KIND,
  STATE,
  VOTE,
  VOTERS,
  TREASURY,
  ATTESTERS,
  ATTESTER_BOND,
  deployGovernance,
  propose,
  openRoundFor,
  vote,
  endVoting,
  Chain,
  ACCOUNTS,
  DAY,
  HOUR,
  WEEK,
  YEAR,
  MAX_LOCK,
  ONE,
  key,
  sel,
  diff,
  stage,
  addr,
  toNextEpoch,
  epochOf,
  deployArkToken,
  paramsIface,
};
