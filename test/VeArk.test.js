/**
 * veARK v2: epoch-aligned locks, exact snapshots, overridable delegation,
 * vote pins, protocol-owned exclusion, and the QRL dividend.
 *
 * Spec: ArkGovernance-Design.md §4 in the umbrella repo. Tests that defend a
 * governance invariant carry its code (G3, G4, G6, G11) in the name.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { Chain, ACCOUNTS } = require('./harness');

const DAY = 24 * 60 * 60;
const YEAR = 365 * DAY;
const EPOCH = 7 * DAY;
const MAX_LOCK = 4 * YEAR;
const ONE = 10n ** 18n;
const L = BigInt(MAX_LOCK);
const E = BigInt(EPOCH);

const floorEpoch = (t) => (BigInt(t) / E) * E;

/** w(t) = a + 3a(e - t) / L before expiry, a after. */
const lockWeight = (a, e, t) => (e > t ? a + (3n * a * (e - t)) / L : a);

/** A set is floored once: A + floor(3 Σ a(e - t) / L). */
function setWeight(locks, t) {
  let locked = 0n;
  let remaining = 0n;
  for (const { amount, end } of locks) {
    locked += amount;
    if (end > t) remaining += amount * (end - t);
  }
  return locked + (3n * remaining) / L;
}

const reverts = (name) => (e) => e.reverted && (!name || e.message === name);

async function fixture({ protocolOwned = [ACCOUNTS.guardian] } = {}) {
  const chain = await Chain.create();
  // incentives=alice, treasury=bob, contributors=attester (vesting),
  // backstop=guardian, liquidity=mallory.
  const ark = await chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'uint64'],
    [ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.attester, ACCOUNTS.guardian, ACCOUNTS.mallory, chain.timestamp],
  );
  const ve = await chain.deploy('VeArk', ['address', 'address[]'], [ark.address, protocolOwned]);

  for (const who of [ACCOUNTS.bob, ACCOUNTS.mallory, ACCOUNTS.admin]) {
    await ark.send('transfer', [who, 1_000_000n * ONE], { from: ACCOUNTS.alice });
  }
  for (const who of [ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.mallory, ACCOUNTS.admin, ACCOUNTS.guardian, ACCOUNTS.attester]) {
    await ark.send('approve', [ve.address, 10n ** 30n], { from: who });
  }

  /** Records a snapshot in the current block, then mines past it so it is readable. */
  const snapshot = async () => {
    await ve.send('checkpoint');
    const blk = chain.blockNumber;
    chain.advanceTime(0);
    return blk;
  };
  /** Moves the clock onto the next epoch boundary. */
  const toBoundary = () => chain.advanceTime(Number(E - (chain.timestamp % E)));

  return { chain, ark, ve, snapshot, toBoundary };
}

