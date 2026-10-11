/**
 * ArkTimelock: the compiled delay table, the D7 step limits, the one-step stage
 * rule, execution windows, the guardian's single power and the one-way roles.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { expectRevert } = require('./fixtures');
const fs = require('fs');
const path = require('path');
const { Chain, ACCOUNTS, DAY, HOUR, key, sel, diff, stage, paramsIface, epochOf } = require('./gov-fixture');

const PROPOSER = ACCOUNTS.admin;
const GUARDIAN = ACCOUNTS.guardian;

async function fixture() {
  const chain = await Chain.create();
  const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, GUARDIAN]);
  const params = await chain.deploy('ParamsDouble', ['address'], [tl.address]);
  for (const [name, lo, hi, v] of [
    ['threatStage1Bps', 1850, 4000, 1850],
    ['indemnityBps', 5000, 10000, 10000],
    // An ordinary 14-day key: the double's range is the outer bound (1 - pmlFloorBps <= 5,000).
    ['maxAssetShareBps', 1, 5000, 250],
    ['bufferBps', 250, 1500, 250],
    ['releaseBoundBps', 1, 2500, 2500],
    ['operationsBps', 250, 1000, 250],
  ]) {
    await params.send('defineParam', [key(name), lo, hi, v]);
  }
  return { chain, tl, params };
}

async function scheduled(tl, target, payload, opts = { from: PROPOSER }) {
  const res = await tl.send('schedule', [target, payload], opts);
  const [ev] = tl.events(res, 'Scheduled');
  return { opId: ev.args.opId, eta: ev.args.eta, delay: ev.args.delay };
}

describe('ArkTimelock', () => {
  let chain;
  let tl;
  let params;

  beforeEach(async () => {
    ({ chain, tl, params } = await fixture());
  });

  describe('the delay is looked up, never supplied', () => {
    test('each class of key gets its table delay', async () => {
      for (const [name, was, v, days] of [
        ['releaseBoundBps', 2500, 2000, 7],
        ['maxAssetShareBps', 250, 300, 14],
        ['bufferBps', 250, 300, 30],
        ['operationsBps', 250, 300, 30],
        ['threatStage1Bps', 1850, 1900, 30],
      ]) {
        const { delay } = await scheduled(tl, params.address, diff([[name, was, v]]));
        assert.equal(delay, BigInt(days * DAY), name);
      }
    });

    test('a mixed diff takes the longest delay of its keys', async () => {
      const payload = diff([
        ['releaseBoundBps', 2500, 2000],
        ['maxAssetShareBps', 250, 300],
        ['operationsBps', 250, 300],
      ]);
      const { delay } = await scheduled(tl, params.address, payload);
      assert.equal(delay, BigInt(30 * DAY));
      assert.equal(await tl.call('delayFor', [payload]), BigInt(30 * DAY));
    });

    test('selector rows: stage 30 days, admission 48 hours, validator 7 days, handover 30 days', async () => {
      const iface = paramsIface();
      assert.equal(await tl.call('delayFor', [stage(1, 2)]), BigInt(30 * DAY));
      assert.equal(await tl.call('delayFor', [iface.encodeFunctionData('delistAsset', [key('x')])]), BigInt(48 * HOUR));
      assert.equal(
        await tl.call('delayFor', [iface.encodeFunctionData('admitValidator', ['0x01', key('a'), key('b'), ACCOUNTS.bob])]),
        BigInt(7 * DAY),
      );
      assert.equal(
        await tl.call('delayFor', [iface.encodeFunctionData('proposeGovernance', [ACCOUNTS.bob])]),
        BigInt(30 * DAY),
      );
      assert.equal(await tl.call('delayFor', [iface.encodeFunctionData('acceptGovernance', [])]), BigInt(48 * HOUR));
    });

    test('an unknown selector has no default path', async () => {
      await expectRevert(tl.send('schedule', [params.address, sel('setParams(uint256)') + '00'.repeat(32)]), 'UnknownSelector');
      await expectRevert(tl.send('schedule', [params.address, '0x1234']), 'PayloadTooShort');
    });

    test('an unknown key, including every constant of whitepaper §6.4, is refused (G12)', async () => {
      for (const name of ['unbondingDays', 'epochDays', 'censorshipWindowEpochs', 'breakerBps', 'couponCliffDays', 'nope']) {
        await expectRevert(tl.send('schedule', [params.address, diff([[name, 0, 1]])]), 'UnknownKey');
      }
    });

    test('duplicate keys and an empty diff are refused', async () => {
      await expectRevert(
        tl.send('schedule', [params.address, diff([['maxAssetShareBps', 250, 300], ['maxAssetShareBps', 300, 350]])]),
        'DuplicateKey',
      );
      await expectRevert(tl.send('schedule', [params.address, diff([])]), 'EmptyDiff');
    });

    test('D7: a value-transfer key moves at most a quarter of its range', async () => {
      await expectRevert(tl.send('schedule', [params.address, diff([['indemnityBps', 10000, 8749]])]), 'StepTooLarge');
      await scheduled(tl, params.address, diff([['indemnityBps', 10000, 8750]]));
      await expectRevert(tl.send('schedule', [params.address, diff([['threatStage2Bps', 2500, 3038]])]), 'StepTooLarge');
      // An ordinary key has no step limit here; its range lives in the target.
      await scheduled(tl, params.address, diff([['maxAssetShareBps', 250, 1500]]));
    });

    test('a stage move is one step, either direction', async () => {
      await expectRevert(tl.send('schedule', [params.address, stage(1, 3)]), 'StageStepInvalid');
      await expectRevert(tl.send('schedule', [params.address, stage(2, 2)]), 'StageStepInvalid');
      await scheduled(tl, params.address, stage(2, 1));
      // One Queued stage step per target (OC-GOV-02): the other direction goes to another target.
      await scheduled(tl, ACCOUNTS.bob, stage(1, 2));
    });
  });

  describe('execution', () => {
    test('not before eta, then by anyone, once', async () => {
      const { opId } = await scheduled(tl, params.address, diff([['maxAssetShareBps', 250, 300]]));
      chain.advanceTime(14 * DAY - 60);
      await expectRevert(tl.send('execute', [opId], { from: ACCOUNTS.mallory }), 'NotReady');
      chain.advanceTime(120);
      await tl.send('execute', [opId], { from: ACCOUNTS.mallory });
      assert.equal(await tl.call('stateOf', [opId]), 2n);
      await expectRevert(tl.send('execute', [opId]), 'OpNotQueued');
    });

    test('past the 14-day grace it expires', async () => {
      const { opId } = await scheduled(tl, params.address, diff([['maxAssetShareBps', 250, 300]]));
      chain.advanceTime(28 * DAY + 60);
      assert.equal(await tl.call('stateOf', [opId]), 4n);
      await expectRevert(tl.send('execute', [opId]), 'OpNotQueued');
    });

    test('a reverting target reverts the execution and leaves the op queued', async () => {
      const { opId } = await scheduled(tl, params.address, diff([['maxAssetShareBps', 999, 300]]));
      chain.advanceTime(14 * DAY + 1);
      await expectRevert(tl.send('execute', [opId]), 'CallFailed');
      assert.equal(await tl.call('stateOf', [opId]), 1n);
    });

    test('a payable op carries exactly the scheduled value, supplied by the executor', async () => {
      const payload = paramsIface().encodeFunctionData('admitValidator', ['0xaa', key('r'), key('e'), ACCOUNTS.bob]);
      const res = await tl.send('scheduleWithValue', [params.address, 5n * 10n ** 18n, payload]);
      const [ev] = tl.events(res, 'Scheduled');
      chain.advanceTime(7 * DAY + 1);
      await expectRevert(tl.send('execute', [ev.args.opId], { value: 1n }), 'ValueMismatch');
      await tl.send('execute', [ev.args.opId], { from: ACCOUNTS.bob, value: 5n * 10n ** 18n });
      assert.equal(await params.call('lastValue'), 5n * 10n ** 18n);
    });
  });

  describe('roles', () => {
    test('only the proposer schedules; the guardian cannot', async () => {
      await expectRevert(tl.send('schedule', [params.address, stage(1, 2)], { from: GUARDIAN }), 'NotProposer');
      await expectRevert(tl.send('schedule', [params.address, stage(1, 2)], { from: ACCOUNTS.mallory }), 'NotProposer');
    });

    test('the guardian cancels a Queued op and nothing else', async () => {
      const { opId } = await scheduled(tl, params.address, diff([['maxAssetShareBps', 250, 300]]));
      await tl.send('cancel', [opId], { from: GUARDIAN });
      assert.equal(await tl.call('stateOf', [opId]), 3n);
      await expectRevert(tl.send('cancel', [opId], { from: GUARDIAN }), 'OpNotQueued');

      const b = await scheduled(tl, params.address, diff([['maxAssetShareBps', 250, 300]]));
      chain.advanceTime(14 * DAY + 1);
      await tl.send('execute', [b.opId]);
      await expectRevert(tl.send('cancel', [b.opId], { from: GUARDIAN }), 'OpNotQueued');
      await expectRevert(tl.send('cancel', [b.opId], { from: ACCOUNTS.mallory }), 'NotProposerOrGuardian');
    });

    test('handOver is one-way, and only a 30-day self-operation to the governor named once (SWAPGOV-03)', async () => {
      // Called directly it is refused, to any account, by the proposer too.
      await expectRevert(tl.send('handOver', [ACCOUNTS.bob], { from: PROPOSER }), 'NotProposer');
      // The governor is named once, by the proposer; never the timelock itself.
      await expectRevert(tl.send('setGovernor', [ACCOUNTS.bob], { from: ACCOUNTS.bob }), 'NotProposer');
      await expectRevert(tl.send('setGovernor', [tl.address], { from: PROPOSER }), 'ZeroAddress');
      await tl.send('setGovernor', [ACCOUNTS.bob], { from: PROPOSER });
      await expectRevert(tl.send('setGovernor', [ACCOUNTS.mallory], { from: PROPOSER }), 'AlreadySet');
      // A handover to anyone else is scheduled, and fails at execution.
      const other = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('handOver', [ACCOUNTS.mallory]));
      const to = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('handOver', [ACCOUNTS.bob]));
      assert.equal(to.delay, BigInt(30 * DAY));
      chain.advanceTime(30 * DAY + 1);
      await expectRevert(tl.send('execute', [other.opId]), 'CallFailed');
      await tl.send('execute', [to.opId]);
      assert.equal((await tl.call('proposer')).toLowerCase(), ACCOUNTS.bob);
      assert.equal(await tl.call('handedOver'), true);
      await expectRevert(tl.send('schedule', [params.address, stage(1, 2)], { from: PROPOSER }), 'NotProposer');
      await expectRevert(tl.send('handOver', [PROPOSER], { from: PROPOSER }), 'NotProposer');
    });

    test('renounceGuardian is one-way, only as the timelock self-operation, and a renounced guardian cancels nothing', async () => {
      const { opId } = await scheduled(tl, params.address, diff([['maxAssetShareBps', 250, 300]]));
      // GV-03: the guardian no longer renounces itself directly; the S3 operation does.
      await expectRevert(tl.send('renounceGuardian', [], { from: GUARDIAN }), 'NotGuardian');
      const r = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('renounceGuardian', []));
      chain.advanceTime(30 * DAY + 1);
      await tl.send('execute', [r.opId]);
      assert.equal(await tl.call('guardian'), '0x' + '00'.repeat(20));
      await expectRevert(tl.send('cancel', [opId], { from: GUARDIAN }), 'NotProposerOrGuardian');
      await expectRevert(tl.send('renounceGuardian', [], { from: GUARDIAN }), 'NotGuardian');
    });

    test('the timelock can hand itself over and renounce the guardian through 30-day self-operations', async () => {
      const iface = tl.iface;
      const a = await scheduled(tl, tl.address, iface.encodeFunctionData('renounceGuardian', []));
      assert.equal(a.delay, BigInt(30 * DAY));
      await tl.send('setGovernor', [ACCOUNTS.bob], { from: PROPOSER });
      const b = await scheduled(tl, tl.address, iface.encodeFunctionData('handOver', [ACCOUNTS.bob]));
      chain.advanceTime(30 * DAY + 1);
      await tl.send('execute', [a.opId]);
      await tl.send('execute', [b.opId]);
      assert.equal(await tl.call('guardian'), '0x' + '00'.repeat(20));
      assert.equal((await tl.call('proposer')).toLowerCase(), ACCOUNTS.bob);
    });
  });
});

/**
 * The value-transfer set of design §6.8 / YP §4.5 (EC-06, PV-05, PV-19,
 * 2026-09-30): [name, lo, hi, step]. A transcription of the model's
 * `VALUE_TRANSFER_KEYS` (frontend/app src/lib/ark-governance.ts) and the YP
 * step table; the step is also checked against floor((hi - lo) / 4).
 */
