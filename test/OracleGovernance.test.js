/**
 * The valuation oracle of contracts/staking (ArkReferenceOracle) in the
 * timelock's table: technical reference §3.3 and §3.7, yellow paper §6.1.
 *
 *   keys       fourteen days: reporterQuorum, roundIntervalSeconds,
 *              heartbeatSeconds, maxStepBps, maxDispersionBps,
 *              deviationAlarmBps, venueListHash, freezeVenueListHash;
 *              thirty days: arkReferencePrice (value transfer, a step of
 *              2,500 bps of the value replaced) and pauseMaxEpochs (no step)
 *   selectors  addReporter / removeReporter seven days (as the Q-Day
 *              attesters); pause() seven days, the renewal of a guardian
 *              pause in force, objectable at S1 (a reading: the papers give
 *              it no row)
 *   governor   the keys ride StakingParameter's setParamsDiff; reporters are
 *              AttesterSetChange; the renewal is StakingParameter
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Interface } = require('ethers');
const { expectRevert } = require('./fixtures');
const { Chain, ACCOUNTS, DAY, WEEK, KIND, key, diff, epochOf, deployGovernance, propose } = require('./gov-fixture');

const PROPOSER = ACCOUNTS.admin;
const GUARDIAN = ACCOUNTS.guardian;
const RELATIVE = 1n << 255n;
const ONE = 10n ** 18n;

const FOURTEEN = [
  'reporterQuorum',
  'roundIntervalSeconds',
  'heartbeatSeconds',
  'maxStepBps',
  'maxDispersionBps',
  'deviationAlarmBps',
  'venueListHash',
  'freezeVenueListHash',
];
const ORACLE = new Interface([
  'function addReporter(address)',
  'function removeReporter(address)',
  'function pause()',
  'function submit(uint64,uint256,address,uint256,bytes32)',
  'function submitYield(uint64,uint256,address,uint256)',
  'function setReporterQuorum(uint16)',
  'function unpause()',
]);
const call = (fn, args = []) => ORACLE.encodeFunctionData(fn, args);

/** S1: the multisig proposes, Leg B's source is wired; the targets are governed by the timelock. */
async function s1({ pauseMaxEpochs = 2 } = {}) {
  const chain = await Chain.create();
  const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, GUARDIAN]);
  // The keyed diff is the same payload on the oracle as on the parameter set.
  const params = await chain.deploy('ParamsDouble', ['address'], [tl.address]);
  for (const [name, lo, hi, v] of [
    ['reporterQuorum', 2, 9, 3],
    ['roundIntervalSeconds', 900, 14400, 3600],
    ['heartbeatSeconds', 3600, 86400, 21600],
    ['maxStepBps', 250, 2500, 1000],
    ['maxDispersionBps', 100, 1000, 300],
    ['deviationAlarmBps', 500, 5000, 1500],
    ['venueListHash', 0, (1n << 256n) - 1n, BigInt(key('venues'))],
    ['freezeVenueListHash', 0, (1n << 256n) - 1n, BigInt(key('freeze venues'))],
    ['arkReferencePrice', 1, 10n ** 40n, 4n * ONE],
    ['pauseMaxEpochs', 1, 4, 2],
  ]) {
    await params.send('defineParam', [key(name), lo, hi, v]);
  }
  const oracle = await chain.deploy('ReferenceOracleDouble', ['address', 'uint256'], [tl.address, pauseMaxEpochs]);
  const source = await chain.deploy('ObjectionSourceDouble');
  await tl.send('setObjectionSource', [source.address], { from: PROPOSER });
  return { chain, tl, params, oracle, source };
}

async function scheduled(tl, target, payload, from = PROPOSER) {
  const res = await tl.send('schedule', [target, payload], { from });
  const [ev] = tl.events(res, 'Scheduled');
  return { opId: ev.args.opId, eta: ev.args.eta, delay: ev.args.delay };
}

