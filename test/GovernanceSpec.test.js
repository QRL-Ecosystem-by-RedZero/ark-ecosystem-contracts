/**
 * Governance invariants G1 - G15 (ArkGovernance-Design.md §8), one test per code,
 * against the whole stack at stage S2, plus the mechanics §11 asks to be tested
 * directly: override in both orders, pin across delegation changes, the late-flip
 * extension, compare-and-swap with two parallel proposals, the Leg B chamber,
 * and the property Σ power(d, s) <= W_global(s) over random operations.
 *
 * G1, G2, G8 and G9 are enforced on the target side by Ark Staking; here they are
 * tested against `ParamsDouble`, which models that target. The staking
 * repository owns the real target's tests.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { expectRevert } = require('./fixtures');
const {
  Chain,
  deployArkToken,
  ACCOUNTS,
  DAY,
  WEEK,
  MAX_LOCK,
  ONE,
  KIND,
  STATE,
  VOTE,
  VOTERS,
  TREASURY,
  ATTESTERS,
  key,
  diff,
  stage,
  addr,
  toNextEpoch,
  epochOf,
  deployGovernance,
  propose,
  openRoundFor,
  vote,
  endVoting,
} = require('./gov-fixture');

const L = BigInt(MAX_LOCK);

async function queued(ctx, id) {
  const res = await ctx.gov.send('queue', [id]);
  return ctx.gov.events(res, 'ProposalQueued')[0].args.opIds;
}

/** Proposes, votes For with `voters`, ends the vote and queues. Returns [id, opIds]. */
async function pass(ctx, kind, actions, voters = [VOTERS.big]) {
  const id = await propose(ctx, kind, actions);
  await openRoundFor(ctx, id);
  for (const v of voters) await vote(ctx, id, v, VOTE.For);
  await endVoting(ctx, id);
  return [id, await queued(ctx, id)];
}

/** Funds `who`, locks `amount` ARK for `weeks` and delegates it to `to` when given. */
async function lockFor(ctx, who, weeks, to = null, amount = 100n * ONE) {
  await ctx.ark.send('transfer', [who, amount], { from: ACCOUNTS.alice });
  await ctx.ark.send('approve', [ctx.ve.address, 10n ** 30n], { from: who });
  await ctx.ve.send('createLock', [amount, ctx.chain.timestamp + BigInt(weeks * WEEK)], { from: who });
  if (to) await ctx.ve.send('delegate', [to], { from: who });
  ctx.chain.mine();
  return who;
}

/** H of a round proposal with a 14-day action: latest vote end + delay + one epoch. */
async function roundHorizon(ctx, id) {
  const { round } = await ctx.gov.call('proposalOf', [id]);
  const { openedAt } = await ctx.gov.call('roundOf', [round]);
  // Vote, late extension, QUEUE_GRACE, the 14-day delay, the timelock's GRACE_PERIOD (GV-02), one epoch.
  return openedAt + BigInt(5 * DAY + DAY + 14 * DAY + 14 * DAY + 14 * DAY + WEEK);
}

async function certify(ctx, n = 5) {
  await ctx.qday.send('raiseAdvisory', [key('artefact')], { from: ATTESTERS[0] });
  for (let i = 1; i < n; i++) await ctx.qday.send('certify', [], { from: ATTESTERS[i] });
}