const PHASES = [0, 1, 2, 3, 4];
const VALUE_TRANSFER = [
  ['threatStage1Bps', 1850, 4000, 537],
  ['threatStage2Bps', 1850, 4000, 537],
  ['threatStage3Bps', 1850, 4000, 537],
  ['threatStage4Bps', 1850, 4000, 537],
  ['verdictCoverBps', 3333, 8000, 1166],
  ['indemnityBps', 5000, 10000, 1250],
  ['pmlFloorBps', 1500, 5000, 875],
  ['juniorThicknessBps', 5000, 9000, 1000],
  ['seniorCouponBps', 0, 500, 125],
  ['trigger2FloorBps', 5000, 10000, 1250],
  ['severityFloorBps', 5000, 8000, 750],
  ['premiumSlopeRatioBps', 2500, 10000, 1875],
  ['premiumCeilingBps', 1850, 9500, 1912],
  ['surgeCeilingBps', 1850, 8750, 1725],
  ['stabilizationLevyBps', 100, 500, 100],
  ['commitmentTermEpochs', 4, 26, 5],
  ['psrCapEpochs', 2, 12, 2],
  ['tailPremiumFloorBps', 100, 500, 100],
  ['maxEpochMoveBps', 1500, 3000, 375],
  ['firstReserveDiscountBps', 300, 500, 50],
  ['reserveStepBps', 250, 1000, 187],
  ['reserveFloorBps', 2500, 6000, 875],
  ['clearingFloorBps', 2500, 7500, 1250],
  ['solverBondCeilingBps', 500, 1500, 250],
  ['solverBondFloorBps', 100, 300, 50],
  ['operationsBps', 250, 1000, 187],
  ['jurorFeeShareBps', 0, 5000, 1250],
  ['queueDecayBps', 1000, 2000, 250],
  ['queueExposureFloorBps', 2000, 5000, 750],
  ['runoffTriggerBps', 1500, 5000, 875],
  ['runoffBoundBps', 1500, 2500, 250],
  ['assessmentWindowEpochs', 2, 6, 1],
  ['fxHaircutMaxBps', 0, 3000, 750],
  ['unsoldEpochs', 2, 12, 2],
  ['bufferBps', 250, 1500, 312],
  ['bufferEscalatorCapBps', 250, 1500, 312],
  ['bufferRampThresholdBps', 500, 2000, 375],
  ['offeringBatchMultiple', 0, 100, 25],
  ['claimCostGwei', 0, 10_000_000, 2_500_000],
  // The Cushion, 2026-10-06 (staking technical reference §3.2, §3.3), per ecosystem phase since 2026-10-07.
  ...PHASES.map((p) => [`cushionTargetBps@${p}`, 0, 2000, 500]),
  ...PHASES.map((p) => [`cushionCeilingBps@${p}`, 0, 3000, 750]),
];
const THIRTY_NO_STEP = ['rewardRateCapBps', 'fxWindowDays', 'operatorBondBps', 'successorLimit'];
const FOURTEEN = [
  'maxAssetShareBps',
  'maturityLadderBps',
  'graceEpochs',
  'validatorConcentrationBps',
  'jurorSlashBps',
  'challengeWindowDays',
  'evidenceDays',
  'commitDays',
  'revealDays',
  'appealDays',
];
const SEVEN = ['releaseBoundBps', 'exitDeadlineEpochs', ...PHASES.map((p) => `admittedTermsMask@${p}`)];
/** The flat keys the per-phase cells replaced on 2026-10-07 (QuantumArk-Phases.md §3.1): no row. */
const FLAT_REPLACED = ['admittedTermsMask', 'cushionTargetBps', 'cushionCeilingBps'];

