/**
 * ArkQDayOracle: one attester freezes, 5 of 9 certify inside 24 hours, only the
 * governor ratifies or rejects, the panel moves only through the timelock and
 * never mid-process, bonds are released late and slashed only by the court.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { expectRevert } = require('./fixtures');
const { Chain, ACCOUNTS, DAY, HOUR, ONE, key, addr, ATTESTERS } = require('./gov-fixture');

const TIMELOCK = ACCOUNTS.admin; // an EOA standing in for ArkTimelock
const COURT = ACCOUNTS.oracle;
const GOVERNOR = ACCOUNTS.bob;
const STATE = { Normal: 0n, Advisory: 1n, Certified: 2n, Declared: 3n };

describe('ArkQDayOracle', () => {
  let chain;
  let q;

  beforeEach(async () => {
    chain = await Chain.create();
    q = await chain.deploy(
      'ArkQDayOracle',
      ['address', 'address', 'uint256', 'uint64', 'address[]'],
      [TIMELOCK, COURT, ONE, 7 * DAY, ATTESTERS],
    );
    await q.send('setGovernor', [GOVERNOR]);
    for (const a of ATTESTERS) {
      await chain.fund(a);
      await q.send('postBond', [], { from: a, value: ONE });
    }
  });

  async function advisory(from = ATTESTERS[0]) {
    await q.send('raiseAdvisory', [key('artefact')], { from });
  }

  async function certified() {
    await advisory();
    for (let i = 1; i < 5; i++) await q.send('certify', [], { from: ATTESTERS[i] });
  }

  test('the Ark Staking read surface starts clear', async () => {
    assert.equal(await q.call('declared'), false);
    assert.equal(await q.call('frozen'), false);
    assert.equal(await q.call('declaredAt'), 0n);
    assert.equal(await q.call('PANEL_SIZE'), 9n);
    assert.equal(await q.call('QUORUM'), 5n);
  });

  test('one bonded attester freezes at once; nobody else can', async () => {
    await expectRevert(q.send('raiseAdvisory', [key('x')], { from: ACCOUNTS.mallory }), 'NotAttester');
    await advisory();
    assert.equal(await q.call('state'), STATE.Advisory);
    assert.equal(await q.call('frozen'), true);
    assert.equal(await q.call('declared'), false);
    await expectRevert(advisory(ATTESTERS[1]), 'InvalidPhase');
  });

  test('an attester below the bond does not count', async () => {
    const fresh = addr(0xdd);
    const r = await chain.deploy(
      'ArkQDayOracle',
      ['address', 'address', 'uint256', 'uint64', 'address[]'],
      [TIMELOCK, COURT, ONE, 7 * DAY, [fresh]],
    );
    await expectRevert(r.send('raiseAdvisory', [key('x')], { from: fresh }), 'BondTooLow');
  });

  test('5 of 9 within 24 hours certify; a repeat or a late certification is refused', async () => {
    await advisory();
    for (let i = 1; i < 4; i++) await q.send('certify', [], { from: ATTESTERS[i] });
    await expectRevert(q.send('certify', [], { from: ATTESTERS[1] }), 'AlreadyCertified');
    assert.equal(await q.call('state'), STATE.Advisory);
    await q.send('certify', [], { from: ATTESTERS[4] });
    assert.equal(await q.call('state'), STATE.Certified);
    assert.equal(await q.call('certifications'), 5n);
    await expectRevert(q.send('certify', [], { from: ATTESTERS[5] }), 'InvalidPhase');
  });

  test('an advisory short of quorum lapses after 24 hours, lifts the freeze, and cools its raiser down', async () => {
    await advisory();
    await q.send('certify', [], { from: ATTESTERS[1] });
    await expectRevert(q.send('lapse', []), 'WindowOpen');
    chain.advanceTime(24 * HOUR + 1);
    await expectRevert(q.send('certify', [], { from: ATTESTERS[2] }), 'WindowClosed');
    await q.send('lapse', [], { from: ACCOUNTS.mallory });
    assert.equal(await q.call('frozen'), false);
    await expectRevert(advisory(), 'OnCooldown');
    await advisory(ATTESTERS[1]);
    assert.equal(await q.call('round'), 2n);
  });

  test('only the governor resolves, only a certification, only its own round', async () => {
    await advisory();
    await expectRevert(q.send('resolve', [1, true], { from: GOVERNOR }), 'InvalidPhase');
    for (let i = 1; i < 5; i++) await q.send('certify', [], { from: ATTESTERS[i] });
    await expectRevert(q.send('resolve', [1, true], { from: ACCOUNTS.mallory }), 'OnlyGovernor');
    await expectRevert(q.send('resolve', [2, true], { from: GOVERNOR }), 'StaleRound');
    await q.send('resolve', [1, true], { from: GOVERNOR });
    assert.equal(await q.call('declared'), true);
    assert.equal(await q.call('declaredAt'), chain.timestamp);
    assert.equal(await q.call('frozen'), true, 'the freeze never lifts after a declaration');
    await expectRevert(advisory(ATTESTERS[5]), 'InvalidPhase');
  });

  test('a rejected certification lifts the freeze and cools the raiser down', async () => {
    await certified();
    await q.send('resolve', [1, false], { from: GOVERNOR });
    assert.equal(await q.call('state'), STATE.Normal);
    assert.equal(await q.call('frozen'), false);
    await expectRevert(advisory(), 'OnCooldown');
  });

  test('the panel changes through the timelock only, never mid-process, at most 9', async () => {
    const extra = addr(0xde);
    await expectRevert(q.send('addAttester', [extra], { from: ACCOUNTS.mallory }), 'OnlyTimelock');
    await expectRevert(q.send('addAttester', [extra], { from: TIMELOCK }), 'PanelFull');
    await q.send('removeAttester', [ATTESTERS[8]], { from: TIMELOCK });
    await advisory();
    await expectRevert(q.send('addAttester', [extra], { from: TIMELOCK }), 'InvalidPhase');
    chain.advanceTime(24 * HOUR + 1);
    await q.send('lapse', []);
    await q.send('addAttester', [extra], { from: TIMELOCK });
    assert.equal((await q.call('attesters')).length, 9);
    await assert.rejects(
      chain.deploy('ArkQDayOracle', ['address', 'address', 'uint256', 'uint64', 'address[]'], [
        TIMELOCK, COURT, ONE, 7 * DAY, [...ATTESTERS, extra],
      ]),
    );
  });

  test('a removed attester gets its bond back 21 days later; a sitting one cannot withdraw', async () => {
    await expectRevert(q.send('withdrawBond', [], { from: ATTESTERS[0] }), 'BondLocked');
    await q.send('removeAttester', [ATTESTERS[0]], { from: TIMELOCK });
    await expectRevert(q.send('withdrawBond', [], { from: ATTESTERS[0] }), 'BondLocked');
    chain.advanceTime(21 * DAY + 1);
    const before = await chain.balanceOf(ATTESTERS[0]);
    await q.send('withdrawBond', [], { from: ATTESTERS[0] });
    assert.equal((await chain.balanceOf(ATTESTERS[0])) - before, ONE);
  });

  test('only the court slashes a bond', async () => {
    await expectRevert(q.send('slash', [ATTESTERS[0], ONE, ACCOUNTS.alice], { from: GOVERNOR }), 'OnlyCourt');
    const before = await chain.balanceOf(ACCOUNTS.alice);
    await q.send('slash', [ATTESTERS[0], ONE / 2n, ACCOUNTS.alice], { from: COURT });
    assert.equal((await chain.balanceOf(ACCOUNTS.alice)) - before, ONE / 2n);
    assert.equal(await q.call('bondOf', [ATTESTERS[0]]), ONE / 2n);
    await expectRevert(q.send('raiseAdvisory', [key('x')], { from: ATTESTERS[0] }), 'BondTooLow');
  });
});