describe('Governance invariants G1 - G15', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await deployGovernance();
  });

  test('G1: no vote executes a value outside its range; a value-transfer key moves at most a quarter of it', async () => {
    // D7, checked when the proposal is made (the timelock's table, via delayFor).
    await expectRevert(propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['indemnityBps', 10000, 8000]])]]), 'StepTooLarge');
    // In-step but out of the target's range: the vote passes and the target refuses.
    const [, ops] = await pass(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 5001]])]]);
    ctx.chain.advanceTime(14 * DAY + 1);
    await expectRevert(ctx.tl.send('execute', [ops[0]]), 'CallFailed');
    assert.equal(await ctx.params.call('valueOf', [key('maxAssetShareBps')]), 250n);
  });

  test('G2: every setter call goes through the timelock with at least the table delay; no bypass role', async () => {
    await expectRevert(ctx.params.send('setParamsDiff', [[{ key: key('maxAssetShareBps'), expected: 250, value: 300 }]], { from: VOTERS.big }), 'OnlyGovernance');
    const [, ops] = await pass(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    const eta = await ctx.tl.call('etaOf', [ops[0]]);
    assert.equal(eta - ctx.chain.timestamp, BigInt(14 * DAY));
    ctx.chain.advanceTime(14 * DAY - 10);
    await expectRevert(ctx.tl.send('execute', [ops[0]]), 'NotReady');
    // The former S1 proposer has no path left either.
    await expectRevert(ctx.tl.send('schedule', [ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]), 'NotProposer');
  });

  test('G3: weight created after the snapshot is not counted', async () => {
    const id = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await openRoundFor(ctx, id);
    const late = addr(0xd1);
    await ctx.ark.send('transfer', [late, 500_000n * ONE], { from: ACCOUNTS.alice });
    await ctx.ark.send('approve', [ctx.ve.address, 10n ** 30n], { from: late });
    await ctx.ve.send('createLock', [500_000n * ONE, ctx.chain.timestamp + BigInt(MAX_LOCK)], { from: late });
    ctx.chain.mine();
    await expectRevert(ctx.gov.send('castVote', [id, VOTE.For], { from: late }), 'NoWeight');
  });

  test('G4: Σ power(d, s) <= W_global(s) at the round snapshot', async () => {
    const id = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await openRoundFor(ctx, id);
    const { round } = await ctx.gov.call('proposalOf', [id]);
    const { snapshot } = await ctx.gov.call('roundOf', [round]);
    const total = await ctx.ve.call('totalWeightAt', [snapshot]);
    let sum = 0n;
    for (const v of Object.values(VOTERS)) sum += await ctx.ve.call('votingPowerAt', [v, snapshot]);
    assert.ok(sum <= total && total - sum < 5n, `${sum} <= ${total}`);
  });

  test('G5: each unit of weight is counted at most once, whichever of delegator and delegatee votes first', async () => {
    const tallies = [];
    for (const order of [
      [VOTERS.mid, VOTERS.tiny],
      [VOTERS.tiny, VOTERS.mid],
    ]) {
      const c = await deployGovernance({ wire: false });
      const id = await propose(c, KIND.StakingParameter, [[c.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
      await openRoundFor(c, id);
      for (const v of order) await vote(c, id, v, v === VOTERS.mid ? VOTE.For : VOTE.Against);
      tallies.push(await c.gov.call('tallyOf', [id]));
      const { round } = await c.gov.call('proposalOf', [id]);
      const { snapshot } = await c.gov.call('roundOf', [round]);
      const midPower = await c.ve.call('votingPowerAt', [VOTERS.mid, snapshot]);
      const tinyOwn = await c.ve.call('weightAt', [VOTERS.tiny, snapshot]);
      const t = tallies[tallies.length - 1];
      assert.equal(t.againstVotes, tinyOwn, 'the delegator votes its own weight');
      assert.equal(t.forVotes + t.againstVotes, midPower, 'and the two together count the delegatee power once');
    }
    assert.deepEqual([...tallies[0]], [...tallies[1]]);
  });

  test('G6: weight used in a vote cannot be withdrawn before H, and changing delegatee does not shed the pin', async () => {
    const shorty = await lockFor(ctx, addr(0xd2), 3);
    const leaver = await lockFor(ctx, addr(0xd3), 3, VOTERS.mid);

    const id = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await openRoundFor(ctx, id);
    // Leaves mid after the snapshot and before mid votes with power(mid, s).
    await ctx.ve.send('delegate', [leaver], { from: leaver });
    await vote(ctx, id, shorty, VOTE.For);
    await vote(ctx, id, VOTERS.mid, VOTE.For);

    const H = await roundHorizon(ctx, id);
    assert.equal(await ctx.ve.call('pinOf', [shorty]), H);
    assert.equal(await ctx.ve.call('pinOf', [VOTERS.tiny]), H, 'a delegator is held by its delegatee vote');
    assert.equal(await ctx.ve.call('pinOf', [leaver]), H, 'and so is one that left after the snapshot');

    await ctx.ve.send('delegate', [VOTERS.small], { from: VOTERS.tiny });
    assert.equal(await ctx.ve.call('pinOf', [VOTERS.tiny]), H, 're-delegating carries the pin');

    ctx.chain.advanceTime(Number(H - ctx.chain.timestamp) - 60);
    await expectRevert(ctx.ve.send('withdraw', [], { from: shorty }), 'VotePinned');
    await expectRevert(ctx.ve.send('withdraw', [], { from: leaver }), 'VotePinned');
    ctx.chain.advanceTime(120);
    await ctx.ve.send('withdraw', [], { from: shorty });
    await ctx.ve.send('withdraw', [], { from: leaver });
  });

  test('G7: governance starts no payout — Q-Day needs a 5-of-9 certification, the court step only upholds or retries', async () => {
    await expectRevert(ctx.gov.send('proposeQDayRatification', []), 'NotCertified');
    await certify(ctx, 4);
    await expectRevert(ctx.gov.send('proposeQDayRatification', []), 'NotCertified');
    await expectRevert(ctx.qday.send('resolve', [1, true], { from: VOTERS.big }), 'OnlyGovernor');

    const caseId = key('case-1');
    await expectRevert(ctx.gov.send('proposeCourtEscalation', [caseId]), 'NotEscalated');
    await ctx.court.send('escalate', [caseId]);
    const res = await ctx.gov.send('proposeCourtEscalation', [caseId]);
    const id = ctx.gov.events(res, 'OffRoundProposalCreated')[0].args.id;
    ctx.chain.mine();
    await vote(ctx, id, VOTERS.small, VOTE.For); // 7% < 10% quorum
    ctx.chain.advanceTime(5 * DAY + 1);
    await ctx.gov.send('resolve', [id]);
    assert.equal(await ctx.court.call('outcome', [caseId]), 1n, 'no quorum upholds the appeal verdict');
  });

  test('OC-COURT-03: no court vote is opened that would end after the court lapses the escalation', async () => {
    const caseId = key('case-lapse');
    await ctx.court.send('escalate', [caseId]); // lapses 14 days on
    // Ten days in, a five-day vote would end a day after the lapse: refused.
    ctx.chain.advanceTime(10 * DAY);
    await expectRevert(ctx.gov.send('proposeCourtEscalation', [caseId]), 'EscalationLapsing');
    // With the vote ending exactly at the lapse, it is opened.
    const lapse = BigInt(await ctx.court.call('escalationLapsesAt', [caseId]));
    await ctx.court.send('setLapse', [caseId, lapse + BigInt(DAY)]);
    const res = await ctx.gov.send('proposeCourtEscalation', [caseId]);
    assert.equal(ctx.gov.events(res, 'OffRoundProposalCreated').length, 1);
  });

  test('G8: a proposal of epoch r is voted in round r+1 and a diff takes effect at the next epoch boundary', async () => {
    const e = epochOf(ctx.chain);
    const id = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    const { round } = await ctx.gov.call('proposalOf', [id]);
    assert.equal(round, e + 1n);
    await expectRevert(ctx.gov.send('castVote', [id, VOTE.For], { from: VOTERS.big }), 'WrongState');
    await openRoundFor(ctx, id);
    await vote(ctx, id, VOTERS.big, VOTE.For);
    await endVoting(ctx, id);
    const [op] = await queued(ctx, id);
    ctx.chain.advanceTime(14 * DAY + 1);
    await ctx.tl.send('execute', [op]);
    assert.equal(await ctx.params.call('valueOf', [key('maxAssetShareBps')]), 250n, 'not mid-epoch');
    toNextEpoch(ctx.chain);
    assert.equal(await ctx.params.call('valueOf', [key('maxAssetShareBps')]), 300n);
    assert.equal(await ctx.gov.call('state', [id]), STATE.Executed);
  });

  test('G9: one step per proposal, one live stage proposal, and the ladder takes 30 days like the stage', async () => {
    await expectRevert(propose(ctx, KIND.StakingThreatStage, [[ctx.params.address, stage(1, 3)]]), 'StageStepInvalid');
    const id = await propose(ctx, KIND.StakingThreatStage, [[ctx.params.address, stage(1, 2)]]);
    await expectRevert(propose(ctx, KIND.StakingThreatStage, [[ctx.params.address, stage(1, 2)]]), 'StageProposalLive');
    assert.equal(await ctx.tl.call('delayFor', [diff([['threatStage1Bps', 1850, 1900]])]), BigInt(30 * DAY));

    await openRoundFor(ctx, id);
    await vote(ctx, id, VOTERS.big, VOTE.For);
    await endVoting(ctx, id);
    const [op] = await queued(ctx, id);
    await expectRevert(propose(ctx, KIND.StakingThreatStage, [[ctx.params.address, stage(2, 3)]]), 'StageProposalLive');
    ctx.chain.advanceTime(30 * DAY + 1);
    await ctx.tl.send('execute', [op]);
    assert.equal(await ctx.params.call('threatStage'), 2n);
    // Executed frees the slot; a stale `fromStage` is refused by the target.
    const again = await propose(ctx, KIND.StakingThreatStage, [[ctx.params.address, stage(1, 2)]]);
    await openRoundFor(ctx, again);
    await vote(ctx, again, VOTERS.big, VOTE.For);
    await endVoting(ctx, again);
    const [op2] = await queued(ctx, again);
    ctx.chain.advanceTime(30 * DAY + 1);
    await expectRevert(ctx.tl.send('execute', [op2]), 'CallFailed');
  });

  describe('G10: Q-Day is ratified only by support >= Q_min and > opposition (OC-GOV-11)', () => {
    async function open() {
      await certify(ctx);
      const res = await ctx.gov.send('proposeQDayRatification', []);
      const id = ctx.gov.events(res, 'OffRoundProposalCreated')[0].args.id;
      ctx.chain.mine();
      return id;
    }

    async function settle(id) {
      ctx.chain.advanceTime(48 * 3600 + 1);
      await ctx.gov.send('resolve', [id]);
      return ctx.qday.call('declared');
    }

    async function ratify(votes) {
      const id = await open();
      for (const [v, s] of votes) await vote(ctx, id, v, s);
      return settle(id);
    }

    test('no votes at all: rejected; the freeze lifts, the raiser cools down, the attesters may certify again', async () => {
      assert.equal(await ratify([]), false);
      assert.equal(await ctx.qday.call('frozen'), false);
      assert.ok((await ctx.qday.call('cooldownUntil', [ATTESTERS[0]])) > ctx.chain.timestamp);
      await expectRevert(ctx.qday.send('raiseAdvisory', [key('artefact')], { from: ATTESTERS[0] }), 'OnCooldown');
      // Another attester opens a new round; that round is ratified on its own vote.
      await ctx.qday.send('raiseAdvisory', [key('artefact-2')], { from: ATTESTERS[1] });
      for (let i = 2; i < 6; i++) await ctx.qday.send('certify', [], { from: ATTESTERS[i] });
      const res = await ctx.gov.send('proposeQDayRatification', []);
      const id = ctx.gov.events(res, 'OffRoundProposalCreated')[0].args.id;
      ctx.chain.mine();
      await vote(ctx, id, VOTERS.big, VOTE.For);
      assert.equal(await settle(id), true);
    });

    test('for below Q_min, no opposition: rejected', async () => {
      // tiny votes in person (~2% of W, overriding its delegatee): below 5%.
      assert.equal(await ratify([[VOTERS.tiny, VOTE.For]]), false);
    });

    test('for >= Q_min and > against: ratified', async () => {
      assert.equal(await ratify([[VOTERS.small, VOTE.For], [VOTERS.tiny, VOTE.Against]]), true);
      assert.ok((await ctx.qday.call('declaredAt')) > 0n);
    });

    test('for >= Q_min against a material opposition: the larger side decides', async () => {
      assert.equal(await ratify([[VOTERS.big, VOTE.For], [VOTERS.mid, VOTE.Against]]), true);
    });

    test('a tie above Q_min: rejected', async () => {
      const a = await lockFor(ctx, addr(0xd7), Math.floor(MAX_LOCK / WEEK), null, 100_000n * ONE);
      const b = await lockFor(ctx, addr(0xd8), Math.floor(MAX_LOCK / WEEK), null, 100_000n * ONE);
      const id = await open();
      await vote(ctx, id, a, VOTE.For);
      await vote(ctx, id, b, VOTE.Against);
      const { forVotes, againstVotes } = await ctx.gov.call('tallyOf', [id]);
      assert.equal(forVotes, againstVotes, 'equal locks in the same week weigh the same');
      assert.equal(await settle(id), false);
    });

    test('opposition alone, nobody for: rejected', async () => {
      assert.equal(await ratify([[VOTERS.dust, VOTE.Against]]), false);
    });

    test('abstentions do not count toward Q_min', async () => {
      assert.equal(await ratify([[VOTERS.tiny, VOTE.For], [VOTERS.big, VOTE.Abstain]]), false);
    });

    test("Q_min is the governor's immutable (reference 500 bps); the track stores no quorum", async () => {
      assert.equal(await ctx.gov.call('qdayQuorumBps'), 500n);
      const { quorumBps, approvalBps, track } = await ctx.rules.call('ruleOf', [KIND.StakingQDayRatification]);
      assert.equal(quorumBps, 0n);
      assert.equal(approvalBps, 0n);
      assert.equal(track, await ctx.rules.call('TRACK_QDAY'));
    });
  });

  describe('G10: the Q-Day rule as a table, and its monotonicity', () => {
    const Q_MIN = 500;
    const W = 10_000n;
    /** The rule of design §6.6 as decided on 2026-10-09, stated independently of the contract. */
    const expected = (f, a, w) => f > a && f * 10_000n >= BigInt(Q_MIN) * w;
    const passes = (f, a, w) => ctx.rules.call('qdayPasses', [Q_MIN, f, a, w]);

    test('table: each row of design §6.6', async () => {
      for (const [f, a, w, want] of [
        [0n, 0n, 0n, false], // empty veARK
        [0n, 0n, W, false], // nobody votes
        [0n, 1n, W, false], // opposition alone
        [499n, 0n, W, false], // support below Q_min, no opposition
        [500n, 0n, W, true], // support at Q_min
        [500n, 499n, W, true],
        [500n, 500n, W, false], // a tie is a rejection
        [3_000n, 3_000n, W, false], // a tie above Q_min too
        [3_000n, 249n, W, true], // dust opposition never blocks a supported ratification
        [100n, 0n, W, false], // the old rule ratified this (no opposition)
        [5_000n, 5_001n, W, false],
      ]) {
        assert.equal(await passes(f, a, w), want, `for ${f}, against ${a}, W ${w}`);
        assert.equal(expected(f, a, w), want);
      }
    });

    test('the GOV-11 counterexample: for 7%, against 2.6%, then a supporter adds 0.5% against', async () => {
      // Under the turnout-quorum rule the first tally was rejected and the second ratified: a vote
      // against turned a rejection around. Q_min counts support only, so that cannot happen.
      assert.equal(await passes(700n, 260n, W), true);
      assert.equal(await passes(700n, 310n, W), true);
      // Opposition or abstention never lifts support below Q_min over the line.
      assert.equal(await passes(450n, 0n, W), false);
      // And a vote against can no longer help: pile it on until it reaches the support.
      assert.equal(await passes(700n, 700n, W), false);
    });

    test('monotone over random tallies: more for never fails a pass, more against never passes a fail', async () => {
      let seed = 0x6011;
      const rnd = (n) => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return BigInt(seed % n);
      };
      let passed = 0;
      for (let i = 0; i < 150; i++) {
        const w = 1n + rnd(1_000_000);
        const f = rnd(Number(w / 5n) + 1);
        const a = rnd(Number(w / 10n) + 1);
        const d = 1n + rnd(Number(w / 20n) + 1);
        const base = await passes(f, a, w);
        const moreFor = await passes(f + d, a, w);
        const moreAgainst = await passes(f, a + d, w);
        assert.equal(base, expected(f, a, w), `rule at for ${f}, against ${a}, W ${w}`);
        if (base) assert.equal(moreFor, true, `for +${d} failed a pass at ${f}/${a}/${w}`);
        else assert.equal(moreAgainst, false, `against +${d} passed a fail at ${f}/${a}/${w}`);
        if (base) passed++;
      }
      assert.ok(passed > 20 && passed < 130, `both outcomes sampled (${passed} of 150 passed)`);
    });
  });

  test('G11: protocol-owned ARK has no veARK weight', async () => {
    await ctx.ark.send('transfer', [TREASURY, ONE], { from: ACCOUNTS.alice });
    await ctx.ark.send('approve', [ctx.ve.address, ONE], { from: TREASURY });
    await expectRevert(ctx.ve.send('createLock', [ONE, ctx.chain.timestamp + BigInt(MAX_LOCK)], { from: TREASURY }), 'ProtocolOwned');
  });

  test('G12: constants and escrow have no governance path', async () => {
    for (const name of ['unbondingDays', 'epochDays', 'censorshipWindowEpochs', 'couponCliffDays', 'vestingDays', 'breakerBps']) {
      await expectRevert(propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([[name, 1, 2]])]]), 'UnknownKey');
    }
    const escrowCall = '0x' + key('setAuthority(bytes32)').slice(2, 10) + '00'.repeat(32);
    await expectRevert(propose(ctx, KIND.StakingParameter, [[ctx.params.address, escrowCall]]), 'SelectorNotAllowed');
  });

  test('G13: the court case stays open through the whole governance step', async () => {
    const caseId = key('case-2');
    await ctx.court.send('escalate', [caseId]);
    const res = await ctx.gov.send('proposeCourtEscalation', [caseId]);
    const id = ctx.gov.events(res, 'OffRoundProposalCreated')[0].args.id;
    ctx.chain.mine();
    await vote(ctx, id, VOTERS.big, VOTE.For);
    ctx.chain.advanceTime(5 * DAY - 60);
    await expectRevert(ctx.gov.send('resolve', [id]), 'VotingOpen');
    assert.equal(await ctx.court.call('caseOpen', [caseId]), true);
    ctx.chain.advanceTime(120);
    await ctx.gov.send('resolve', [id]);
    assert.equal(await ctx.court.call('outcome', [caseId]), 2n, '10% / 66% orders a retrial');
    assert.equal(await ctx.court.call('caseOpen', [caseId]), true, 'a retrial keeps the case, and its stake, open');
  });

  test('G14: the guardian only cancels Queued operations; off-round tracks never queue', async () => {
    const [id, ops] = await pass(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await expectRevert(ctx.tl.send('schedule', [ctx.params.address, diff([['maxAssetShareBps', 250, 300]])], { from: ACCOUNTS.guardian }), 'NotProposer');
    await expectRevert(ctx.gov.send('cancel', [id], { from: ACCOUNTS.guardian }), 'NotProposer');
    await ctx.tl.send('cancel', [ops[0]], { from: ACCOUNTS.guardian });
    assert.equal(await ctx.gov.call('state', [id]), STATE.Cancelled);

    await certify(ctx);
    const res = await ctx.gov.send('proposeQDayRatification', []);
    const q = ctx.gov.events(res, 'OffRoundProposalCreated')[0].args.id;
    assert.deepEqual([...(await ctx.gov.call('opsOf', [q]))], [], 'nothing for the guardian to cancel');
  });

  test('G15: handover and guardian removal are one-way; RenounceAdmin needs its own kind', async () => {
    const renounce = ctx.tl.iface.encodeFunctionData('renounceGuardian', []);
    await expectRevert(propose(ctx, KIND.StakingParameter, [[ctx.tl.address, renounce]]), 'SelectorNotAllowed');
    const [id, ops] = await pass(ctx, KIND.RenounceAdmin, [[ctx.tl.address, renounce]]);
    ctx.chain.advanceTime(30 * DAY + 1);
    await ctx.tl.send('execute', [ops[0]]);
    assert.equal(await ctx.tl.call('guardian'), '0x' + '00'.repeat(20));
    assert.equal(await ctx.gov.call('state', [id]), STATE.Executed);
    await expectRevert(ctx.tl.send('handOver', [ACCOUNTS.admin], { from: ACCOUNTS.admin }), 'NotProposer');
  });
});