describe('ArkTimelock: the value-transfer table (EC-06, PV-05, PV-19)', () => {
  let chain;
  let tl;
  let params;

  beforeEach(async () => {
    ({ chain, tl, params } = await fixture());
  });

  test('49 value-transfer keys, each at 30 days with a quarter-range step', async () => {
    assert.equal(VALUE_TRANSFER.length, 49);
    for (const [name, lo, hi, step] of VALUE_TRANSFER) {
      assert.equal(step, Math.floor((hi - lo) / 4), `${name}: the table step is floor((hi - lo) / 4)`);
      const [delay, s] = await tl.call('keyRule', [key(name)]);
      assert.equal(delay, BigInt(30 * DAY), `${name} delay`);
      assert.equal(s, BigInt(step), `${name} step`);
    }
  });

  test('every other known key keeps its delay and has no step; the table declares no key beyond these', async () => {
    for (const [names, days] of [[THIRTY_NO_STEP, 30], [FOURTEEN, 14], [SEVEN, 7]]) {
      for (const name of names) {
        const [delay, s] = await tl.call('keyRule', [key(name)]);
        assert.deepEqual([delay, s], [BigInt(days * DAY), 0n], name);
      }
    }
    const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'utils', 'ArkGovTables.hyp'), 'utf8');
    const declared = [...src.matchAll(/bytes32 internal constant K_\w+ = keccak256\("([^"]+)"\);/g)].map((m) => m[1]).sort();
    const expected = [...VALUE_TRANSFER.map((r) => r[0]), ...THIRTY_NO_STEP, ...FOURTEEN, ...SEVEN].sort();
    assert.deepEqual(declared, expected);
  });

  test('premiumSlopeBps is renamed premiumSlopeRatioBps: the old key has no row', async () => {
    assert.deepEqual([...(await tl.call('keyRule', [key('premiumSlopeBps')]))], [0n, 0n]);
    await expectRevert(tl.send('schedule', [params.address, diff([['premiumSlopeBps', 5000, 5100]])]), 'UnknownKey');
    const { delay } = await scheduled(tl, params.address, diff([['premiumSlopeRatioBps', 5000, 6875]]));
    assert.equal(delay, BigInt(30 * DAY));
  });

  test("the Cushion's target and ceiling, per phase, are value-transfer keys: 30 days, steps 500 and 750, objectable (staking TR §3.2, §3.3)", async () => {
    const cells = PHASES.flatMap((p) => [[`cushionTargetBps@${p}`, 500, 1000, 500], [`cushionCeilingBps@${p}`, 1500, 2250, 750]]);
    for (const [name, from, to, step] of cells) {
      assert.deepEqual([...(await tl.call('keyRule', [key(name)]))], [BigInt(30 * DAY), BigInt(step)], name);
      const [delay, valueTransfer] = await tl.call('ruleFor', [diff([[name, from, to]])]);
      assert.equal(delay, BigInt(30 * DAY), name);
      assert.equal(valueTransfer, true, `${name} is watched by the objection chamber`);
      await expectRevert(tl.send('schedule', [params.address, diff([[name, from, to + 1]])]), 'StepTooLarge');
    }
  });

  test('adversarial: no value-transfer key can be scheduled with less than 30 days, alone or hidden in a shorter diff', async () => {
    const loop = [];
    for (const [name, lo, , step] of VALUE_TRANSFER) {
      const alone = await scheduled(tl, params.address, diff([[name, lo, lo + step]]));
      assert.equal(alone.delay, BigInt(30 * DAY), name);
      loop.push(alone.opId);
      // Bundled with a 7-day key and a 14-day key, the diff still waits the longest.
      const bundled = diff([
        ['releaseBoundBps', 2500, 2000],
        ['maxAssetShareBps', 250, 300],
        [name, lo, lo + step],
      ]);
      assert.equal(await tl.call('delayFor', [bundled]), BigInt(30 * DAY), `${name} bundled`);
    }
    // One queued operation per key (SWAPGOV-04): the loop's are cancelled first.
    for (const op of loop) await tl.send('cancel', [op], { from: GUARDIAN });
    // The proposer supplies no delay: the only way in is the table, and the eta holds.
    const { opId, eta } = await scheduled(tl, params.address, diff([['releaseBoundBps', 2500, 2000], ['indemnityBps', 10000, 8750]]));
    assert.equal(eta - chain.timestamp, BigInt(30 * DAY));
    chain.advanceTime(14 * DAY + 1);
    await expectRevert(tl.send('execute', [opId]), 'NotReady');
    chain.advanceTime(16 * DAY - 60);
    await expectRevert(tl.send('execute', [opId]), 'NotReady');
    chain.advanceTime(60);
    await tl.send('execute', [opId]);
  });

  test('adversarial: no value-transfer key steps beyond a quarter of its range, in either direction', async () => {
    for (const [name, lo, hi, step] of VALUE_TRANSFER) {
      await expectRevert(tl.send('schedule', [params.address, diff([[name, lo, lo + step + 1]])]), 'StepTooLarge');
      await expectRevert(tl.send('schedule', [params.address, diff([[name, hi, hi - step - 1]])]), 'StepTooLarge');
      const { opId } = await scheduled(tl, params.address, diff([[name, hi, hi - step]]));
      // One queued operation per key (SWAPGOV-04).
      await tl.send('cancel', [opId], { from: GUARDIAN });
    }
    // Walking a key twice in one operation is refused.
    await expectRevert(
      tl.send('schedule', [params.address, diff([['claimCostGwei', 0, 2_500_000], ['claimCostGwei', 2_500_000, 5_000_000]])]),
      'DuplicateKey',
    );
    // Lying about `expected` to fit two steps into one: the step passes against
    // the declared value, and the target's compare-and-swap refuses the execution.
    const { opId } = await scheduled(tl, params.address, diff([['indemnityBps', 8750, 7500]]));
    chain.advanceTime(30 * DAY + 1);
    await expectRevert(tl.send('execute', [opId]), 'CallFailed');
    assert.equal(await params.call('valueOf', [key('indemnityBps')]), 10000n);
  });
});