describe('VeArk', () => {
  describe('epoch-aligned locks and the weight curve', () => {
    let chain;
    let ve;
    let toBoundary;

    before(async () => {
      ({ chain, ve, toBoundary } = await fixture());
    });

    test('the documented bounds are what the contract actually holds', async () => {
      assert.equal(await ve.call('MIN_LOCK'), BigInt(7 * DAY));
      assert.equal(await ve.call('MAX_LOCK'), BigInt(MAX_LOCK));
      assert.equal(await ve.call('EPOCH_LENGTH'), E, 'same clock as ArkEpoch in ark-staking');
      assert.equal(await ve.call('MAX_BOOST_BPS'), 40000n);
      assert.equal(await ve.call('MIN_BOOST_BPS'), 10000n, 'weight floors at 1x, not zero');
    });

    test('the unlock time is rounded down to an epoch boundary', async () => {
      const requested = chain.timestamp + BigInt(YEAR) + 3n * BigInt(DAY);
      await ve.send('createLock', [1000n * ONE, requested], { from: ACCOUNTS.alice });
      const lock = await ve.call('lockOf', [ACCOUNTS.alice]);
      assert.equal(lock.end, floorEpoch(requested));
      assert.equal(lock.end % E, 0n);
      assert.equal((await ve.call('delegateeOf', [ACCOUNTS.alice])).toLowerCase(), ACCOUNTS.alice);
    });

    test('weight is the exact affine curve, not a truncated bps multiplier', async () => {
      const lock = await ve.call('lockOf', [ACCOUNTS.alice]);
      assert.equal(await ve.call('weightOf', [ACCOUNTS.alice]), lockWeight(lock.amount, lock.end, chain.timestamp));
      chain.advanceTime(123_457);
      assert.equal(await ve.call('weightOf', [ACCOUNTS.alice]), lockWeight(lock.amount, lock.end, chain.timestamp));
    });

    test('a full four years from a boundary earns just under 4x, because 4y is not a whole number of epochs', async () => {
      toBoundary();
      await ve.send('createLock', [1000n * ONE, chain.timestamp + L], { from: ACCOUNTS.bob });
      const lock = await ve.call('lockOf', [ACCOUNTS.bob]);
      assert.equal(lock.end - chain.timestamp, 208n * E);
      const w = await ve.call('weightOf', [ACCOUNTS.bob]);
      assert.equal(w, lockWeight(1000n * ONE, lock.end, chain.timestamp));
      assert.ok(w < 4000n * ONE && w > 3990n * ONE, `got ${w}`);
    });

    test('a request that rounds below MIN_LOCK is rejected', async () => {
      toBoundary();
      chain.advanceTime(DAY);
      // now + 7d lands one day into the next epoch, so it rounds down to 6 days.
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(7 * DAY)], { from: ACCOUNTS.mallory }),
        reverts('LockDurationOutOfRange'),
      );
      await ve.send('createLock', [ONE, chain.timestamp + BigInt(13 * DAY)], { from: ACCOUNTS.mallory });
    });

    test('an extension that rounds into the same epoch is not an extension', async () => {
      const lock = await ve.call('lockOf', [ACCOUNTS.alice]);
      await assert.rejects(
        ve.send('extendLock', [lock.end + BigInt(3 * DAY)], { from: ACCOUNTS.alice }),
        reverts('LockCannotShorten'),
      );
      await ve.send('extendLock', [lock.end + E], { from: ACCOUNTS.alice });
      assert.equal((await ve.call('lockOf', [ACCOUNTS.alice])).end, lock.end + E);
    });

    test('weight floors at 1x rather than zero once expired', async () => {
      chain.advanceTime(5 * YEAR);
      assert.equal(await ve.call('boostBpsOf', [ACCOUNTS.bob]), 10000n);
      assert.equal(await ve.call('weightOf', [ACCOUNTS.bob]), 1000n * ONE);
    });
  });

  describe('lock lifecycle', () => {
    let chain;
    let ark;
    let ve;

    before(async () => {
      ({ chain, ark, ve } = await fixture());
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.alice });
    });

    test('a second lock for the same account is rejected', async () => {
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.alice }),
        reverts('LockAlreadyExists'),
      );
    });

    test('a duration outside the permitted band is rejected', async () => {
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(DAY)], { from: ACCOUNTS.bob }),
        reverts('LockDurationOutOfRange'),
      );
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(MAX_LOCK + YEAR)], { from: ACCOUNTS.bob }),
        reverts('LockDurationOutOfRange'),
      );
    });

    test('increasing the amount raises weight without moving the unlock time', async () => {
      const before = await ve.call('lockOf', [ACCOUNTS.alice]);
      await ve.send('increaseAmount', [1000n * ONE], { from: ACCOUNTS.alice });
      const after = await ve.call('lockOf', [ACCOUNTS.alice]);
      assert.equal(after.amount, 2000n * ONE);
      assert.equal(after.end, before.end);
      assert.equal(await ve.call('totalWeight'), await ve.call('weightOf', [ACCOUNTS.alice]));
    });

    test('a lock can never be shortened', async () => {
      const lock = await ve.call('lockOf', [ACCOUNTS.alice]);
      await assert.rejects(
        ve.send('extendLock', [lock.end - E], { from: ACCOUNTS.alice }),
        reverts('LockCannotShorten'),
      );
    });

    test('withdrawal before maturity is impossible at any price', async () => {
      await assert.rejects(ve.send('withdraw', [], { from: ACCOUNTS.alice }), reverts('LockNotExpired'));
    });

    test('a matured lock returns the full principal and leaves no weight behind', async () => {
      const balanceBefore = await ark.call('balanceOf', [ACCOUNTS.alice]);
      chain.advanceTime(YEAR + DAY);
      await ve.send('withdraw', [], { from: ACCOUNTS.alice });
      assert.equal(await ark.call('balanceOf', [ACCOUNTS.alice]), balanceBefore + 2000n * ONE);
      assert.equal(await ve.call('weightOf', [ACCOUNTS.alice]), 0n);
      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.alice]), 0n);
      assert.equal(await ve.call('totalWeight'), 0n);
      assert.equal(await ve.call('delegateeOf', [ACCOUNTS.alice]), '0x' + '00'.repeat(20));
    });

    test('withdrawing twice is rejected', async () => {
      await assert.rejects(ve.send('withdraw', [], { from: ACCOUNTS.alice }), reverts('NoLock'));
    });

    test('an expired lock may be re-armed by extending it', async () => {
      await ve.send('createLock', [ONE, chain.timestamp + BigInt(30 * DAY)], { from: ACCOUNTS.bob });
      chain.advanceTime(60 * DAY);
      assert.equal(await ve.call('weightOf', [ACCOUNTS.bob]), ONE);
      await ve.send('extendLock', [chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.bob });
      const lock = await ve.call('lockOf', [ACCOUNTS.bob]);
      assert.equal(await ve.call('totalWeight'), lockWeight(ONE, lock.end, chain.timestamp));
    });

    test('acting without a lock is rejected on every path', async () => {
      for (const [m, args] of [
        ['increaseAmount', [ONE]],
        ['extendLock', [chain.timestamp + BigInt(YEAR)]],
        ['withdraw', []],
        ['delegate', [ACCOUNTS.bob]],
      ]) {
        await assert.rejects(ve.send(m, args, { from: ACCOUNTS.mallory }), reverts('NoLock'));
      }
    });

    test('a zero-amount lock and a past unlock time are rejected', async () => {
      await assert.rejects(
        ve.send('createLock', [0n, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.mallory }),
        reverts('ZeroValue'),
      );
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp - 1n], { from: ACCOUNTS.mallory }),
        reverts('LockDurationOutOfRange'),
      );
    });

    test('topping up an expired lock is rejected', async () => {
      await ve.send('createLock', [ONE, chain.timestamp + BigInt(30 * DAY)], { from: ACCOUNTS.mallory });
      chain.advanceTime(60 * DAY);
      await assert.rejects(ve.send('increaseAmount', [ONE], { from: ACCOUNTS.mallory }), reverts('LockNotExpired'));
    });
  });

  describe('snapshots (G3)', () => {
    let chain;
    let ve;
    let snapshot;

    before(async () => {
      ({ chain, ve, snapshot } = await fixture());
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(2 * YEAR)], { from: ACCOUNTS.alice });
    });

    test('a block with no recorded checkpoint cannot be read', async () => {
      chain.advanceTime(DAY);
      const blk = chain.blockNumber;
      chain.advanceTime(DAY);
      for (const [m, args] of [
        ['totalWeightAt', [blk]],
        ['weightAt', [ACCOUNTS.alice, blk]],
        ['votingPowerAt', [ACCOUNTS.alice, blk]],
        ['delegateeAt', [ACCOUNTS.alice, blk]],
      ]) {
        await assert.rejects(ve.call(m, args), reverts('SnapshotNotRecorded'), m);
      }
    });

    test('the current block cannot be read', async () => {
      await ve.send('checkpoint');
      await assert.rejects(ve.call('totalWeightAt', [chain.blockNumber]), reverts('FutureLookup'));
    });

    test('a snapshot is frozen: later locks, top-ups and time do not move it', async () => {
      const s = await snapshot();
      const total = await ve.call('totalWeightAt', [s]);
      const alice = await ve.call('weightAt', [ACCOUNTS.alice, s]);
      assert.equal(total, alice);

      chain.advanceTime(3 * DAY);
      await ve.send('createLock', [5000n * ONE, chain.timestamp + BigInt(MAX_LOCK)], { from: ACCOUNTS.bob });
      await ve.send('increaseAmount', [500n * ONE], { from: ACCOUNTS.alice });
      chain.advanceTime(2 * YEAR + DAY);
      await ve.send('withdraw', [], { from: ACCOUNTS.alice });

      assert.equal(await ve.call('totalWeightAt', [s]), total);
      assert.equal(await ve.call('weightAt', [ACCOUNTS.alice, s]), alice);
      assert.equal(await ve.call('weightAt', [ACCOUNTS.bob, s]), 0n, 'weight created after the snapshot never counts');
      assert.equal(await ve.call('votingPowerAt', [ACCOUNTS.bob, s]), 0n);
    });

    test('any block that wrote the global totals is itself a snapshot', async () => {
      await ve.send('createLock', [10n * ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.mallory });
      const blk = chain.blockNumber;
      chain.advanceTime(0);
      assert.equal(await ve.call('totalWeightAt', [blk]), await ve.call('totalWeight'));
    });

    test('a checkpoint after years of silence stays bounded', async () => {
      const idle = await fixture();
      await idle.ve.send('createLock', [ONE, idle.chain.timestamp + BigInt(MAX_LOCK)], { from: ACCOUNTS.alice });
      idle.chain.advanceTime(10 * YEAR);
      const { gasUsed } = await idle.ve.send('checkpoint');
      assert.ok(gasUsed < 1_000_000n, `checkpoint used ${gasUsed}`);
      assert.equal(await idle.ve.call('totalWeight'), ONE);
    });
  });

  describe('exact totals against a model (G3, G4)', () => {
    test('every snapshot matches the model exactly, and stays matched after later writes', async () => {
      const { chain, ve, snapshot } = await fixture({ protocolOwned: [] });
      const who = [ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.mallory, ACCOUNTS.admin];
      const locks = new Map(); // account -> { amount, end, delegatee }

      // Deterministic LCG so a failure reproduces.
      let seed = 0x5eed_c0den;
      const rnd = (n) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return Number((seed >> 33n) % BigInt(n));
      };

      const expected = (t) => {
        const all = [...locks.values()];
        const out = { total: setWeight(all, t), weight: {}, power: {}, delegatee: {} };
        for (const a of who) {
          const l = locks.get(a);
          out.weight[a] = l ? lockWeight(l.amount, l.end, t) : 0n;
          out.delegatee[a] = l ? l.delegatee : null;
          out.power[a] = setWeight(all.filter((x) => x.delegatee === a), t);
        }
        return out;
      };

      const read = async (s) => {
        const out = { total: await ve.call('totalWeightAt', [s]), weight: {}, power: {}, delegatee: {} };
        for (const a of who) {
          out.weight[a] = await ve.call('weightAt', [a, s]);
          out.power[a] = await ve.call('votingPowerAt', [a, s]);
          const d = (await ve.call('delegateeAt', [a, s])).toLowerCase();
          out.delegatee[a] = d === '0x' + '00'.repeat(20) ? null : d;
        }
        return out;
      };

      const history = [];
      for (let step = 0; step < 60; step++) {
        const a = who[rnd(who.length)];
        const l = locks.get(a);
        const now = chain.timestamp;
        const op = rnd(6);

        if (op === 0 && !l) {
          const end = floorEpoch(now + BigInt(8 * DAY + rnd(MAX_LOCK - 8 * DAY)));
          if (end - now >= 7n * BigInt(DAY) && end - now <= L) {
            const amount = BigInt(1 + rnd(1000)) * ONE + BigInt(rnd(1e9));
            await ve.send('createLock', [amount, end], { from: a });
            locks.set(a, { amount, end, delegatee: a });
          }
        } else if (op === 1 && l && l.end > now) {
          const add = BigInt(1 + rnd(500)) * ONE;
          await ve.send('increaseAmount', [add], { from: a });
          l.amount += add;
        } else if (op === 2 && l) {
          const end = floorEpoch(now + BigInt(8 * DAY + rnd(MAX_LOCK - 8 * DAY)));
          if (end > l.end && end - now >= 7n * BigInt(DAY) && end - now <= L) {
            await ve.send('extendLock', [end], { from: a });
            l.end = end;
          }
        } else if (op === 3 && l) {
          const to = who[rnd(who.length)];
          if (to !== l.delegatee) {
            await ve.send('delegate', [to], { from: a });
            l.delegatee = to;
          }
        } else if (op === 4 && l && now >= l.end) {
          await ve.send('withdraw', [], { from: a });
          locks.delete(a);
        } else if (op === 5) {
          // Sometimes jump across many boundaries at once.
          chain.advanceTime(rnd(4) === 0 ? rnd(2 * YEAR) : rnd(40 * DAY));
        }

        const s = await snapshot();
        const want = expected(chain.timestamp);
        const got = await read(s);
        assert.deepEqual(got, want, `step ${step}, snapshot ${s}`);

        // G4: the global total bounds every partition of it, from above.
        const sumPower = who.reduce((acc, x) => acc + got.power[x], 0n);
        const sumWeight = who.reduce((acc, x) => acc + got.weight[x], 0n);
        assert.ok(got.total >= sumPower && sumPower >= sumWeight, `step ${step}`);
        assert.ok(got.total - sumWeight < BigInt(who.length), `step ${step}: slack is sub-wei per lock`);

        history.push([s, want]);
        chain.advanceTime(rnd(3) * DAY);
      }

      // G3: nothing written later rewrote an earlier snapshot.
      for (const [s, want] of history) assert.deepEqual(await read(s), want, `re-read ${s}`);
    });
  });

  describe('delegation', () => {
    let chain;
    let ve;
    let snapshot;
    const ZERO = '0x' + '00'.repeat(20);

    before(async () => {
      ({ chain, ve, snapshot } = await fixture());
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(2 * YEAR)], { from: ACCOUNTS.alice });
      await ve.send('createLock', [3000n * ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.bob });
    });

    test('a new lock votes for its owner', async () => {
      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.alice]), await ve.call('weightOf', [ACCOUNTS.alice]));
    });

    test('delegating moves voting power but not the lock, the jury weight or the dividend', async () => {
      const s0 = await snapshot();
      const aliceWeight = await ve.call('weightOf', [ACCOUNTS.alice]);
      const unitsBefore = await ve.call('unitsOf', [ACCOUNTS.alice]);

      await ve.send('delegate', [ACCOUNTS.bob], { from: ACCOUNTS.alice });
      const s1 = await snapshot();

      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.alice]), 0n);
      // A set is floored once, its members once each: equal up to a wei per lock (G4).
      const lent = [await ve.call('lockOf', [ACCOUNTS.alice]), await ve.call('lockOf', [ACCOUNTS.bob])];
      const bobPower = await ve.call('votingPowerOf', [ACCOUNTS.bob]);
      assert.equal(bobPower, setWeight(lent, chain.timestamp));
      assert.ok(bobPower - (aliceWeight + (await ve.call('weightOf', [ACCOUNTS.bob]))) < 2n);
      assert.equal(await ve.call('weightOf', [ACCOUNTS.alice]), aliceWeight);
      assert.equal(await ve.call('juryWeightOf', [ACCOUNTS.bob]), await ve.call('weightOf', [ACCOUNTS.bob]),
        'a juror is bonded by its own lock, never by weight lent to it');
      assert.equal(await ve.call('unitsOf', [ACCOUNTS.alice]), unitsBefore);

      assert.equal((await ve.call('delegateeAt', [ACCOUNTS.alice, s0])).toLowerCase(), ACCOUNTS.alice);
      assert.equal((await ve.call('delegateeAt', [ACCOUNTS.alice, s1])).toLowerCase(), ACCOUNTS.bob);
      assert.equal(await ve.call('votingPowerAt', [ACCOUNTS.alice, s0]), await ve.call('weightAt', [ACCOUNTS.alice, s0]));
      assert.equal(await ve.call('votingPowerAt', [ACCOUNTS.alice, s1]), 0n);
    });

    test('the override primitive: a delegator can always see its own weight at the snapshot', async () => {
      // The governor subtracts weightAt(alice) from bob's power when alice
      // votes in person. That is only sound if bob's power contains it.
      const s = await snapshot();
      const own = await ve.call('weightAt', [ACCOUNTS.alice, s]);
      const bobPower = await ve.call('votingPowerAt', [ACCOUNTS.bob, s]);
      assert.ok(own > 0n && bobPower >= own + (await ve.call('weightAt', [ACCOUNTS.bob, s])));
    });

    test('delegation is revocable at any time', async () => {
      await ve.send('delegate', [ACCOUNTS.alice], { from: ACCOUNTS.alice });
      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.alice]), await ve.call('weightOf', [ACCOUNTS.alice]));
      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.bob]), await ve.call('weightOf', [ACCOUNTS.bob]));
    });

    test('delegation is one level deep', async () => {
      await ve.send('delegate', [ACCOUNTS.mallory], { from: ACCOUNTS.bob });
      await ve.send('delegate', [ACCOUNTS.bob], { from: ACCOUNTS.alice });
      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.bob]), await ve.call('weightOf', [ACCOUNTS.alice]),
        "alice's weight stops at bob; it does not ride on to mallory");
      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.mallory]), await ve.call('weightOf', [ACCOUNTS.bob]));
    });

    test('pointless and forbidden delegations are rejected', async () => {
      await assert.rejects(ve.send('delegate', [ACCOUNTS.bob], { from: ACCOUNTS.alice }), reverts('AlreadyDelegated'));
      await assert.rejects(ve.send('delegate', [ZERO], { from: ACCOUNTS.alice }), reverts('ZeroAddress'));
      await assert.rejects(ve.send('delegate', [ACCOUNTS.guardian], { from: ACCOUNTS.alice }), reverts('ProtocolOwned'));
    });

    test('power survives expiry at the 1x floor and leaves with the withdrawal', async () => {
      chain.advanceTime(YEAR + DAY);
      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.mallory]), 3000n * ONE);
      await ve.send('withdraw', [], { from: ACCOUNTS.bob });
      assert.equal(await ve.call('votingPowerOf', [ACCOUNTS.mallory]), 0n);
      assert.equal(await ve.call('totalWeight'), await ve.call('weightOf', [ACCOUNTS.alice]));
    });
  });

  describe('vote pin (G6)', () => {
    let chain;
    let ve;

    before(async () => {
      ({ chain, ve } = await fixture());
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(14 * DAY)], { from: ACCOUNTS.alice });
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(14 * DAY)], { from: ACCOUNTS.bob });
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(14 * DAY)], { from: ACCOUNTS.mallory });
    });

    test('only the deployer fixes the governor, once, and never to zero', async () => {
      await assert.rejects(ve.send('setGovernor', [ACCOUNTS.oracle], { from: ACCOUNTS.mallory }), reverts('NotDeployer'));
      await assert.rejects(ve.send('setGovernor', ['0x' + '00'.repeat(20)]), reverts('ZeroAddress'));
      await ve.send('setGovernor', [ACCOUNTS.oracle]);
      assert.equal((await ve.call('governor')).toLowerCase(), ACCOUNTS.oracle);
      await assert.rejects(ve.send('setGovernor', [ACCOUNTS.admin]), reverts('GovernorAlreadySet'));
    });

    test('only the governor may pin', async () => {
      await assert.rejects(
        ve.send('pinUntil', [ACCOUNTS.alice, chain.timestamp + 1n], { from: ACCOUNTS.alice }),
        reverts('NotGovernor'),
      );
    });

    test('a pin only ever rises', async () => {
      const far = chain.timestamp + BigInt(60 * DAY);
      await ve.send('pinUntil', [ACCOUNTS.alice, far], { from: ACCOUNTS.oracle });
      await ve.send('pinUntil', [ACCOUNTS.alice, far - BigInt(30 * DAY)], { from: ACCOUNTS.oracle });
      assert.equal(await ve.call('pinOf', [ACCOUNTS.alice]), far);
    });

    test('a matured lock stays put until the vote it cast can take effect', async () => {
      const weight = await ve.call('weightOf', [ACCOUNTS.alice]);
      chain.advanceTime(20 * DAY);
      await assert.rejects(ve.send('withdraw', [], { from: ACCOUNTS.alice }), reverts('VotePinned'));
      assert.ok((await ve.call('weightOf', [ACCOUNTS.alice])) < weight, 'a pin changes nothing but the exit date');
      chain.advanceTime(40 * DAY);
      await ve.send('withdraw', [], { from: ACCOUNTS.alice });
    });

    test("a delegatee's vote pins every lock delegated to it", async () => {
      await ve.send('delegate', [ACCOUNTS.mallory], { from: ACCOUNTS.bob });
      await ve.send('pinUntil', [ACCOUNTS.mallory, chain.timestamp + BigInt(30 * DAY)], { from: ACCOUNTS.oracle });
      assert.equal(await ve.call('pinOf', [ACCOUNTS.bob]), chain.timestamp + BigInt(30 * DAY));
      await assert.rejects(ve.send('withdraw', [], { from: ACCOUNTS.bob }), reverts('VotePinned'));
    });

    test('switching delegatee does not shake off the pin', async () => {
      const pinned = await ve.call('pinOf', [ACCOUNTS.bob]);
      await ve.send('delegate', [ACCOUNTS.bob], { from: ACCOUNTS.bob });
      assert.equal(await ve.call('pinOf', [ACCOUNTS.bob]), pinned);
      await assert.rejects(ve.send('withdraw', [], { from: ACCOUNTS.bob }), reverts('VotePinned'));
      chain.advanceTime(31 * DAY);
      await ve.send('withdraw', [], { from: ACCOUNTS.bob });
    });
  });

  describe('delegated hold during an open vote window (G6)', () => {
    let chain;
    let ve;
    let t0;

    before(async () => {
      ({ chain, ve } = await fixture());
      await ve.send('setGovernor', [ACCOUNTS.oracle]);
      for (const who of [ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.mallory]) {
        await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(14 * DAY)], { from: who });
      }
      await ve.send('delegate', [ACCOUNTS.mallory], { from: ACCOUNTS.bob });
      t0 = chain.timestamp;
    });

    test('only the governor opens a window', async () => {
      await assert.rejects(
        ve.send('holdDelegated', [t0 + BigInt(DAY), t0 + BigInt(30 * DAY)], { from: ACCOUNTS.bob }),
        reverts('NotGovernor'),
      );
    });

    test('while open, a delegated lock is held; a self-delegated one is not', async () => {
      await ve.send('holdDelegated', [t0 + BigInt(5 * DAY), t0 + BigInt(30 * DAY)], { from: ACCOUNTS.oracle });
      assert.equal(await ve.call('pinOf', [ACCOUNTS.bob]), t0 + BigInt(30 * DAY));
      assert.equal(await ve.call('pinOf', [ACCOUNTS.alice]), 0n);
      assert.equal(await ve.call('pinOf', [ACCOUNTS.mallory]), 0n, 'a delegatee is pinned by its own votes only');
    });

    test('overlapping windows merge and never lower the hold', async () => {
      await ve.send('holdDelegated', [t0 + BigInt(2 * DAY), t0 + BigInt(20 * DAY)], { from: ACCOUNTS.oracle });
      const [end, until] = await ve.call('delegatedHold');
      assert.equal(end, t0 + BigInt(5 * DAY));
      assert.equal(until, t0 + BigInt(30 * DAY));
    });

    test('leaving the delegatee while open keeps the hold as the lock own pin', async () => {
      await ve.send('delegate', [ACCOUNTS.bob], { from: ACCOUNTS.bob });
      await ve.send('delegate', [ACCOUNTS.mallory], { from: ACCOUNTS.alice }); // leaving itself carries nothing
      assert.equal(await ve.call('pinOf', [ACCOUNTS.bob]), t0 + BigInt(30 * DAY));
      assert.equal(await ve.call('pinOf', [ACCOUNTS.alice]), t0 + BigInt(30 * DAY), 'now delegated, inside the window');
      chain.advanceTime(6 * DAY);
      assert.equal(await ve.call('pinOf', [ACCOUNTS.bob]), t0 + BigInt(30 * DAY), 'kept after the window');
      assert.equal(await ve.call('pinOf', [ACCOUNTS.alice]), 0n, 'the hold on a lock that stayed ends with the window');
    });

    test('a window opened after all others closed replaces them', async () => {
      const now = chain.timestamp;
      await ve.send('holdDelegated', [now + BigInt(DAY), now + BigInt(8 * DAY)], { from: ACCOUNTS.oracle });
      const [end, until] = await ve.call('delegatedHold');
      assert.equal(end, now + BigInt(DAY));
      assert.equal(until, now + BigInt(8 * DAY));
      assert.equal(await ve.call('pinOf', [ACCOUNTS.alice]), now + BigInt(8 * DAY));
    });
  });

  describe('protocol-owned ARK (G11) and unvested ARK', () => {
    let chain;
    let ark;
    let ve;

    before(async () => {
      ({ chain, ark, ve } = await fixture());
    });

    test('a protocol address cannot lock, even with unlocked ARK in hand', async () => {
      assert.equal(await ve.call('isProtocolOwned', [ACCOUNTS.guardian]), true);
      assert.ok((await ark.call('balanceOf', [ACCOUNTS.guardian])) > 0n);
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.guardian }),
        reverts('ProtocolOwned'),
      );
    });

    test('a zero address in the protocol list is rejected at deployment', async () => {
      await assert.rejects(
        chain.deploy('VeArk', ['address', 'address[]'], [ark.address, ['0x' + '00'.repeat(20)]]),
      );
    });

    test('unvested ARK cannot be locked, so it can never vote', async () => {
      assert.equal(await ark.call('vestedBalanceOf', [ACCOUNTS.attester]), 0n);
      await assert.rejects(
        ve.send('createLock', [ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.attester }),
        reverts('VotingWeightNotVested'),
      );
    });
  });

  describe('the veARK dividend', () => {
    let chain;
    let ve;

    before(async () => {
      ({ chain, ve } = await fixture());
      // Equal principal, unequal horizon: alice locks four years, bob one.
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(MAX_LOCK)], { from: ACCOUNTS.alice });
      await ve.send('createLock', [1000n * ONE, chain.timestamp + BigInt(YEAR)], { from: ACCOUNTS.bob });
    });

    test('a dividend with no lock outstanding is rejected, not swallowed', async () => {
      const empty = await fixture();
      await assert.rejects(
        empty.ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: ONE }),
        reverts('NoLockedWeight'),
      );
    });

    test('a zero-value dividend is rejected', async () => {
      await assert.rejects(ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 0n }), reverts('ZeroValue'));
    });

    test('the split follows lock weight, not principal', async () => {
      const total = await ve.call('totalUnits');
      const aliceUnits = await ve.call('unitsOf', [ACCOUNTS.alice]);
      const bobUnits = await ve.call('unitsOf', [ACCOUNTS.bob]);
      assert.equal(aliceUnits + bobUnits, total);

      await ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 575n * ONE });

      const aliceDue = await ve.call('pendingDividend', [ACCOUNTS.alice]);
      const bobDue = await ve.call('pendingDividend', [ACCOUNTS.bob]);
      assert.ok(aliceDue > bobDue, 'the longer horizon earns more on equal principal');
      assert.equal(aliceDue / bobDue, aliceUnits / bobUnits);
      assert.ok(aliceDue + bobDue <= 575n * ONE, 'never distributes more than was paid in');
      assert.ok(575n * ONE - (aliceDue + bobDue) < ONE, 'and loses no more than rounding dust');
    });

    test('the dividend follows the lock owner, not the delegatee', async () => {
      await ve.send('delegate', [ACCOUNTS.mallory], { from: ACCOUNTS.bob });
      await ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 10n * ONE });
      assert.equal(await ve.call('pendingDividend', [ACCOUNTS.mallory]), 0n);
      assert.ok((await ve.call('pendingDividend', [ACCOUNTS.bob])) > 0n);
    });

    test('claiming pays QRL and cannot be repeated', async () => {
      const before = await chain.balanceOf(ACCOUNTS.alice);
      const due = await ve.call('pendingDividend', [ACCOUNTS.alice]);
      await ve.send('claimDividend', [], { from: ACCOUNTS.alice });
      assert.equal((await chain.balanceOf(ACCOUNTS.alice)) - before, due);
      assert.equal(await ve.call('pendingDividend', [ACCOUNTS.alice]), 0n);
      await assert.rejects(ve.send('claimDividend', [], { from: ACCOUNTS.alice }), reverts('NothingToClaim'));
    });

    test('an account with no lock can claim nothing', async () => {
      await assert.rejects(ve.send('claimDividend', [], { from: ACCOUNTS.guardian }), reverts('NothingToClaim'));
    });

    test('a stale lock keeps what it earned but is corrected going forward', async () => {
      chain.advanceTime(2 * YEAR);
      const staleUnits = await ve.call('unitsOf', [ACCOUNTS.alice]);
      const liveWeight = await ve.call('weightOf', [ACCOUNTS.alice]);
      assert.ok(staleUnits > liveWeight, 'units have not decayed with the clock');

      const owedBefore = await ve.call('pendingDividend', [ACCOUNTS.bob]);
      await ve.send('syncWeight', [ACCOUNTS.alice], { from: ACCOUNTS.bob });
      assert.equal(await ve.call('unitsOf', [ACCOUNTS.alice]), liveWeight);
      assert.equal(await ve.call('pendingDividend', [ACCOUNTS.bob]), owedBefore,
        'correcting someone else must not touch what is already owed');
    });

    test('units are a dividend denominator, not a vote total', async () => {
      const units = (await ve.call('unitsOf', [ACCOUNTS.alice])) + (await ve.call('unitsOf', [ACCOUNTS.bob]));
      assert.equal(await ve.call('totalUnits'), units);
      assert.notEqual(await ve.call('totalWeight'), units, "bob's unsynced units still over-state him");
      assert.equal(
        await ve.call('totalWeight'),
        (await ve.call('weightOf', [ACCOUNTS.alice])) + (await ve.call('weightOf', [ACCOUNTS.bob])),
      );
    });

    test('the division remainder is carried, and the contract holds only what it owes', async () => {
      const before = await ve.call('carriedDust');
      await ve.send('distributeDividend', [], { from: ACCOUNTS.admin, value: 7n * ONE });
      assert.notEqual(await ve.call('carriedDust'), before + 7n * ONE, 'the carry is spent into the index');

      const held = await chain.balanceOf(ve.address);
      const owed =
        (await ve.call('pendingDividend', [ACCOUNTS.alice])) + (await ve.call('pendingDividend', [ACCOUNTS.bob]));
      assert.ok(held >= owed && held - owed < ONE, `holds ${held}, owes ${owed}`);
    });
  });

  describe('non-transferability', () => {
    test('no transfer entry point exists at all', async () => {
      const { ve } = await fixture();
      const movers = ve.iface.fragments.filter(
        (f) => f.type === 'function' && /^(transfer|transferFrom|approve)$/.test(f.name),
      );
      assert.deepEqual(movers, [], 'a transferable lock is a tradable vote');
    });
  });
});
