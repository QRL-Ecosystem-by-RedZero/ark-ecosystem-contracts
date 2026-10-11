/**
 * OC round 2026-10-03, stream GOV (docs/review/audit-2026-10-03/GOV/REPORT.md
 * at the umbrella root): regressions for the findings fixed in this tree, and
 * for GV-02, GV-03 and GV-17, which that report found still true.
 *
 *   OC-GOV-01  proposeGovernance, setObjectionSource and setCourt are objectable at S1,
 *              and the governor reads the same set from the timelock (`ruleFor`)
 *   OC-GOV-02  one Queued setThreatStage operation per target (`StagePending`)
 *   OC-GOV-03  `acceptGovernanceOf`: a proposed timelock accepts at once, nothing pending
 *   OC-GOV-06  a round proposal is refused while the timelock's proposer is not the governor
 *   GV-02      the pin horizon carries QUEUE_GRACE and the timelock's GRACE_PERIOD
 *   GV-03      the guardian keeps nothing: no direct renounce, no cancel of its removal
 *   GV-17      proposer != guardian; the governor's shares are at most 10,000 bps
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { expectRevert } = require('./fixtures');
const {
  Chain,
  ACCOUNTS,
  DAY,
  WEEK,
  ONE,
  KIND,
  VOTERS,
  TREASURY,
  key,
  diff,
  stage,
  epochOf,
  deployArkToken,
  deployGovernance,
  propose,
  openRoundFor,
  vote,
} = require('./gov-fixture');

const PROPOSER = ACCOUNTS.admin;
const GUARDIAN = ACCOUNTS.guardian;
const ZERO = '0x' + '00'.repeat(20);

async function s1() {
  const chain = await Chain.create();
  const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, GUARDIAN]);
  const params = await chain.deploy('ParamsDouble', ['address'], [tl.address]);
  for (const [name, lo, hi, v] of [
    ['indemnityBps', 5000, 10000, 10000],
    ['maxAssetShareBps', 1, 5000, 250],
  ]) {
    await params.send('defineParam', [key(name), lo, hi, v]);
  }
  const source = await chain.deploy('ObjectionSourceDouble');
  await tl.send('setObjectionSource', [source.address], { from: PROPOSER });
  return { chain, tl, params, source };
}

async function scheduled(tl, target, payload, from = PROPOSER) {
  const res = await tl.send('schedule', [target, payload], { from });
  const [ev] = tl.events(res, 'Scheduled');
  return { opId: ev.args.opId, eta: ev.args.eta, delay: ev.args.delay };
}

describe('OC-GOV-01: what ends or redirects a chamber is objectable at S1', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await s1();
  });

  test('proposeGovernance, setObjectionSource and setCourt are 30-day operations Leg B can object to', async () => {
    const { tl, params, source, chain } = ctx;
    const gov = ACCOUNTS.bob;
    const payloads = [
      [params.address, params.iface.encodeFunctionData('proposeGovernance', [ACCOUNTS.mallory])],
      [gov, tl.iface.encodeFunctionData('setObjectionSource', [source.address])],
      [gov, new (require('ethers').Interface)(['function setCourt(address)']).encodeFunctionData('setCourt', [ACCOUNTS.oracle])],
    ];
    await source.send('set', [ACCOUNTS.alice, epochOf(chain), 10_000n]);
    for (const [target, payload] of payloads) {
      const [delay, vt] = await tl.call('ruleFor', [payload]);
      assert.equal(delay, BigInt(30 * DAY));
      assert.equal(vt, true, `ruleFor flags ${payload.slice(0, 10)}`);
      const op = await scheduled(tl, target, payload);
      assert.equal((await tl.call('objectionOf', [op.opId]))[0], true, `${payload.slice(0, 10)} objectable at S1`);
      await tl.send('object', [op.opId], { from: ACCOUNTS.alice });
      assert.equal((await tl.call('objectionOf', [op.opId]))[1], true, 'contested by 100% of principal');
    }
  });

  test('the PoC: proposeGovernance(mallory), contested, is not executed at its delay and the guardian cancels it', async () => {
    const { tl, params, source, chain } = ctx;
    await source.send('set', [ACCOUNTS.alice, epochOf(chain), 10_000n]);
    const op = await scheduled(tl, params.address, params.iface.encodeFunctionData('proposeGovernance', [ACCOUNTS.mallory]));
    chain.advanceTime(29 * DAY);
    await tl.send('object', [op.opId], { from: ACCOUNTS.alice });
    chain.advanceTime(2 * DAY);
    await expectRevert(tl.send('execute', [op.opId]), 'NotReady');
    await tl.send('cancel', [op.opId], { from: GUARDIAN });
    assert.equal(await params.call('pendingGovernance'), ZERO);
  });

  test('a key with no step and an admission stay unobjectable', async () => {
    const { tl, params } = ctx;
    const [, a] = await tl.call('ruleFor', [diff([['maxAssetShareBps', 250, 300]])]);
    const [, b] = await tl.call('ruleFor', [params.iface.encodeFunctionData('delistAsset', [key('x')])]);
    assert.deepEqual([a, b], [false, false]);
  });

  test('at S2 the governor treats setCourt as value transfer: one action, and its proposal is flagged', async () => {
    const g = await deployGovernance();
    const setCourt = g.gov.iface.encodeFunctionData('setCourt', [ACCOUNTS.oracle]);
    const source = g.gov.iface.encodeFunctionData('setObjectionSource', [ACCOUNTS.oracle]);
    await expectRevert(propose(g, KIND.RenounceAdmin, [[g.gov.address, setCourt], [g.gov.address, source]]), 'BadActions');
    const id = await propose(g, KIND.RenounceAdmin, [[g.gov.address, setCourt]]);
    const p = await g.gov.call('proposalOf', [id]);
    assert.equal(p.valueTransfer, true);
    assert.equal(p.delay, BigInt(30 * DAY));
  });
});

describe('OC-GOV-02: one Queued stage step per target', () => {
  test('1->2, 2->3 and 3->4 can no longer be queued at once; the next waits for the last to leave the queue', async () => {
    const { tl, params, chain } = await s1();
    const a = await scheduled(tl, params.address, stage(1, 2));
    await expectRevert(tl.send('schedule', [params.address, stage(2, 3)], { from: PROPOSER }), 'StagePending');
    await expectRevert(tl.send('schedule', [params.address, stage(1, 2)], { from: PROPOSER }), 'StagePending');
    // Another target is counted on its own (SWAPGOV-09).
    await scheduled(tl, ACCOUNTS.bob, stage(1, 2));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [a.opId]);
    assert.equal(await params.call('threatStage'), 2n);
    const b = await scheduled(tl, params.address, stage(2, 3));
    assert.equal(b.eta - BigInt(chain.timestamp), BigInt(30 * DAY), 'the second step starts its own 30 days after the first ran');
  });

  test('an expired step no longer blocks the next', async () => {
    const { tl, params, chain } = await s1();
    await scheduled(tl, params.address, stage(1, 2));
    chain.advanceTime(44 * DAY + 60);
    await scheduled(tl, params.address, stage(1, 2));
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
  });
});

describe('OC-GOV-03: the timelock accepts a proposed governance at once', () => {
  test('anyone has it accept; governance is the timelock and nothing is pending', async () => {
    const chain = await Chain.create();
    const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, GUARDIAN]);
    const deployer = ACCOUNTS.alice;
    const params = await chain.deploy('ParamsDouble', ['address'], [deployer]);
    await expectRevert(tl.send('acceptGovernanceOf', [params.address], { from: ACCOUNTS.mallory }), 'NotPendingGovernance');
    await params.send('proposeGovernance', [tl.address], { from: deployer });
    const res = await tl.send('acceptGovernanceOf', [params.address], { from: ACCOUNTS.mallory });
    const [ev] = tl.events(res, 'GovernanceAccepted');
    assert.equal(ev.args.target.toLowerCase(), params.address.toLowerCase());
    assert.equal((await params.call('governance')).toLowerCase(), tl.address.toLowerCase());
    assert.equal(await params.call('pendingGovernance'), ZERO);
    // The deployer governs nothing from here: every setter waits the table.
    await expectRevert(params.send('setParamsDiff', [[]], { from: deployer }), 'OnlyGovernance');
    await expectRevert(params.send('proposeGovernance', [deployer], { from: deployer }), 'OnlyGovernance');
    // The slow path still has its row.
    assert.equal(await tl.call('delayFor', [params.iface.encodeFunctionData('acceptGovernance', [])]), BigInt(2 * DAY));
  });
});

describe('OC-GOV-06: no round proposal at S1', () => {
  test('propose reverts while the timelock\'s proposer is the multisig, and works once handed over', async () => {
    const chain = await Chain.create();
    const ark = await deployArkToken(chain);
    const ve = await chain.deploy('VeArk', ['address', 'address[]'], [ark.address, [TREASURY]]);
    const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, GUARDIAN]);
    const rules = await chain.deploy('ArkGovernorRules');
    const gov = await chain.deploy(
      'ArkGovernor',
      ['address', 'address', 'address', 'address', 'address', 'uint16', 'uint16', 'uint16', 'uint256'],
      [ve.address, tl.address, rules.address, ark.address, ZERO, 10, 500, 2000, 5000n * ONE],
    );
    await ve.send('setGovernor', [gov.address]);
    const params = await chain.deploy('ParamsDouble', ['address'], [tl.address]);
    await params.send('defineParam', [key('maxAssetShareBps'), 1, 5000, 250]);
    const action = [[params.address], [0n], [diff([['maxAssetShareBps', 250, 300]])], 'ipfs://x'];
    await expectRevert(gov.send('propose', [KIND.StakingParameter, ...action], { from: ACCOUNTS.alice }), 'NotTimelockProposer');
    await tl.send('setGovernor', [gov.address], { from: PROPOSER });
    const h = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('handOver', [gov.address]));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [h.opId]);
    await ark.send('approve', [ve.address, 10n ** 30n], { from: ACCOUNTS.alice });
    await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(52 * WEEK)], { from: ACCOUNTS.alice });
    const res = await gov.send('propose', [KIND.StakingParameter, ...action], { from: ACCOUNTS.alice });
    assert.equal(gov.events(res, 'ProposalCreated').length, 1);
  });
});

describe('GV-02: the pin horizon carries both graces', () => {
  test('a voter is pinned until vote end + QUEUE_GRACE + delay + GRACE_PERIOD + one epoch', async () => {
    const g = await deployGovernance();
    const id = await propose(g, KIND.StakingParameter, [[g.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await openRoundFor(g, id);
    await vote(g, id, VOTERS.small, 1);
    const { round } = await g.gov.call('proposalOf', [id]);
    const { openedAt } = await g.gov.call('roundOf', [round]);
    const H = openedAt + BigInt(5 * DAY + DAY) + BigInt(14 * DAY) + BigInt(14 * DAY) + BigInt(14 * DAY) + BigInt(WEEK);
    assert.equal(await g.ve.call('pinOf', [VOTERS.small]), H);
    // The latest the operation can execute is inside H: queued at the last moment, executed at the last moment.
    const latestExecution = openedAt + BigInt(6 * DAY) + BigInt(14 * DAY) + BigInt(14 * DAY) + BigInt(14 * DAY);
    assert.ok(latestExecution < H);
  });
});

describe('GV-03: the guardian cannot keep itself', () => {
  test('no direct renounce; no cancel of its removal; an uncontested handover is the proposer\'s to withdraw', async () => {
    const { tl, chain, source } = await s1();
    await expectRevert(tl.send('renounceGuardian', [], { from: GUARDIAN }), 'NotGuardian');
    const r = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('renounceGuardian', []));
    await expectRevert(tl.send('cancel', [r.opId], { from: GUARDIAN }), 'GuardianCannotCancel');
    await tl.send('setGovernor', [ACCOUNTS.bob], { from: PROPOSER });
    const h = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('handOver', [ACCOUNTS.bob]));
    await expectRevert(tl.send('cancel', [h.opId], { from: GUARDIAN }), 'GuardianCannotCancel');
    // Contested by Leg B, the handover is the guardian's to cancel (its S1 chamber role).
    await source.send('set', [ACCOUNTS.alice, epochOf(chain), 10_000n]);
    await tl.send('object', [h.opId], { from: ACCOUNTS.alice });
    await tl.send('cancel', [h.opId], { from: GUARDIAN });
    // The proposer may withdraw its own S3 operation.
    await tl.send('cancel', [r.opId], { from: PROPOSER });
  });
});

describe('GV-17: constructor arguments', () => {
  test('the timelock refuses one account as proposer and guardian', async () => {
    const chain = await Chain.create();
    await assert.rejects(chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, PROPOSER]), /failed/);
    await chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, ZERO]);
  });

  test('the governor refuses a share above 10,000 bps, and a Q-Day quorum outside 100..5,000 (OC-GOV-11)', async () => {
    const chain = await Chain.create();
    const ark = await deployArkToken(chain);
    const ve = await chain.deploy('VeArk', ['address', 'address[]'], [ark.address, [TREASURY]]);
    const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, GUARDIAN]);
    const rules = await chain.deploy('ArkGovernorRules');
    const types = ['address', 'address', 'address', 'address', 'address', 'uint16', 'uint16', 'uint16', 'uint256'];
    const base = [ve.address, tl.address, rules.address, ark.address, ZERO];
    for (const bps of [[10001, 500, 2000], [10, 99, 2000], [10, 0, 2000], [10, 5001, 2000], [10, 10001, 2000], [10, 500, 10001]]) {
      await assert.rejects(chain.deploy('ArkGovernor', types, [...base, ...bps, 0n]), /failed/);
    }
    await chain.deploy('ArkGovernor', types, [...base, 10000, 100, 10000, 0n]);
    const g = await chain.deploy('ArkGovernor', types, [...base, 10000, 5000, 10000, 0n]);
    assert.equal(await g.call('qdayQuorumBps'), 5000n);
  });
});