describe('ArkTimelock: Leg B objection at stage S1 (D6 from S1, EC-06)', () => {
  const HOLDER_A = ACCOUNTS.alice;
  const HOLDER_B = ACCOUNTS.bob;
  const HOLDER_C = ACCOUNTS.attester;
  let chain;
  let tl;
  let params;
  let source;

  beforeEach(async () => {
    ({ chain, tl, params } = await fixture());
    source = await chain.deploy('ObjectionSourceDouble');
  });

  /** Principal at the queue epoch: A 1,000 (10%), B 1,100 (11%), C 7,900. */
  async function principal(epoch) {
    await source.send('set', [HOLDER_A, epoch, 1000n]);
    await source.send('set', [HOLDER_B, epoch, 1100n]);
    await source.send('set', [HOLDER_C, epoch, 7900n]);
  }

  async function wired() {
    await tl.send('setObjectionSource', [source.address], { from: PROPOSER });
  }

  test('the source is wired once, by the S1 proposer or a 30-day self-operation, never by anyone else', async () => {
    await expectRevert(tl.send('setObjectionSource', [source.address], { from: GUARDIAN }), 'NotProposer');
    await expectRevert(tl.send('setObjectionSource', ['0x' + '00'.repeat(20)], { from: PROPOSER }), 'ZeroAddress');
    const op = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('setObjectionSource', [source.address]));
    assert.equal(op.delay, BigInt(30 * DAY));
    await wired();
    assert.equal((await tl.call('objectionSource')).toLowerCase(), source.address.toLowerCase());
    await expectRevert(tl.send('setObjectionSource', [ACCOUNTS.mallory], { from: PROPOSER }), 'AlreadySet');
    chain.advanceTime(30 * DAY + 1);
    await expectRevert(tl.send('execute', [op.opId]), 'CallFailed');
  });

  test('only a Queued S1 operation writing a value-transfer key or the stage is objectable, once per holder, with queue-epoch principal', async () => {
    const vt = await scheduled(tl, params.address, diff([['indemnityBps', 10000, 9000]]));
    await expectRevert(tl.send('object', [vt.opId], { from: HOLDER_A }), 'ObjectionSourceUnset');
    await wired();
    const e = epochOf(chain);
    await principal(e);
    // Principal recorded only after the queue epoch counts for nothing.
    await source.send('set', [ACCOUNTS.mallory, e + 1n, 5000n]);

    const plain = await scheduled(tl, params.address, diff([['maxAssetShareBps', 250, 300]]));
    await expectRevert(tl.send('object', [plain.opId], { from: HOLDER_A }), 'OpNotObjectable');
    const st = await scheduled(tl, params.address, stage(1, 2));
    assert.equal((await tl.call('objectionOf', [st.opId]))[0], true, 'a stage step is objectable');

    const res = await tl.send('object', [vt.opId], { from: HOLDER_A });
    assert.equal(tl.events(res, 'OpObjected')[0].args.totalObjection, 1000n);
    assert.equal(tl.events(res, 'OpContested').length, 0, '10% is below the 20% threshold');
    await expectRevert(tl.send('object', [vt.opId], { from: HOLDER_A }), 'OpAlreadyObjected');
    await expectRevert(tl.send('object', [vt.opId], { from: ACCOUNTS.mallory }), 'NoPrincipal');
    const [objectable, contested, queueEpoch, objection] = await tl.call('objectionOf', [vt.opId]);
    assert.deepEqual([objectable, contested, queueEpoch, objection], [true, false, e, 1000n]);

    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [vt.opId]);
    await expectRevert(tl.send('object', [vt.opId], { from: HOLDER_B }), 'OpNotQueued');
  });

  test('adversarial: a contested S1 operation is not executed at its delay, waits a second delay, and the guardian may cancel it', async () => {
    await wired();
    const { opId, eta } = await scheduled(tl, params.address, diff([['indemnityBps', 10000, 8750]]));
    await principal(epochOf(chain));
    chain.advanceTime(29 * DAY);
    await tl.send('object', [opId], { from: HOLDER_A });
    const res = await tl.send('object', [opId], { from: HOLDER_B });
    const [ev] = tl.events(res, 'OpContested');
    const second = chain.timestamp + BigInt(30 * DAY);
    assert.equal(ev.args.eta, second, 'a second delay of its keys from the close of the objection');
    assert.equal(await tl.call('etaOf', [opId]), second);
    assert.ok(second - (eta - BigInt(30 * DAY)) >= BigInt(59 * DAY), 'close to twice the delay in all');
    assert.equal(await tl.call('stateOf', [opId]), 1n, 'still Queued: no vote at S1');
    await expectRevert(tl.send('object', [opId], { from: HOLDER_C }), 'OpNotObjectable');

    chain.advanceTime(DAY + 1);
    assert.ok(chain.timestamp > eta);
    await expectRevert(tl.send('execute', [opId]), 'NotReady');
    chain.advanceTime(27 * DAY);
    await expectRevert(tl.send('execute', [opId]), 'NotReady');

    await tl.send('cancel', [opId], { from: GUARDIAN });
    assert.equal(await tl.call('stateOf', [opId]), 3n);
    chain.advanceTime(3 * DAY);
    await expectRevert(tl.send('execute', [opId]), 'OpNotQueued');
    assert.equal(await params.call('valueOf', [key('indemnityBps')]), 10000n);
  });

  test('a contested operation the guardian leaves alone executes after its second delay: escalation, not a veto', async () => {
    await wired();
    const { opId } = await scheduled(tl, params.address, diff([['indemnityBps', 10000, 8750]]));
    await principal(epochOf(chain));
    await tl.send('object', [opId], { from: HOLDER_C });
    chain.advanceTime(30 * DAY - 60);
    await expectRevert(tl.send('execute', [opId]), 'NotReady');
    chain.advanceTime(120);
    await tl.send('execute', [opId], { from: ACCOUNTS.mallory });
    assert.equal(await tl.call('stateOf', [opId]), 2n);
  });

  test('from S2 the operations the new proposer queues are the governor chamber\'s, not objectable here; an S1 operation still is', async () => {
    await wired();
    const s1 = await scheduled(tl, params.address, diff([['indemnityBps', 10000, 9000]]));
    await principal(epochOf(chain));
    await tl.send('setGovernor', [ACCOUNTS.oracle], { from: PROPOSER });
    const h = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('handOver', [ACCOUNTS.oracle]));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [h.opId]);
    assert.equal(await tl.call('handedOver'), true);
    // Another key: `indemnityBps` is still named by s1, Queued (SWAPGOV-04).
    const s2 = await scheduled(tl, params.address, diff([['bufferBps', 250, 300]]), { from: ACCOUNTS.oracle });
    await expectRevert(tl.send('object', [s2.opId], { from: HOLDER_C }), 'OpNotObjectable');
    await tl.send('object', [s1.opId], { from: HOLDER_C });
    assert.equal((await tl.call('objectionOf', [s1.opId]))[1], true);
  });

  test('a contested stage step stays queued, and counted, past its first eta + grace', async () => {
    await wired();
    const { opId } = await scheduled(tl, params.address, stage(1, 2));
    await principal(epochOf(chain));
    chain.advanceTime(29 * DAY);
    await tl.send('object', [opId], { from: HOLDER_C });
    // Past the first eta + GRACE_PERIOD (44 days from scheduling), inside the second delay.
    chain.advanceTime(16 * DAY);
    assert.equal(await tl.call('stateOf', [opId]), 1n);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
    chain.advanceTime(14 * DAY + 60);
    await tl.send('execute', [opId]);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
  });
});