describe('the valuation oracle in the timelock table (technical reference §3.3, §3.7)', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await s1();
  });

  test('keyRule: eight keys at 14 days, pauseMaxEpochs at 30 days without a step, arkReferencePrice at 30 days with a relative step', async () => {
    const { tl } = ctx;
    for (const name of FOURTEEN) {
      assert.deepEqual([...(await tl.call('keyRule', [key(name)]))], [BigInt(14 * DAY), 0n], name);
    }
    assert.deepEqual([...(await tl.call('keyRule', [key('pauseMaxEpochs')]))], [BigInt(30 * DAY), 0n]);
    assert.deepEqual([...(await tl.call('keyRule', [key('arkReferencePrice')]))], [BigInt(30 * DAY), RELATIVE | 2500n]);
    // The table declares these ten oracle keys and no other.
    const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'utils', 'ArkGovTables.hyp'), 'utf8');
    const declared = [...src.matchAll(/bytes32 internal constant O_\w+ = keccak256\("([^"]+)"\);/g)].map((m) => m[1]).sort();
    assert.deepEqual(declared, [...FOURTEEN, 'arkReferencePrice', 'pauseMaxEpochs'].sort());
  });

  test('the timelock schedules each oracle key with its delay, and a diff waits the longest of its keys', async () => {
    const { tl, params } = ctx;
    const values = {
      reporterQuorum: [3, 4],
      roundIntervalSeconds: [3600, 1800],
      heartbeatSeconds: [21600, 10800],
      maxStepBps: [1000, 1500],
      maxDispersionBps: [300, 200],
      deviationAlarmBps: [1500, 2000],
      venueListHash: [BigInt(key('venues')), BigInt(key('venues v2'))],
      freezeVenueListHash: [BigInt(key('freeze venues')), BigInt(key('freeze venues v2'))],
      pauseMaxEpochs: [2, 3],
      arkReferencePrice: [4n * ONE, 5n * ONE],
    };
    for (const [name, [was, v]] of Object.entries(values)) {
      const days = FOURTEEN.includes(name) ? 14 : 30;
      const op = await scheduled(tl, params.address, diff([[name, was, v]]));
      assert.equal(op.delay, BigInt(days * DAY), name);
      assert.equal(op.eta - BigInt(ctx.chain.timestamp), BigInt(days * DAY), `${name} eta`);
    }
    const mixed = diff([['maxStepBps', 1000, 1200], ['pauseMaxEpochs', 2, 1]]);
    assert.equal(await tl.call('delayFor', [mixed]), BigInt(30 * DAY));
  });

  test('a queued key is pending: a second diff naming it is refused until the first leaves the queue', async () => {
    const { tl, params, chain } = ctx;
    const a = await scheduled(tl, params.address, diff([['heartbeatSeconds', 21600, 10800]]));
    await expectRevert(tl.send('schedule', [params.address, diff([['heartbeatSeconds', 21600, 7200]])]), 'KeyPending');
    chain.advanceTime(14 * DAY + 1);
    await tl.send('execute', [a.opId]);
    await scheduled(tl, params.address, diff([['heartbeatSeconds', 10800, 7200]]));
  });

  test('arkReferencePrice moves at most 2,500 bps of the value it replaces, up or down, and executes after 30 days', async () => {
    const { tl, params, chain } = ctx;
    const was = 4n * ONE;
    const quarter = was / 4n;
    for (const v of [was + quarter + 1n, was - quarter - 1n, was * 2n, 1n]) {
      await expectRevert(tl.call('delayFor', [diff([['arkReferencePrice', was, v]])]), 'StepTooLarge');
    }
    for (const v of [was + quarter, was - quarter]) {
      const [delay, vt] = await tl.call('ruleFor', [diff([['arkReferencePrice', was, v]])]);
      assert.deepEqual([delay, vt], [BigInt(30 * DAY), true], `to ${v}`);
    }
    // Measured against the operation's own expected value: a lie about it is the target's CAS to refuse.
    const op = await scheduled(tl, params.address, diff([['arkReferencePrice', was, was + quarter]]));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [op.opId]);
    chain.advanceTime(WEEK);
    assert.equal(await params.call('valueOf', [key('arkReferencePrice')]), was + quarter);
    // An absolute bound is not the rule: from a small value the same relative step is small.
    await expectRevert(tl.call('delayFor', [diff([['arkReferencePrice', 4n, 6n]])]), 'StepTooLarge');
    assert.equal(await tl.call('delayFor', [diff([['arkReferencePrice', 4n, 5n]])]), BigInt(30 * DAY));
  });

  test('the fourteen-day keys and pauseMaxEpochs are not value transfer; arkReferencePrice is', async () => {
    const { tl } = ctx;
    for (const name of FOURTEEN) {
      const [, vt] = await tl.call('ruleFor', [diff([[name, 1, 2]])]);
      assert.equal(vt, false, name);
    }
    assert.equal((await tl.call('ruleFor', [diff([['pauseMaxEpochs', 2, 4]])]))[1], false);
    assert.equal((await tl.call('ruleFor', [diff([['maxStepBps', 1000, 1100], ['arkReferencePrice', 100, 101]])]))[1], true);
  });

  test('reporters: addReporter and removeReporter wait 7 days and are not objectable', async () => {
    const { tl, oracle, chain } = ctx;
    for (const fn of ['addReporter', 'removeReporter']) {
      const [delay, vt] = await tl.call('ruleFor', [call(fn, [ACCOUNTS.bob])]);
      assert.deepEqual([delay, vt], [BigInt(7 * DAY), false], fn);
    }
    const add = await scheduled(tl, oracle.address, call('addReporter', [ACCOUNTS.bob]));
    assert.equal((await tl.call('objectionOf', [add.opId]))[0], false);
    chain.advanceTime(7 * DAY - 60);
    await expectRevert(tl.send('execute', [add.opId]), 'NotReady');
    chain.advanceTime(61);
    await tl.send('execute', [add.opId]);
    assert.equal(await oracle.call('isReporter', [ACCOUNTS.bob]), true);
    const rm = await scheduled(tl, oracle.address, call('removeReporter', [ACCOUNTS.bob]));
    chain.advanceTime(7 * DAY + 1);
    await tl.send('execute', [rm.opId]);
    assert.equal(await oracle.call('isReporter', [ACCOUNTS.bob]), false);
  });

  test('unknown keys and selectors of the oracle are still refused: no price setter, no unpause, no field the papers do not name', async () => {
    const { tl, params } = ctx;
    for (const name of ['reporterSet', 'arkReferencePriceBps', 'pauseMaxEpoch', 'breakerBps', 'ringSize', 'observation']) {
      await expectRevert(tl.send('schedule', [params.address, diff([[name, 1, 2]])]), 'UnknownKey');
    }
    for (const payload of [
      call('submit', [1, 0, ACCOUNTS.bob, ONE, key('venues')]),
      call('submitYield', [1, 0, ACCOUNTS.bob, 300]),
      call('setReporterQuorum', [3]),
      call('unpause'),
    ]) {
      await expectRevert(tl.send('schedule', [params.address, payload]), 'UnknownSelector');
    }
  });
});