describe('Leaving a delegatee while a vote window is open (G6, GOV-10)', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await deployGovernance();
  });

  const plainStep = () => [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]];

  test('a delegator that leaves after the snapshot is pinned by its old delegatee later vote', async () => {
    const leaver = await lockFor(ctx, addr(0xd4), 3, VOTERS.mid);
    const id = await propose(ctx, KIND.StakingParameter, plainStep());
    await openRoundFor(ctx, id);
    const H = await roundHorizon(ctx, id);

    await ctx.ve.send('delegate', [VOTERS.small], { from: leaver });
    assert.equal(await ctx.ve.call('pinOf', [leaver]), H, 'held before the delegatee has voted');

    const { round } = await ctx.gov.call('proposalOf', [id]);
    const { snapshot } = await ctx.gov.call('roundOf', [round]);
    assert.equal((await ctx.ve.call('delegateeAt', [leaver, snapshot])).toLowerCase(), VOTERS.mid);
    const cast = await vote(ctx, id, VOTERS.mid, VOTE.For);
    assert.equal(cast.weight, await ctx.ve.call('votingPowerAt', [VOTERS.mid, snapshot]), 'the vote uses the leaver weight');
    assert.equal(await ctx.ve.call('pinOf', [leaver]), H);
    assert.equal(await ctx.ve.call('pinOf', [VOTERS.mid]), H);
  });

  test('leaving and then withdrawing is refused until the horizon, though the delegatee never votes', async () => {
    const leaver = await lockFor(ctx, addr(0xd5), 3, VOTERS.mid);
    const id = await propose(ctx, KIND.StakingParameter, plainStep());
    await openRoundFor(ctx, id);
    const H = await roundHorizon(ctx, id);
    const [voteEnd, until] = await ctx.ve.call('delegatedHold');
    assert.equal(until, H);
    assert.equal(voteEnd, H - BigInt(14 * DAY + 14 * DAY + 14 * DAY + WEEK), 'open through the latest possible vote end (GV-02: both graces in H)');

    await ctx.ve.send('delegate', [leaver], { from: leaver });
    await endVoting(ctx, id);
    ctx.chain.advanceTime(Number(H - ctx.chain.timestamp) - 60);
    assert.ok((await ctx.ve.call('lockOf', [leaver])).end < ctx.chain.timestamp, 'the lock itself has matured');
    await expectRevert(ctx.ve.send('withdraw', [], { from: leaver }), 'VotePinned');
    ctx.chain.advanceTime(120);
    await ctx.ve.send('withdraw', [], { from: leaver });
  });

  test('with no window open, leaving a delegatee adds no pin', async () => {
    const leaver = await lockFor(ctx, addr(0xd6), 3, VOTERS.mid);
    const id = await propose(ctx, KIND.StakingParameter, plainStep());

    await ctx.ve.send('delegate', [leaver], { from: leaver }); // before the round opens
    assert.equal(await ctx.ve.call('pinOf', [leaver]), 0n);
    await ctx.ve.send('delegate', [VOTERS.mid], { from: leaver });

    await openRoundFor(ctx, id);
    const [voteEnd] = await ctx.ve.call('delegatedHold');
    ctx.chain.advanceTime(Number(voteEnd - ctx.chain.timestamp) + 1); // window over, mid never voted
    assert.equal(await ctx.ve.call('pinOf', [leaver]), 0n);
    await ctx.ve.send('delegate', [leaver], { from: leaver });
    assert.equal(await ctx.ve.call('pinOf', [leaver]), 0n);

    const { end } = await ctx.ve.call('lockOf', [leaver]);
    if (end >= ctx.chain.timestamp) ctx.chain.advanceTime(Number(end - ctx.chain.timestamp) + 1);
    await ctx.ve.send('withdraw', [], { from: leaver });
  });

  test('an off-round track holds delegated locks, and one that leaves keeps the hold', async () => {
    const stays = await lockFor(ctx, addr(0xd7), 2, VOTERS.mid);
    const leaver = await lockFor(ctx, addr(0xd8), 2, VOTERS.mid);
    const { end } = await ctx.ve.call('lockOf', [leaver]);
    ctx.chain.advanceTime(Number(end - ctx.chain.timestamp) - DAY);

    const caseId = key('case-gov10');
    await ctx.court.send('escalate', [caseId]);
    const res = await ctx.gov.send('proposeCourtEscalation', [caseId]);
    const id = ctx.gov.events(res, 'OffRoundProposalCreated')[0].args.id;
    const voteEnd = await ctx.gov.call('voteEndOf', [id]);
    const H = voteEnd + BigInt(WEEK);
    ctx.chain.advanceTime(2 * DAY); // both locks have matured; nobody has voted

    await expectRevert(ctx.ve.send('withdraw', [], { from: stays }), 'VotePinned');
    await ctx.ve.send('delegate', [leaver], { from: leaver });
    assert.equal(await ctx.ve.call('pinOf', [leaver]), H);

    ctx.chain.advanceTime(Number(voteEnd - ctx.chain.timestamp) + 1);
    await ctx.ve.send('withdraw', [], { from: stays }); // mid never voted: nothing left to answer for
    await expectRevert(ctx.ve.send('withdraw', [], { from: leaver }), 'VotePinned');
    ctx.chain.advanceTime(Number(H - ctx.chain.timestamp) + 1);
    await ctx.ve.send('withdraw', [], { from: leaver });
  });
});