describe('ArkTimelock: stageStepQueued (QL-25, PV-20)', () => {
  let chain;
  let tl;
  let params;

  beforeEach(async () => {
    ({ chain, tl, params } = await fixture());
  });

  test('true from the scheduling of a stage step until it executes', async () => {
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
    const { opId } = await scheduled(tl, params.address, stage(1, 2));
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
    chain.advanceTime(30 * DAY + 1);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true, 'ready but not executed is still queued');
    await tl.send('execute', [opId]);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
  });

  test('a cancellation by the guardian or the proposer uncounts it', async () => {
    const a = await scheduled(tl, params.address, stage(1, 2));
    await tl.send('cancel', [a.opId], { from: GUARDIAN });
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
    const b = await scheduled(tl, params.address, stage(1, 2));
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
    await tl.send('cancel', [b.opId], { from: PROPOSER });
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
  });

  test('a second queued step for one target is refused (OC-GOV-02); after a cancellation the next one counts', async () => {
    const a = await scheduled(tl, params.address, stage(1, 2));
    chain.advanceTime(DAY);
    await expectRevert(tl.send('schedule', [params.address, stage(2, 1)], { from: PROPOSER }), 'StagePending');
    await tl.send('cancel', [a.opId], { from: GUARDIAN });
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
    const b = await scheduled(tl, params.address, stage(1, 2));
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
    await tl.send('cancel', [b.opId], { from: GUARDIAN });
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
  });

  test('a failed execution leaves the step queued and counted', async () => {
    // The double stands at stage 1: a 2 -> 3 step reverts at the target.
    const { opId } = await scheduled(tl, params.address, stage(2, 3));
    chain.advanceTime(30 * DAY + 1);
    await expectRevert(tl.send('execute', [opId]), 'CallFailed');
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
  });

  test('a step that expires unexecuted stops counting, and the next one counts afresh', async () => {
    await scheduled(tl, params.address, stage(1, 2));
    chain.advanceTime(44 * DAY + 60);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false, 'past eta + GRACE_PERIOD');
    const { opId } = await scheduled(tl, params.address, stage(1, 2));
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [opId]);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false, 'the expired step no longer holds the count up');
  });

  test('adversarial: a rung diff, a value-transfer diff or another selector is not a stage step', async () => {
    await scheduled(tl, params.address, diff([['threatStage1Bps', 1850, 1900]]));
    await scheduled(tl, params.address, diff([['indemnityBps', 10000, 9000]]));
    await scheduled(tl, params.address, paramsIface().encodeFunctionData('delistAsset', [key('x')]));
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
  });
});

