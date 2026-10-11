/**
 * ArkPhase: the ecosystem phase of `QuantumArk-Phases.md` §2-3 (2026-10-07).
 *
 * The read rule (Q-Day override, stored 4 beats the declaration), the three
 * transitions and their refusals, the next-boundary schedule and its history,
 * `phaseAt` at the declaration boundary, the epoch clock, governance and its
 * handover, and the contract driven through a real ArkTimelock. The timelock
 * rows are tested in `ArkTimelock.test.js`, the governor kinds in
 * `GovernanceSpec.test.js`.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { expectRevert } = require('./fixtures');
const { Chain, ACCOUNTS } = require('./harness');

const DAY = 86400;
const WEEK = 7 * DAY;
const GOV = ACCOUNTS.admin;
const ZERO = '0x' + '00'.repeat(20);
const EVIDENCE = '0x' + 'ab'.repeat(32);

async function fixture(len = WEEK) {
  const chain = await Chain.create();
  const q = await chain.deploy('QDayStateDouble');
  const ph = await chain.deploy('ArkPhase', ['address', 'address', 'uint256'], [q.address, GOV, len]);
  return { chain, q, ph, len: BigInt(len) };
}

/** The decoded arguments of the custom error a reverted call carried. */
async function revertArgs(ph, promise, name) {
  const e = await expectRevert(promise, name);
  return [...ph.iface.parseError(e.data).args];
}