describe('Governor mechanics', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await deployGovernance();
  });

  test('quorum, approval and abstain: abstain counts toward quorum only', async () => {
    const id = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await openRoundFor(ctx, id);
    await vote(ctx, id, VOTERS.small, VOTE.For); // 7% alone: below quorum
    await endVoting(ctx, id);
    assert.equal(await ctx.gov.call('state', [id]), STATE.Defeated);

    const b = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await openRoundFor(ctx, b);
    await vote(ctx, b, VOTERS.small, VOTE.For);
    await vote(ctx, b, VOTERS.mid, VOTE.Abstain); // turnout past quorum, approval 100%
    await endVoting(ctx, b);
    assert.equal(await ctx.gov.call('state', [b]), STATE.Succeeded);
  });

  test('a late flip extends the vote by 24 hours, once', async () => {
    const id = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await openRoundFor(ctx, id);
    await vote(ctx, id, VOTERS.small, VOTE.For); // failing: no quorum
    const end = await ctx.gov.call('voteEndOf', [id]);
    ctx.chain.advanceTime(Number(end - ctx.chain.timestamp) - 3600);
    await vote(ctx, id, VOTERS.mid, VOTE.For); // flips to passing
    assert.equal(await ctx.gov.call('voteEndOf', [id]), end + BigInt(DAY));
    ctx.chain.advanceTime(2 * 3600);
    await vote(ctx, id, VOTERS.big, VOTE.Against); // flips back: no second extension
    assert.equal(await ctx.gov.call('voteEndOf', [id]), end + BigInt(DAY));
    await endVoting(ctx, id);
    assert.equal(await ctx.gov.call('state', [id]), STATE.Defeated);
  });

  test('one queued operation per key: of two parallel proposals on one key, the second is refused at queueing (KeyPending, SWAPGOV-04); disjoint keys both land', async () => {
    const a = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    const b = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 400]])]]);
    const c = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['releaseBoundBps', 2500, 2000]])]]);
    await openRoundFor(ctx, a);
    for (const id of [a, b, c]) await vote(ctx, id, VOTERS.big, VOTE.For);
    await endVoting(ctx, a);
    const [opA] = await queued(ctx, a);
    await expectRevert(queued(ctx, b), 'KeyPending');
    const [opC] = await queued(ctx, c);
    ctx.chain.advanceTime(14 * DAY + 1);
    await ctx.tl.send('execute', [opA]);
    await ctx.tl.send('execute', [opC]);
    toNextEpoch(ctx.chain);
    assert.equal(await ctx.params.call('valueOf', [key('maxAssetShareBps')]), 300n);
    assert.equal(await ctx.params.call('valueOf', [key('releaseBoundBps')]), 2000n);
  });

  describe('Leg B objection chamber (D6)', () => {
    async function queuedValueTransfer() {
      const [id, ops] = await pass(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['indemnityBps', 10000, 9000]])]]);
      const e = epochOf(ctx.chain);
      await ctx.source.send('set', [VOTERS.small, e, 300n]);
      await ctx.source.send('set', [VOTERS.dust, e, 100n]);
      await ctx.source.send('set', [ACCOUNTS.bob, e, 600n]);
      return [id, ops];
    }

    test('objection below the threshold leaves the proposal queued; only value-transfer proposals are objectable', async () => {
      const [id] = await queuedValueTransfer();
      await ctx.gov.send('object', [id], { from: VOTERS.dust });
      assert.equal(await ctx.gov.call('state', [id]), STATE.Queued);
      await expectRevert(ctx.gov.send('object', [id], { from: VOTERS.dust }), 'AlreadyObjected');
      await expectRevert(ctx.gov.send('object', [id], { from: VOTERS.mid }), 'NoPrincipal');

      const [plain] = await pass(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
      await expectRevert(ctx.gov.send('object', [plain], { from: VOTERS.small }), 'NotObjectable');
    });

    test('20% of principal contests it: operations cancelled, re-voted once at 15% / 75%', async () => {
      const [id, ops] = await queuedValueTransfer();
      await ctx.gov.send('object', [id], { from: VOTERS.small });
      assert.equal(await ctx.gov.call('state', [id]), STATE.Contested);
      assert.equal(await ctx.tl.call('stateOf', [ops[0]]), 3n, 'the timelock operation is cancelled');

      await openRoundFor(ctx, id);
      await vote(ctx, id, VOTERS.mid, VOTE.For);
      await vote(ctx, id, VOTERS.small, VOTE.Against);
      await endVoting(ctx, id);
      // 73.7% approval: enough for 66%, not for the contested 75%.
      assert.equal(await ctx.gov.call('state', [id]), STATE.Defeated);
    });

    test('a contested proposal can still pass the stricter re-vote, and cannot be contested twice', async () => {
      const [id] = await queuedValueTransfer();
      await ctx.gov.send('object', [id], { from: VOTERS.small });
      await openRoundFor(ctx, id);
      await vote(ctx, id, VOTERS.big, VOTE.For);
      await endVoting(ctx, id);
      await queued(ctx, id);
      await expectRevert(ctx.gov.send('object', [id], { from: ACCOUNTS.bob }), 'NotObjectable');
    });

    test('from S2 a round-2 key (bufferRampThresholdBps) is value-transfer for the governor: 30 days, objectable here, not in the timelock', async () => {
      const [id, ops] = await pass(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['bufferRampThresholdBps', 1000, 1375]])]]);
      assert.equal((await ctx.gov.call('proposalOf', [id])).valueTransfer, true);
      assert.equal((await ctx.tl.call('etaOf', [ops[0]])) - ctx.chain.timestamp, BigInt(30 * DAY));
      await expectRevert(
        propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['bufferRampThresholdBps', 1000, 1376]])]]),
        'StepTooLarge',
      );
      const e = epochOf(ctx.chain);
      await ctx.source.send('set', [VOTERS.small, e, 300n]);
      await ctx.source.send('set', [ACCOUNTS.bob, e, 700n]);
      // Queued by the governor after the handover: the timelock's S1 chamber does not cover it.
      assert.equal((await ctx.tl.call('objectionOf', [ops[0]]))[0], false);
      assert.equal(await ctx.tl.call('handedOver'), true);
      await ctx.gov.send('object', [id], { from: VOTERS.small });
      assert.equal(await ctx.gov.call('state', [id]), STATE.Contested);
    });
  });

  test('QIP kinds: 5,000 ARK deposit instead of weight, voted after the 7-day audit, refunded when final', async () => {
    const payload = ctx.params.iface.encodeFunctionData('delistAsset', [key('asset')]);
    const before = await ctx.ark.call('balanceOf', [ACCOUNTS.alice]);
    const id = await propose(ctx, KIND.StakingDelisting, [[ctx.params.address, payload]], ACCOUNTS.alice);
    assert.equal(before - (await ctx.ark.call('balanceOf', [ACCOUNTS.alice])), 5000n * ONE);
    const { round } = await ctx.gov.call('proposalOf', [id]);
    assert.equal(round, BigInt(Math.floor((Number(ctx.chain.timestamp) + 7 * DAY) / WEEK)) + 1n);
    await expectRevert(ctx.gov.send('refundDeposit', [id]), 'DepositNotReleasable');
    await expectRevert(ctx.gov.send('forfeitDeposit', [id, ACCOUNTS.bob]), 'NotTimelock');
    await openRoundFor(ctx, id);
    await endVoting(ctx, id);
    assert.equal(await ctx.gov.call('state', [id]), STATE.Defeated);
    await ctx.gov.send('refundDeposit', [id]);
    assert.equal(await ctx.ark.call('balanceOf', [ACCOUNTS.alice]), before);
  });

  test('proposal threshold, kind/selector binding and tracks', async () => {
    const d = diff([['maxAssetShareBps', 250, 300]]);
    await expectRevert(propose(ctx, KIND.StakingParameter, [[ctx.params.address, d]], VOTERS.dust), 'BelowProposalThreshold');
    await expectRevert(propose(ctx, KIND.StakingThreatStage, [[ctx.params.address, d]]), 'SelectorNotAllowed');
    await expectRevert(propose(ctx, KIND.StakingQDayRatification, [[ctx.params.address, d]]), 'WrongTrack');
    await expectRevert(propose(ctx, 0, [[ctx.params.address, d]]), 'SelectorNotAllowed');
    const vt = diff([['indemnityBps', 10000, 9000]]);
    await expectRevert(propose(ctx, KIND.StakingParameter, [[ctx.params.address, vt], [ctx.params.address, d]]), 'BadActions');
  });

  test('a round opens once per epoch, and a round nobody opens lapses', async () => {
    const id = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    await openRoundFor(ctx, id);
    await expectRevert(ctx.gov.send('openRound', []), 'RoundAlreadyOpen');
    const late = await propose(ctx, KIND.StakingParameter, [[ctx.params.address, diff([['maxAssetShareBps', 250, 300]])]]);
    toNextEpoch(ctx.chain);
    toNextEpoch(ctx.chain);
    assert.equal(await ctx.gov.call('state', [late]), STATE.Expired);
  });

  test('a validator batch carries several payable actions, each with its operator bond', async () => {
    const iface = ctx.params.iface;
    const actions = [1, 2].map((i) => [
      ctx.params.address,
      iface.encodeFunctionData('admitValidator', ['0x0' + i, key(`r${i}`), key(`e${i}`), ACCOUNTS.bob]),
      BigInt(i) * ONE,
    ]);
    const [id, ops] = await pass(ctx, KIND.StakingValidatorBatch, actions);
    assert.equal(ops.length, 2);
    ctx.chain.advanceTime(7 * DAY + 1);
    await ctx.tl.send('execute', [ops[0]], { value: ONE });
    await ctx.tl.send('execute', [ops[1]], { value: 2n * ONE });
    assert.equal(await ctx.params.call('lastValue'), 2n * ONE);
    assert.equal(await ctx.gov.call('state', [id]), STATE.Executed);
  });
});