/**
 * The re-audit of 2026-09-30 (SWAPGOV-03, SWAPGOV-04, SWAPGOV-09): the PoCs of
 * `docs/review/audit-2026-09-30/SWAPGOV/core-timelock.poc.test.js`, as
 * regressions.
 */
describe('ArkTimelock: re-audit 2026-09-30', () => {
  let chain;
  let tl;
  let params;
  let source;

  beforeEach(async () => {
    ({ chain, tl, params } = await fixture());
    source = await chain.deploy('ObjectionSourceDouble');
    await tl.send('setObjectionSource', [source.address], { from: PROPOSER });
  });

  test('SWAPGOV-03: the S1 proposer can no longer hand the role to a key it holds and close the chamber; the handover is itself contested', async () => {
    const e = epochOf(chain);
    await source.send('set', [ACCOUNTS.alice, e, 10_000n]);
    const PUPPET = ACCOUNTS.mallory;
    // The PoC's step: a direct handover to a puppet, refused.
    await expectRevert(tl.send('handOver', [PUPPET], { from: PROPOSER }), 'NotProposer');
    assert.equal(await tl.call('handedOver'), false);
    // Named as the governor, the puppet still needs a 30-day operation, and Leg B contests it at S1.
    await tl.send('setGovernor', [PUPPET], { from: PROPOSER });
    const h = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('handOver', [PUPPET]));
    assert.equal(h.delay, BigInt(30 * DAY));
    assert.equal((await tl.call('objectionOf', [h.opId]))[0], true, 'the handover is objectable at S1');
    chain.advanceTime(29 * DAY);
    await tl.send('object', [h.opId], { from: ACCOUNTS.alice });
    assert.equal((await tl.call('objectionOf', [h.opId]))[1], true, 'contested');
    chain.advanceTime(2 * DAY);
    await expectRevert(tl.send('execute', [h.opId]), 'NotReady');
    // Inside the second delay the guardian cancels it; the chamber stays open.
    await tl.send('cancel', [h.opId], { from: GUARDIAN });
    const op = await scheduled(tl, params.address, diff([['indemnityBps', 10000, 8750]]));
    assert.equal((await tl.call('objectionOf', [op.opId]))[0], true, 'still objectable: no handover happened');
  });

  test('SWAPGOV-04 (GV-01): a second operation naming a queued key is refused, so four quarter-steps cannot run in one block', async () => {
    const a = await scheduled(tl, params.address, diff([['indemnityBps', 10000, 8750]]));
    await expectRevert(tl.send('schedule', [params.address, diff([['indemnityBps', 8750, 7500]])], { from: PROPOSER }), 'KeyPending');
    // Hidden in a diff of several keys, too.
    await expectRevert(
      tl.send('schedule', [params.address, diff([['bufferBps', 250, 300], ['indemnityBps', 8750, 7500]])], { from: PROPOSER }),
      'KeyPending',
    );
    // Another key is free.
    await scheduled(tl, params.address, diff([['bufferBps', 250, 300]]));
    // Executed, the key is free again.
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [a.opId]);
    const b = await scheduled(tl, params.address, diff([['indemnityBps', 8750, 7500]]));
    // Cancelled, free; expired, free.
    await tl.send('cancel', [b.opId], { from: GUARDIAN });
    await scheduled(tl, params.address, diff([['indemnityBps', 8750, 7500]]));
    chain.advanceTime(44 * DAY + 60);
    await scheduled(tl, params.address, diff([['indemnityBps', 8750, 7500]]));
  });

  test('SWAPGOV-09: a stage payload aimed at any other account holds nothing for the parameter set', async () => {
    await scheduled(tl, ACCOUNTS.bob, stage(3, 4));
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false, 'the parameter set sees nothing queued');
    assert.equal(await tl.call('stageStepQueuedFor', [ACCOUNTS.bob]), true, 'counted for its own target');
    // `stageStepQueued()` reads the caller's own count: an account with nothing queued reads false.
    assert.equal(await tl.call('stageStepQueued', [], { from: ACCOUNTS.alice }), false);
    await scheduled(tl, params.address, stage(1, 2));
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
    chain.advanceTime(44 * DAY + 60);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
  });

  test('ORIGIN-01: the registry\'s seed-return request is a 48-hour row, voted with the de-listing', async () => {
    const { Interface } = require('ethers');
    const reg = new Interface(['function requestSeedReturn(uint256 chainId, address escrow)']);
    const payload = reg.encodeFunctionData('requestSeedReturn', [1n, ACCOUNTS.bob]);
    assert.equal(await tl.call('delayFor', [payload]), BigInt(48 * HOUR));
    const rules = await chain.deploy('ArkGovernorRules');
    const s = payload.slice(0, 10);
    assert.equal(await rules.call('allows', [11, s]), true, 'StakingDelisting');
    assert.equal(await rules.call('allows', [8, s]), false, 'not StakingParameter');
  });
});