describe('ArkPhase', () => {
  let chain;
  let q;
  let ph;
  let len;

  beforeEach(async () => {
    ({ chain, q, ph, len } = await fixture());
  });

  const epoch = () => chain.timestamp / len;
  /** Moves to `offset` seconds past the next boundary. */
  const toNextEpoch = (offset = 60n) => chain.advanceTime(Number((epoch() + 1n) * len - chain.timestamp + offset));
  const setPhase = (from, to, opts = { from: GOV }) => ph.send('setPhase', [from, to], opts);
  const enterQDay = (from, opts = { from: GOV }) => ph.send('enterQDay', [from], opts);
  const restore = (h = EVIDENCE, opts = { from: GOV }) => ph.send('restore', [h], opts);
  const pending = async () => [...(await ph.call('pendingPhase'))];

  async function stepTo(target) {
    for (let p = Number(await ph.call('storedPhase')); p !== target; p += target > p ? 1 : -1) {
      await setPhase(p, target > p ? p + 1 : p - 1);
      toNextEpoch();
    }
  }

  describe('deployment and reads', () => {
    test('starts at phase 0 from epoch 0, nothing pending; the getters name what was deployed', async () => {
      assert.equal(await ph.call('phase'), 0n);
      assert.equal(await ph.call('storedPhase'), 0n);
      assert.equal(await ph.call('phaseEnteredEpoch'), 0n);
      assert.deepEqual(await pending(), [0n, 0n]);
      assert.equal(await ph.call('phaseAt', [0]), 0n);
      assert.equal(await ph.call('phaseAt', [epoch()]), 0n);
      assert.equal(await ph.call('epochLength'), BigInt(WEEK));
      assert.equal((await ph.call('qdayOracle')).toLowerCase(), q.address.toLowerCase());
      assert.equal((await ph.call('governance')).toLowerCase(), GOV.toLowerCase());
      assert.equal(await ph.call('pendingGovernance'), ZERO);
    });

    test('the constructor refuses a zero oracle, a zero governance and a zero epoch length', async () => {
      for (const args of [[ZERO, GOV, WEEK], [q.address, ZERO, WEEK], [q.address, GOV, 0]]) {
        await assert.rejects(chain.deploy('ArkPhase', ['address', 'address', 'uint256'], args), /deploy ArkPhase failed/);
      }
    });

    test('the epoch is block.timestamp / epochLength, from the Unix epoch, as ArkEpoch.current()', async () => {
      for (const l of [WEEK, 7 * 600, 7 * 60]) {
        const f = await fixture(l);
        assert.equal(await f.ph.call('currentEpoch'), f.chain.timestamp / BigInt(l));
        // Exactly on a boundary the new epoch has begun; one second before it has not.
        const next = (f.chain.timestamp / BigInt(l) + 1n) * BigInt(l);
        f.chain.advanceTime(Number(next - f.chain.timestamp - 1n));
        assert.equal(await f.ph.call('currentEpoch'), next / BigInt(l) - 1n);
        f.chain.advanceTime(1);
        assert.equal(await f.ph.call('currentEpoch'), next / BigInt(l));
      }
    });
  });

  describe('setPhase', () => {
    test('one step, effective at the next boundary; the history answers phaseAt either side of it', async () => {
      const c = epoch();
      const res = await setPhase(0, 1);
      const [ev] = ph.events(res, 'PhaseScheduled');
      assert.deepEqual([ev.args.fromPhase, ev.args.toPhase, ev.args.effectiveEpoch], [0n, 1n, c + 1n]);
      assert.equal(await ph.call('phase'), 0n, 'not before the boundary');
      assert.deepEqual(await pending(), [1n, c + 1n]);
      assert.equal(await ph.call('phaseAt', [c + 1n]), 1n, 'a future epoch reads the schedule');

      toNextEpoch();
      assert.equal(await ph.call('phase'), 1n);
      assert.equal(await ph.call('phaseEnteredEpoch'), c + 1n);
      assert.deepEqual(await pending(), [0n, 0n]);
      assert.equal(await ph.call('phaseAt', [c]), 0n);
      assert.equal(await ph.call('phaseAt', [c + 1n]), 1n);
    });

    test('up and down within 0..2: 0 -> 1 -> 2 -> 1 -> 0', async () => {
      for (const [from, to] of [[0, 1], [1, 2], [2, 1], [1, 0]]) {
        await setPhase(from, to);
        toNextEpoch();
        assert.equal(await ph.call('phase'), BigInt(to));
      }
    });

    test('refuses a jump, a non-move, a step to 3 or beyond, and a step out of 3 (PhaseStep)', async () => {
      for (const [from, to] of [[0, 2], [0, 0], [0, 3], [0, 255]]) {
        assert.deepEqual(await revertArgs(ph, setPhase(from, to), 'PhaseStep'), [BigInt(from), BigInt(to)]);
      }
      await stepTo(2);
      await expectRevert(setPhase(2, 3), 'PhaseStep');
      await expectRevert(setPhase(2, 0), 'PhaseStep');
    });

    test('fromPhase must be the stored phase in force (PhaseMismatch), not the one scheduled', async () => {
      assert.deepEqual(await revertArgs(ph, setPhase(1, 2), 'PhaseMismatch'), [0n, 1n]);
      await setPhase(0, 1);
      assert.deepEqual(await revertArgs(ph, setPhase(1, 2), 'PhaseMismatch'), [0n, 1n], 'the scheduled 1 is not in force yet');
    });

    test('at most one transition per epoch (PhaseAlreadyStepped), also after an enterQDay', async () => {
      const c = epoch();
      await setPhase(0, 1);
      assert.deepEqual(await revertArgs(ph, setPhase(0, 1), 'PhaseAlreadyStepped'), [c]);
      toNextEpoch();
      await setPhase(1, 0);
      toNextEpoch();
      await enterQDay(0);
      await expectRevert(setPhase(0, 1), 'PhaseAlreadyStepped');
    });

    test('governance only', async () => {
      assert.deepEqual(
        (await revertArgs(ph, setPhase(0, 1, { from: ACCOUNTS.mallory }), 'OnlyGovernance')).map(String).map((s) => s.toLowerCase()),
        [ACCOUNTS.mallory],
      );
      await expectRevert(enterQDay(0, { from: ACCOUNTS.mallory }), 'OnlyGovernance');
      await expectRevert(restore(EVIDENCE, { from: ACCOUNTS.mallory }), 'OnlyGovernance');
      await expectRevert(ph.send('proposeGovernance', [ACCOUNTS.mallory], { from: ACCOUNTS.mallory }), 'OnlyGovernance');
    });
  });

  describe('enterQDay', () => {
    test('from any stored phase below 3 straight to 3 at the next boundary; events name the step', async () => {
      await stepTo(1);
      const c = epoch();
      const res = await enterQDay(1);
      const [e] = ph.events(res, 'QDayEntered');
      assert.deepEqual([e.args.fromPhase, e.args.effectiveEpoch], [1n, c + 1n]);
      const [s] = ph.events(res, 'PhaseScheduled');
      assert.deepEqual([s.args.fromPhase, s.args.toPhase, s.args.effectiveEpoch], [1n, 3n, c + 1n]);
      assert.equal(await ph.call('phase'), 1n);
      toNextEpoch();
      assert.equal(await ph.call('phase'), 3n);
      assert.equal(await ph.call('phaseEnteredEpoch'), c + 1n);
    });

    test('defensive only: it writes nothing to the oracle, so no payout reading declared() opens', async () => {
      await enterQDay(0);
      toNextEpoch();
      assert.equal(await ph.call('phase'), 3n);
      assert.equal(await q.call('declared'), false);
      assert.equal(await q.call('declaredAt'), 0n);
    });

    test('refuses a stale fromPhase, a pending transition, and a phase in force of 3 or 4', async () => {
      assert.deepEqual(await revertArgs(ph, enterQDay(1), 'PhaseMismatch'), [0n, 1n]);
      const c = epoch();
      await setPhase(0, 1);
      assert.deepEqual(await revertArgs(ph, enterQDay(0), 'PhasePending'), [1n, c + 1n]);
      toNextEpoch();
      await enterQDay(1);
      await expectRevert(enterQDay(1), 'PhasePending');
      toNextEpoch();
      assert.deepEqual(await revertArgs(ph, enterQDay(3), 'PhaseLocked'), [3n]);
      await restore();
      toNextEpoch();
      assert.deepEqual(await revertArgs(ph, enterQDay(4), 'PhaseLocked'), [4n]);
    });
  });

  describe('no way back from Q-Day', () => {
    test('stored 3: setPhase to 0, 1 or 2 reverts (PhaseLocked)', async () => {
      await enterQDay(0);
      toNextEpoch();
      for (const to of [0, 1, 2]) assert.deepEqual(await revertArgs(ph, setPhase(3, to), 'PhaseLocked'), [3n]);
      await expectRevert(setPhase(0, 1), 'PhaseLocked');
    });

    test('declared by the oracle: every reader is lifted to 3 at once, from any phase, and setPhase reverts', async () => {
      await stepTo(1);
      await q.send('declare', [chain.timestamp]);
      assert.equal(await ph.call('phase'), 3n, 'no transaction to ArkPhase needed');
      assert.equal(await ph.call('storedPhase'), 1n);
      for (const [from, to] of [[1, 0], [1, 2]]) assert.deepEqual(await revertArgs(ph, setPhase(from, to), 'PhaseLocked'), [3n]);
      assert.deepEqual(await revertArgs(ph, enterQDay(1), 'PhaseLocked'), [3n]);
    });
  });

  describe('phaseAt at the declaration boundary', () => {
    test('declared mid-epoch: phase() reads 3 at once, phaseAt keeps that epoch stored and reads 3 from the next', async () => {
      await stepTo(2);
      const c = epoch();
      await q.send('declare', [chain.timestamp]);
      assert.equal(await ph.call('phase'), 3n);
      assert.equal(await ph.call('phaseAt', [c]), 2n, 'the declaration came after the boundary opening c');
      assert.equal(await ph.call('phaseAt', [c + 1n]), 3n);
      assert.equal(await ph.call('phaseAt', [c - 1n]), 1n, 'the past is not rewritten');
      assert.equal(await ph.call('phaseEnteredEpoch'), c + 1n, 'the first boundary at which phaseAt reads 3');
      toNextEpoch();
      assert.equal(await ph.call('phaseAt', [epoch()]), 3n);
      assert.equal(await ph.call('phaseEnteredEpoch'), c + 1n);
    });

    test('declared exactly at a boundary: that epoch already reads 3; one second later it does not', async () => {
      const e = epoch() + 5n;
      await q.send('declare', [e * len]);
      assert.equal(await ph.call('phaseAt', [e]), 3n, 'declaredAt == epoch start counts');
      assert.equal(await ph.call('phaseAt', [e - 1n]), 0n);
      const f = await fixture();
      await f.q.send('declare', [e * len + 1n]);
      assert.equal(await f.ph.call('phaseAt', [e]), 0n, 'declaredAt one second past the start does not');
      assert.equal(await f.ph.call('phaseAt', [e + 1n]), 3n);
    });

    test('a stored 3 needs no declaration; phaseAt reads it from its effective epoch', async () => {
      const c = epoch();
      await enterQDay(0);
      assert.equal(await ph.call('phaseAt', [c]), 0n);
      assert.equal(await ph.call('phaseAt', [c + 1n]), 3n);
    });
  });

  describe('restore', () => {
    test('from a declared Q-Day: 3 -> 4 at the next boundary, evidence emitted; stored 4 beats declared()', async () => {
      await stepTo(1);
      await q.send('declare', [chain.timestamp]);
      toNextEpoch();
      const c = epoch();
      assert.equal(await ph.call('phase'), 3n);
      const res = await restore();
      const [r] = ph.events(res, 'Restored');
      assert.deepEqual([r.args.evidenceHash, r.args.effectiveEpoch], [EVIDENCE, c + 1n]);
      const [s] = ph.events(res, 'PhaseScheduled');
      assert.deepEqual([s.args.fromPhase, s.args.toPhase], [3n, 4n]);
      assert.equal(await ph.call('phase'), 3n);
      toNextEpoch();
      assert.equal(await q.call('declared'), true, 'the declaration stays true for good');
      assert.equal(await ph.call('phase'), 4n, 'and does not pull Restoration back to 3');
      assert.equal(await ph.call('phaseAt', [c]), 3n);
      assert.equal(await ph.call('phaseAt', [c + 1n]), 4n);
      assert.equal(await ph.call('phaseEnteredEpoch'), c + 1n);
    });

    test('from a stored 3 without a declaration', async () => {
      await enterQDay(0);
      toNextEpoch();
      await restore();
      toNextEpoch();
      assert.equal(await ph.call('phase'), 4n);
    });

    test('one-way: no 4 -> 3 and no 4 -> 0..2 in v1', async () => {
      await enterQDay(0);
      toNextEpoch();
      await restore();
      toNextEpoch();
      assert.deepEqual(await revertArgs(ph, restore(), 'NotQDay'), [4n]);
      await expectRevert(enterQDay(4), 'PhaseLocked');
      for (const to of [0, 1, 2, 3]) await expectRevert(setPhase(4, to), 'PhaseLocked');
      await q.send('declare', [chain.timestamp]);
      assert.equal(await ph.call('phase'), 4n);
    });

    test('refuses outside Q-Day, a zero evidence hash, and a second call in the epoch', async () => {
      assert.deepEqual(await revertArgs(ph, restore(), 'NotQDay'), [0n]);
      await enterQDay(0);
      await expectRevert(restore(), 'NotQDay', 'the scheduled 3 is not in force yet');
      toNextEpoch();
      await expectRevert(restore('0x' + '00'.repeat(32)), 'EvidenceRequired');
      const c = epoch();
      await restore();
      assert.deepEqual(await revertArgs(ph, restore(), 'PhasePending'), [4n, c + 1n]);
    });

    test('a declaration in the epoch of a scheduled setPhase: restore waits for it (PhasePending)', async () => {
      await setPhase(0, 1);
      await q.send('declare', [chain.timestamp]);
      await expectRevert(restore(), 'PhasePending');
      toNextEpoch();
      assert.equal(await ph.call('storedPhase'), 1n);
      assert.equal(await ph.call('phase'), 3n);
      await restore();
      toNextEpoch();
      assert.equal(await ph.call('phase'), 4n);
    });
  });

  test('the history is exact for every epoch, old and new', async () => {
    const at = [];
    for (const [from, to] of [[0, 1], [1, 2], [2, 1], [1, 2]]) {
      at.push([epoch(), BigInt(from)]);
      await setPhase(from, to);
      toNextEpoch();
      toNextEpoch();
    }
    const e = epoch();
    await enterQDay(2);
    toNextEpoch();
    at.push([e + 1n, 3n]);
    for (const [ep, p] of at) assert.equal(await ph.call('phaseAt', [ep]), p, `epoch ${ep}`);
    assert.equal(await ph.call('phaseAt', [0]), 0n);
    assert.equal(await ph.call('phaseAt', [e]), 2n);
    assert.equal(await ph.call('phaseAt', [e + 100n]), 3n);
  });

  describe('governance handover', () => {
    test('two steps: propose, then only the proposed account accepts', async () => {
      const res = await ph.send('proposeGovernance', [ACCOUNTS.bob], { from: GOV });
      assert.equal(ph.events(res, 'GovernanceProposed').length, 1);
      assert.equal((await ph.call('pendingGovernance')).toLowerCase(), ACCOUNTS.bob);
      await expectRevert(ph.send('acceptGovernance', [], { from: ACCOUNTS.mallory }), 'NotPendingGovernance');
      const acc = await ph.send('acceptGovernance', [], { from: ACCOUNTS.bob });
      const [t] = ph.events(acc, 'GovernanceTransferred');
      assert.deepEqual([t.args.previous.toLowerCase(), t.args.next.toLowerCase()], [GOV, ACCOUNTS.bob]);
      assert.equal((await ph.call('governance')).toLowerCase(), ACCOUNTS.bob);
      assert.equal(await ph.call('pendingGovernance'), ZERO);
      await expectRevert(setPhase(0, 1), 'OnlyGovernance');
      await setPhase(0, 1, { from: ACCOUNTS.bob });
    });

    test('a zero proposal withdraws one', async () => {
      await ph.send('proposeGovernance', [ACCOUNTS.bob], { from: GOV });
      await ph.send('proposeGovernance', [ZERO], { from: GOV });
      await expectRevert(ph.send('acceptGovernance', [], { from: ACCOUNTS.bob }), 'NotPendingGovernance');
    });
  });
});