describe('G4 property over the in-place veARK: Σ power(d, s) <= W_global(s), exactly as modelled', () => {
  test('random locks, extensions, delegations and withdrawals across many epoch boundaries', async () => {
    const chain = await Chain.create();
    const ark = await deployArkToken(chain);
    const ve = await chain.deploy('VeArk', ['address', 'address[]'], [ark.address, []]);
    const users = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => addr(0xa0 + i));
    for (const u of users) {
      await ark.send('transfer', [u, 1_000_000n * ONE], { from: ACCOUNTS.alice });
      await ark.send('approve', [ve.address, 10n ** 30n], { from: u });
    }
    const floorWeek = (t) => (BigInt(t) / BigInt(WEEK)) * BigInt(WEEK);
    const w = (a, end, t) => (end > t ? a + (3n * a * (end - t)) / L : a);

    let seed = 0x5eed;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const model = new Map();
    let checks = 0;
    const start = chain.timestamp;
    for (let step = 0; step < 140; step++) {
      const u = users[rnd(users.length)];
      const lock = model.get(u);
      const now = chain.timestamp;
      const op = rnd(6);
      if (!lock && op < 4) {
        const amount = BigInt(1 + rnd(1000)) * ONE + BigInt(rnd(997));
        const unlock = now + BigInt(2 * WEEK + rnd(60 * WEEK));
        await ve.send('createLock', [amount, unlock], { from: u });
        model.set(u, { amount, end: floorWeek(unlock), delegatee: u });
      } else if (lock && op === 0 && lock.end > now) {
        const more = BigInt(1 + rnd(50)) * ONE;
        await ve.send('increaseAmount', [more], { from: u });
        lock.amount += more;
      } else if (lock && op === 1) {
        const unlock = now + BigInt(2 * WEEK + rnd(80 * WEEK));
        if (floorWeek(unlock) > lock.end) {
          await ve.send('extendLock', [unlock], { from: u });
          lock.end = floorWeek(unlock);
        }
      } else if (lock && op === 2) {
        const to = users[rnd(users.length)];
        if (to !== lock.delegatee) {
          await ve.send('delegate', [to], { from: u });
          lock.delegatee = to;
        }
      } else if (lock && op === 3 && lock.end <= now) {
        await ve.send('withdraw', [], { from: u });
        model.delete(u);
      } else {
        chain.advanceTime(rnd(3 * WEEK));
      }
      chain.mine();

      if (step % 7 === 6) {
        await ve.send('checkpoint', []);
        const s = chain.blockNumber;
        const t = chain.timestamp;
        chain.mine();
        let A = 0n;
        let B = 0n;
        let C = 0n;
        const parts = new Map();
        for (const [x, l] of model) {
          const wx = w(l.amount, l.end, t);
          assert.equal(await ve.call('weightAt', [x, s]), wx);
          parts.set(l.delegatee, (parts.get(l.delegatee) || 0n) + wx);
          A += l.amount;
          if (l.end > t) {
            B += l.amount * l.end;
            C += l.amount;
          }
        }
        const total = await ve.call('totalWeightAt', [s]);
        assert.equal(total, A + (3n * (B - C * t)) / L, 'W_global is the exact affine value');
        let sum = 0n;
        for (const d of users) {
          const p = await ve.call('votingPowerAt', [d, s]);
          const own = parts.get(d) || 0n;
          assert.ok(p >= own && p - own <= BigInt(model.size));
          sum += p;
        }
        assert.ok(sum <= total && total - sum <= BigInt(users.length), `G4: ${sum} <= ${total}`);
        checks++;
      }
    }
    assert.ok(checks >= 20);
    assert.ok(chain.timestamp - start > BigInt(60 * WEEK), 'crossed many epoch boundaries');
  });
});