describe('Leg B objects to the oracle\'s value-transfer operations at S1', () => {
  test('arkReferencePrice and a pause renewal are objectable and contested at the threshold; a 14-day key and a reporter change are not', async () => {
    const { tl, params, oracle, source, chain } = await s1();
    await source.send('set', [ACCOUNTS.alice, epochOf(chain), 10_000n]);
    await source.send('set', [ACCOUNTS.bob, epochOf(chain), 30_000n]);
    const price = await scheduled(tl, params.address, diff([['arkReferencePrice', 4n * ONE, 5n * ONE]]));
    const renew = await scheduled(tl, oracle.address, call('pause'));
    chain.advanceTime(6 * DAY);
    for (const op of [price, renew]) {
      assert.equal((await tl.call('objectionOf', [op.opId]))[0], true);
      // 10,000 of 40,000 principal is 2,500 bps, over the 2,000 threshold.
      await tl.send('object', [op.opId], { from: ACCOUNTS.alice });
      const [, contested] = await tl.call('objectionOf', [op.opId]);
      assert.equal(contested, true);
    }
    // Contested: not executed at its delay; a second delay from the close of the objection.
    chain.advanceTime(DAY + 1);
    await expectRevert(tl.send('execute', [renew.opId]), 'NotReady');
    assert.equal(await tl.call('etaOf', [renew.opId]), BigInt(chain.timestamp) - BigInt(DAY + 1) + BigInt(7 * DAY));
    chain.advanceTime(23 * DAY);
    await expectRevert(tl.send('execute', [price.opId]), 'NotReady');
    await tl.send('cancel', [price.opId], { from: GUARDIAN });

    const quorum = await scheduled(tl, params.address, diff([['reporterQuorum', 3, 4]]));
    const pauseMax = await scheduled(tl, params.address, diff([['pauseMaxEpochs', 2, 4]]));
    const reporter = await scheduled(tl, oracle.address, call('addReporter', [ACCOUNTS.mallory]));
    for (const op of [quorum, pauseMax, reporter]) {
      await expectRevert(tl.send('object', [op.opId], { from: ACCOUNTS.bob }), 'OpNotObjectable');
    }
  });
});