/**
 * The ecosystem phase rows (QuantumArk-Phases.md §3, 2026-10-07): ArkPhase's
 * three selectors, the per-phase keys that replaced three flat keys, and the
 * phase count `stageStepQueued` reports for every reader (OC-LEGB-09).
 */
describe('ArkTimelock: ecosystem phase rows (2026-10-07)', () => {
  const { Interface } = require('ethers');
  const phaseIface = new Interface([
    'function setPhase(uint8 fromPhase, uint8 toPhase)',
    'function enterQDay(uint8 fromPhase)',
    'function restore(bytes32 evidenceHash)',
  ]);
  const setPhase = (f, t) => phaseIface.encodeFunctionData('setPhase', [f, t]);
  const enterQDay = (f) => phaseIface.encodeFunctionData('enterQDay', [f]);
  const restore = () => phaseIface.encodeFunctionData('restore', ['0x' + 'ab'.repeat(32)]);
  // Any account stands in for ArkPhase: the timelock reads the payload, never the target.
  const PHASE = ACCOUNTS.bob;
  let chain;
  let tl;
  let params;

  beforeEach(async () => {
    ({ chain, tl, params } = await fixture());
  });

  test('setPhase 30 days, enterQDay 48 hours, restore 30 days, all watched by Leg B; setThreatStage keeps its row', async () => {
    for (const [payload, delay] of [[setPhase(0, 1), 30 * DAY], [setPhase(2, 1), 30 * DAY], [enterQDay(2), 48 * HOUR], [restore(), 30 * DAY], [stage(2, 3), 30 * DAY]]) {
      const [d, vt] = await tl.call('ruleFor', [payload]);
      assert.deepEqual([d, vt], [BigInt(delay), true], payload.slice(0, 10));
    }
    for (const [sig, id] of [['setPhase(uint8,uint8)', setPhase(0, 1)], ['enterQDay(uint8)', enterQDay(0)], ['restore(bytes32)', restore()]]) {
      assert.equal(sel(sig), id.slice(0, 10));
    }
    const { opId } = await scheduled(tl, PHASE, enterQDay(0));
    assert.equal((await tl.call('objectionOf', [opId]))[0], true, 'objectable at S1 (Phases doc R2)');
  });

  test('the payload is checked: setPhase one step within 0..2, enterQDay from 0..2 (StageStepInvalid)', async () => {
    for (const [f, t] of [[0, 2], [1, 1], [2, 3], [3, 2], [3, 4], [4, 3]]) {
      await expectRevert(tl.send('schedule', [PHASE, setPhase(f, t)], { from: PROPOSER }), 'StageStepInvalid');
    }
    for (const f of [3, 4]) await expectRevert(tl.send('schedule', [PHASE, enterQDay(f)], { from: PROPOSER }), 'StageStepInvalid');
  });

  test('stageStepQueued reports a queued phase step to every caller, whatever its target; phaseStepQueued alone', async () => {
    assert.equal(await tl.call('stageStepQueued', [], { from: params.address }), false);
    const { opId } = await scheduled(tl, PHASE, setPhase(0, 1));
    for (const who of [params.address, ACCOUNTS.alice, PHASE]) {
      assert.equal(await tl.call('stageStepQueued', [], { from: who }), true, who);
      assert.equal(await tl.call('stageStepQueuedFor', [who]), true, who);
    }
    assert.equal(await tl.call('phaseStepQueued'), true);
    chain.advanceTime(30 * DAY + 1);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true, 'ready but not executed is still queued');
    // The target is no ArkPhase, so the call does nothing; executed, it is uncounted all the same.
    await tl.send('execute', [opId]);
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
    assert.equal(await tl.call('phaseStepQueued'), false);
  });

  test('enterQDay and restore count too; a cancellation uncounts; an expired one stops counting', async () => {
    for (const payload of [enterQDay(1), restore()]) {
      const { opId } = await scheduled(tl, PHASE, payload);
      assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true);
      await tl.send('cancel', [opId], { from: GUARDIAN });
      assert.equal(await tl.call('stageStepQueuedFor', [params.address]), false);
    }
    await scheduled(tl, PHASE, enterQDay(0));
    chain.advanceTime(48 * HOUR + 14 * DAY + 60);
    assert.equal(await tl.call('phaseStepQueued'), false, 'past eta + GRACE_PERIOD');
    await scheduled(tl, PHASE, setPhase(0, 1));
    assert.equal(await tl.call('phaseStepQueued'), true, 'the next one counts afresh');
  });

  test('one phase step at a time (StagePending), except the defensive enterQDay, which is never held behind one', async () => {
    const a = await scheduled(tl, PHASE, setPhase(0, 1));
    await expectRevert(tl.send('schedule', [PHASE, setPhase(1, 2)], { from: PROPOSER }), 'StagePending');
    // Counted for the network, not per target.
    await expectRevert(tl.send('schedule', [ACCOUNTS.alice, restore()], { from: PROPOSER }), 'StagePending');
    const b = await scheduled(tl, PHASE, enterQDay(0));
    await tl.send('cancel', [a.opId], { from: GUARDIAN });
    assert.equal(await tl.call('phaseStepQueued'), true, 'the enterQDay is still queued');
    await expectRevert(tl.send('schedule', [PHASE, restore()], { from: PROPOSER }), 'StagePending');
    await tl.send('cancel', [b.opId], { from: PROPOSER });
    assert.equal(await tl.call('phaseStepQueued'), false);
    await scheduled(tl, PHASE, restore());
  });

  test('the threat-stage count stays per target: a phase step does not block an in-band stage step', async () => {
    await scheduled(tl, PHASE, setPhase(1, 2));
    const s = await scheduled(tl, params.address, stage(2, 3));
    await expectRevert(tl.send('schedule', [params.address, stage(2, 3)], { from: PROPOSER }), 'StagePending');
    await tl.send('cancel', [s.opId], { from: GUARDIAN });
    assert.equal(await tl.call('stageStepQueuedFor', [params.address]), true, 'the phase step still holds');
    assert.equal(await tl.call('stageStepQueuedFor', [ACCOUNTS.mallory]), true);
  });

  test('a contested phase step stays counted through its second delay', async () => {
    const source = await chain.deploy('ObjectionSourceDouble');
    await tl.send('setObjectionSource', [source.address], { from: PROPOSER });
    await source.send('set', [ACCOUNTS.alice, epochOf(chain), 10_000n]);
    const { opId } = await scheduled(tl, PHASE, setPhase(0, 1));
    chain.advanceTime(29 * DAY);
    await tl.send('object', [opId], { from: ACCOUNTS.alice });
    assert.equal((await tl.call('objectionOf', [opId]))[1], true);
    chain.advanceTime(16 * DAY);
    assert.equal(await tl.call('phaseStepQueued'), true, 'past the first eta + grace, inside the second delay');
    await tl.send('cancel', [opId], { from: GUARDIAN });
    assert.equal(await tl.call('phaseStepQueued'), false);
  });

  test('per-phase keys: admittedTermsMask@p 7 days, cushion target and ceiling @p 30 days with their steps; the flat keys and p > 4 have no row', async () => {
    for (const p of [0, 1, 2, 3, 4]) {
      assert.deepEqual([...(await tl.call('keyRule', [key(`admittedTermsMask@${p}`)]))], [BigInt(7 * DAY), 0n]);
      assert.deepEqual([...(await tl.call('keyRule', [key(`cushionTargetBps@${p}`)]))], [BigInt(30 * DAY), 500n]);
      assert.deepEqual([...(await tl.call('keyRule', [key(`cushionCeilingBps@${p}`)]))], [BigInt(30 * DAY), 750n]);
    }
    for (const name of [...FLAT_REPLACED, 'admittedTermsMask@5', 'cushionTargetBps@5', 'cushionCeilingBps@5', 'cushionTargetBps@']) {
      assert.deepEqual([...(await tl.call('keyRule', [key(name)]))], [0n, 0n], name);
      await expectRevert(tl.send('schedule', [params.address, diff([[name, 500, 501]])], { from: PROPOSER }), 'UnknownKey');
    }
    // Cells of one phase in one diff: the longest delay; each cell is its own pending key.
    const { delay } = await scheduled(tl, params.address, diff([['admittedTermsMask@2', 7, 3], ['cushionTargetBps@2', 500, 1000]]));
    assert.equal(delay, BigInt(30 * DAY));
    await expectRevert(tl.send('schedule', [params.address, diff([['cushionTargetBps@2', 1000, 1500]])], { from: PROPOSER }), 'KeyPending');
    await scheduled(tl, params.address, diff([['cushionTargetBps@3', 1500, 1000]]));
  });
});