/**
 * G9 / G10 and the ecosystem phase (QuantumArk-Phases.md §3, 2026-10-07): the
 * kinds EcosystemPhase (10% / 66%: setPhase, enterQDay) and
 * EcosystemRestoration (20% / 75%: restore), driven against a real ArkPhase
 * governed by the timelock, and the Q-Day rule's independence from it: the
 * oracle's ratified declaration lifts the phase with no phase vote, and the
 * defensive phase vote declares nothing.
 */
describe('G9 / G10: the ecosystem phase kinds (2026-10-07)', () => {
  let ctx;
  let ph;

  beforeEach(async () => {
    ctx = await deployGovernance();
    ph = await ctx.chain.deploy('ArkPhase', ['address', 'address', 'uint256'], [ctx.qday.address, ctx.tl.address, WEEK]);
  });

  const call = (fn, args) => ph.iface.encodeFunctionData(fn, args);
  const EVIDENCE = '0x' + 'cd'.repeat(32);

  test('the rules table: EcosystemPhase 10% / 66% on a round, EcosystemRestoration 20% / 75%; each allows only its selectors', async () => {
    const r15 = await ctx.rules.call('ruleOf', [KIND.EcosystemPhase]);
    const r16 = await ctx.rules.call('ruleOf', [KIND.EcosystemRestoration]);
    const ROUND = await ctx.rules.call('TRACK_ROUND');
    assert.deepEqual([r15.quorumBps, r15.approvalBps, r15.strict, r15.track, r15.deposit, r15.audit], [1000n, 6600n, false, ROUND, false, false]);
    assert.deepEqual([r16.quorumBps, r16.approvalBps, r16.strict, r16.track, r16.deposit, r16.audit], [2000n, 7500n, false, ROUND, false, false]);
    const s = (fn, args) => call(fn, args).slice(0, 10);
    const SET = s('setPhase', [0, 1]);
    const ENTER = s('enterQDay', [0]);
    const RESTORE = s('restore', [EVIDENCE]);
    const allows = (k, x) => ctx.rules.call('allows', [k, x]);
    assert.deepEqual([await allows(15, SET), await allows(15, ENTER), await allows(15, RESTORE)], [true, true, false]);
    assert.deepEqual([await allows(16, SET), await allows(16, ENTER), await allows(16, RESTORE)], [false, false, true]);
    for (const k of [KIND.StakingParameter, KIND.StakingThreatStage, KIND.RenounceAdmin, KIND.AttesterSetChange]) {
      for (const x of [SET, ENTER, RESTORE]) assert.equal(await allows(k, x), false, `kind ${k} ${x}`);
    }
    assert.equal(await allows(15, stage(2, 3).slice(0, 10)), false, 'the in-band stage step keeps its own kind');
  });

  test('G9: a phase proposal carries one checked step, as a value transfer, under its own kind only', async () => {
    await expectRevert(propose(ctx, KIND.StakingThreatStage, [[ph.address, call('setPhase', [0, 1])]]), 'SelectorNotAllowed');
    await expectRevert(propose(ctx, KIND.EcosystemPhase, [[ph.address, call('restore', [EVIDENCE])]]), 'SelectorNotAllowed');
    await expectRevert(propose(ctx, KIND.EcosystemRestoration, [[ph.address, call('setPhase', [0, 1])]]), 'SelectorNotAllowed');
    await expectRevert(propose(ctx, KIND.EcosystemPhase, [[ph.address, call('setPhase', [0, 2])]]), 'StageStepInvalid');
    await expectRevert(propose(ctx, KIND.EcosystemPhase, [[ph.address, call('enterQDay', [3])]]), 'StageStepInvalid');
    await expectRevert(
      propose(ctx, KIND.EcosystemPhase, [[ph.address, call('setPhase', [0, 1])], [ph.address, call('enterQDay', [0])]]),
      'BadActions',
    );

    const [id, ops] = await pass(ctx, KIND.EcosystemPhase, [[ph.address, call('setPhase', [0, 1])]]);
    const p = await ctx.gov.call('proposalOf', [id]);
    assert.deepEqual([p.delay, p.valueTransfer], [BigInt(30 * DAY), true]);
    assert.equal(await ctx.tl.call('stageStepQueued', [], { from: ctx.params.address }), true, 'Ark Staking sees the queued phase step');
    ctx.chain.advanceTime(30 * DAY + 1);
    await ctx.tl.send('execute', [ops[0]]);
    assert.equal(await ctx.tl.call('stageStepQueued', [], { from: ctx.params.address }), false);
    assert.equal(await ph.call('phase'), 0n, 'effective at the next boundary');
    toNextEpoch(ctx.chain);
    assert.equal(await ph.call('phase'), 1n);
  });

  test('G10: the ratified declaration lifts the phase to 3 with no phase vote', async () => {
    await certify(ctx);
    const res = await ctx.gov.send('proposeQDayRatification', []);
    const id = ctx.gov.events(res, 'OffRoundProposalCreated')[0].args.id;
    ctx.chain.mine();
    await vote(ctx, id, VOTERS.big, VOTE.For);
    ctx.chain.advanceTime(48 * 3600 + 1);
    await ctx.gov.send('resolve', [id]);
    assert.equal(await ctx.qday.call('declared'), true);
    assert.equal(await ph.call('phase'), 3n);
    assert.equal(await ph.call('storedPhase'), 0n);
  });

  test('G10: the defensive enterQDay vote moves the phase and declares nothing; restore then needs 20% / 75%', async () => {
    const [, ops] = await pass(ctx, KIND.EcosystemPhase, [[ph.address, call('enterQDay', [0])]]);
    assert.equal(await ctx.tl.call('delayFor', [call('enterQDay', [0])]), BigInt(48 * 3600));
    ctx.chain.advanceTime(48 * 3600 + 1);
    await ctx.tl.send('execute', [ops[0]]);
    toNextEpoch(ctx.chain);
    assert.equal(await ph.call('phase'), 3n);
    assert.equal(await ctx.qday.call('declared'), false, 'no payout reading declared() opens');
    assert.equal(await ctx.qday.call('frozen'), false);

    // ~6.5% of W for, alone: under the 20% quorum of EcosystemRestoration.
    const low = await propose(ctx, KIND.EcosystemRestoration, [[ph.address, call('restore', [EVIDENCE])]]);
    await openRoundFor(ctx, low);
    await vote(ctx, low, VOTERS.small, VOTE.For);
    await endVoting(ctx, low);
    assert.equal(await ctx.gov.call('state', [low]), STATE.Defeated);

    const [id, rops] = await pass(ctx, KIND.EcosystemRestoration, [[ph.address, call('restore', [EVIDENCE])]]);
    assert.equal((await ctx.gov.call('proposalOf', [id])).delay, BigInt(30 * DAY));
    ctx.chain.advanceTime(30 * DAY + 1);
    await ctx.tl.send('execute', [rops[0]]);
    toNextEpoch(ctx.chain);
    assert.equal(await ph.call('phase'), 4n);
  });
});