describe('the guardian pause (yellow paper §6.1; technical reference §1.4, §3.7)', () => {
  test('the guardian pauses directly, once; only a timelock operation renews a pause in force, seven days after it is scheduled', async () => {
    const { tl, oracle, chain } = await s1({ pauseMaxEpochs: 2 });
    // Neither the proposer nor a stranger pauses; the timelock cannot pause what is not paused.
    await expectRevert(oracle.send('pause', [], { from: PROPOSER }), 'NotGuardian');
    await expectRevert(oracle.send('pause', [], { from: ACCOUNTS.mallory }), 'NotGuardian');
    const early = await scheduled(tl, oracle.address, call('pause'));
    chain.advanceTime(7 * DAY + 1);
    await expectRevert(tl.send('execute', [early.opId]), 'CallFailed');

    await oracle.send('pause', [], { from: GUARDIAN });
    const until = await oracle.call('pausedUntil');
    assert.equal(until - BigInt(chain.timestamp), BigInt(2 * WEEK), 'pauseMaxEpochs epochs');
    // The guardian alone cannot extend its own pause.
    await expectRevert(oracle.send('pause', [], { from: GUARDIAN }), 'PauseInForce');
    // The guardian cannot schedule the renewal: it only cancels.
    await expectRevert(tl.send('schedule', [oracle.address, call('pause')], { from: GUARDIAN }), 'NotProposer');

    // A renewal scheduled in the first week of a two-epoch pause executes while it is in force.
    chain.advanceTime(DAY);
    const renew = await scheduled(tl, oracle.address, call('pause'));
    assert.equal(renew.delay, BigInt(7 * DAY));
    chain.advanceTime(7 * DAY + 1);
    assert.equal(await oracle.call('paused'), true);
    await tl.send('execute', [renew.opId]);
    assert.equal((await oracle.call('pausedUntil')) - BigInt(chain.timestamp), BigInt(2 * WEEK));
  });

  test('a pause that lapses first is not renewed, and the guardian may cancel a queued renewal', async () => {
    const { tl, oracle, chain } = await s1({ pauseMaxEpochs: 1 });
    await oracle.send('pause', [], { from: GUARDIAN });
    const late = await scheduled(tl, oracle.address, call('pause'));
    chain.advanceTime(7 * DAY + 1);
    assert.equal(await oracle.call('paused'), false);
    await expectRevert(tl.send('execute', [late.opId]), 'CallFailed');

    await oracle.send('pause', [], { from: GUARDIAN });
    const renew = await scheduled(tl, oracle.address, call('pause'));
    await tl.send('cancel', [renew.opId], { from: GUARDIAN });
    await expectRevert(tl.send('execute', [renew.opId]), 'OpNotQueued');
  });

  test('from S3 there is no pause: renounceGuardian ends it, and a renewal finds nothing to renew', async () => {
    const { tl, oracle, chain } = await s1();
    const s3 = await scheduled(tl, tl.address, tl.iface.encodeFunctionData('renounceGuardian', []));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [s3.opId]);
    await expectRevert(oracle.send('pause', [], { from: GUARDIAN }), 'NoPause');
    const renew = await scheduled(tl, oracle.address, call('pause'));
    chain.advanceTime(7 * DAY + 1);
    await expectRevert(tl.send('execute', [renew.opId]), 'CallFailed');
  });
});

describe('the governor proposes the oracle\'s operations under the kinds the papers name', () => {
  let g;
  beforeEach(async () => {
    g = await deployGovernance();
  });

  test('keys under StakingParameter: the delay is the longest key, arkReferencePrice flags the proposal value transfer', async () => {
    const quorum = await propose(g, KIND.StakingParameter, [[g.params.address, diff([['reporterQuorum', 3, 4]])]]);
    let p = await g.gov.call('proposalOf', [quorum]);
    assert.deepEqual([p.delay, p.valueTransfer], [BigInt(14 * DAY), false]);
    const price = await propose(g, KIND.StakingParameter, [[g.params.address, diff([['arkReferencePrice', 4n * ONE, 5n * ONE]])]]);
    p = await g.gov.call('proposalOf', [price]);
    assert.deepEqual([p.delay, p.valueTransfer], [BigInt(30 * DAY), true]);
    await expectRevert(
      propose(g, KIND.StakingParameter, [[g.params.address, diff([['arkReferencePrice', 4n * ONE, 6n * ONE]])]]),
      'StepTooLarge',
    );
  });

  test('reporters under AttesterSetChange at 7 days, and under no other kind', async () => {
    const id = await propose(g, KIND.AttesterSetChange, [[g.params.address, call('addReporter', [ACCOUNTS.bob])]]);
    const p = await g.gov.call('proposalOf', [id]);
    assert.deepEqual([p.delay, p.valueTransfer], [BigInt(7 * DAY), false]);
    await propose(g, KIND.AttesterSetChange, [[g.params.address, call('removeReporter', [ACCOUNTS.bob])]]);
    for (const kind of [KIND.StakingParameter, KIND.StakingValidatorBatch, KIND.RenounceAdmin]) {
      await expectRevert(propose(g, kind, [[g.params.address, call('addReporter', [ACCOUNTS.bob])]]), 'SelectorNotAllowed');
    }
  });

  test('the pause renewal under StakingParameter at 7 days, value transfer, and under no other kind', async () => {
    const id = await propose(g, KIND.StakingParameter, [[g.params.address, call('pause')]]);
    const p = await g.gov.call('proposalOf', [id]);
    assert.deepEqual([p.delay, p.valueTransfer], [BigInt(7 * DAY), true]);
    for (const kind of [KIND.AttesterSetChange, KIND.StakingThreatStage, KIND.RenounceAdmin]) {
      await expectRevert(propose(g, kind, [[g.params.address, call('pause')]]), 'SelectorNotAllowed');
    }
  });
});