describe('ArkPhase under ArkTimelock (S1)', () => {
  test('the deployer hands it to the timelock at once (acceptGovernanceOf); every transition then runs through the table', async () => {
    const chain = await Chain.create();
    const q = await chain.deploy('QDayStateDouble');
    const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [ACCOUNTS.admin, ACCOUNTS.guardian]);
    const ph = await chain.deploy('ArkPhase', ['address', 'address', 'uint256'], [q.address, ACCOUNTS.oracle, WEEK]);
    await ph.send('proposeGovernance', [tl.address], { from: ACCOUNTS.oracle });
    await tl.send('acceptGovernanceOf', [ph.address], { from: ACCOUNTS.mallory });
    assert.equal((await ph.call('governance')).toLowerCase(), tl.address.toLowerCase());
    await expectRevert(ph.send('setPhase', [0, 1], { from: ACCOUNTS.oracle }), 'OnlyGovernance');

    const sched = async (fn, args) => {
      const res = await tl.send('schedule', [ph.address, ph.iface.encodeFunctionData(fn, args)], { from: ACCOUNTS.admin });
      return tl.events(res, 'Scheduled')[0].args;
    };
    const len = BigInt(WEEK);
    const toNextEpoch = () => chain.advanceTime(Number((chain.timestamp / len + 1n) * len - chain.timestamp + 60n));

    const up = await sched('setPhase', [0, 1]);
    assert.equal(up.delay, BigInt(30 * DAY));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [up.opId]);
    assert.equal(await ph.call('phase'), 0n);
    toNextEpoch();
    assert.equal(await ph.call('phase'), 1n);

    const qd = await sched('enterQDay', [1]);
    assert.equal(qd.delay, BigInt(48 * 3600));
    chain.advanceTime(48 * 3600 + 1);
    await tl.send('execute', [qd.opId]);
    toNextEpoch();
    assert.equal(await ph.call('phase'), 3n);

    const back = await sched('setPhase', [1, 0]);
    chain.advanceTime(30 * DAY + 1);
    await expectRevert(tl.send('execute', [back.opId]), 'CallFailed');
    await tl.send('cancel', [back.opId], { from: ACCOUNTS.guardian });

    const rs = await sched('restore', [EVIDENCE]);
    assert.equal(rs.delay, BigInt(30 * DAY));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [rs.opId]);
    toNextEpoch();
    assert.equal(await ph.call('phase'), 4n);
  });
});
