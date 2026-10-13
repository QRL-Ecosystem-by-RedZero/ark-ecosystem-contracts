/**
 * ArkTreasuryRouter: the Treasury's QRL (QuantumArk-Treasury-Flows.md §3-§7,
 * adopted 2026-10-13). Lanes in, the three lines, the Cushion first while it
 * is short, per-epoch dispatch caps, the Q-Day freeze, governed keys.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const { expectRevert } = require('./fixtures');
const { Chain, ACCOUNTS, WEEK, ONE, key, addr, toNextEpoch } = require('./gov-fixture');

const lane = (s) => keccak256(toUtf8Bytes(s));
const PRIMARY = lane('quantumark.lane.treasury.qurrl-primary.v1');
const STAKING = lane('quantumark.lane.treasury.staking.v1');
const INSURANCE = lane('quantumark.lane.treasury.insurance.v1');
const CUSHION = lane('quantumark.lane.cushion.v1');
const BUDGET = lane('quantumark.lane.qurrl.budget.v1');
const OPS = addr(0xc1);

async function fixture() {
  const chain = await Chain.create();
  await chain.fund(ACCOUNTS.alice, 10n ** 24n);
  const q = await chain.deploy('QDayStateDouble');
  const router = await chain.deploy('ArkTreasuryRouter', ['address', 'address'], [q.address, OPS]);
  const bond = await chain.deploy('PortDouble', ['bytes32'], [CUSHION]);
  const budget = await chain.deploy('PortDouble', ['bytes32'], [BUDGET]);
  await router.send('wireCushion', [bond.address]);
  await router.send('wireQurrlBudget', [budget.address]);
  return { chain, q, router, bond, budget };
}

const deposit = (router, l, value) => router.send('deposit', [l, '0x' + '00'.repeat(32)], { from: ACCOUNTS.alice, value });

describe('ArkTreasuryRouter', () => {
  let chain, q, router, bond, budget;
  beforeEach(async () => {
    ({ chain, q, router, bond, budget } = await fixture());
  });

  test('accepts the Qurrl and staking lanes; insurance is declared and closed', async () => {
    await deposit(router, PRIMARY, 100n * ONE);
    await deposit(router, STAKING, ONE);
    assert.equal(await router.call('unallocated'), 101n * ONE);
    await expectRevert(deposit(router, INSURANCE, ONE), 'LaneClosed');
    await expectRevert(deposit(router, CUSHION, ONE), 'LaneUnknown');
  });

  test('rebalance: operations first, then the 55 / 18 ratio of the rest', async () => {
    await deposit(router, PRIMARY, 1000n * ONE);
    await router.send('rebalance');
    assert.equal(await router.call('operationsBalance'), 270n * ONE);
    const dao = await router.call('daoBalance');
    const liq = await router.call('liquidityBalance');
    assert.equal(dao + liq, 730n * ONE);
    assert.equal(dao, (730n * ONE * 5500n) / 7300n);
    await expectRevert(router.send('rebalance'), 'NothingToRebalance');
  });

  test('while the Cushion is short, the rest goes there first, up to the shortfall', async () => {
    await bond.send('setShortfall', [500n * ONE]);
    await deposit(router, PRIMARY, 1000n * ONE);
    await router.send('rebalance');
    assert.equal(await router.call('operationsBalance'), 270n * ONE, 'operations is never redirected');
    assert.equal(await router.call('cushionBalance'), 500n * ONE);
    assert.equal((await router.call('daoBalance')) + (await router.call('liquidityBalance')), 230n * ONE);
  });

  test('dispatch pays the Cushion, 10% of the DAO line to Qurrl and operations, once per epoch', async () => {
    await bond.send('setShortfall', [100n * ONE]);
    await deposit(router, PRIMARY, 1000n * ONE);
    toNextEpoch(chain);
    const opsBefore = await chain.balanceOf(OPS);
    await router.send('dispatch');
    assert.equal(await chain.balanceOf(bond.address), 100n * ONE);
    assert.equal(await chain.balanceOf(budget.address), (await router.call("daoBalance")) / 9n, "10% of the line before dispatch");
    assert.ok((await chain.balanceOf(budget.address)) > 0n);
    assert.equal((await chain.balanceOf(OPS)) - opsBefore, 270n * ONE);
    await expectRevert(router.send('dispatch'), 'AlreadyDispatched');
    toNextEpoch(chain);
    await router.send('dispatch');
  });

  test('the Cushion is capped per epoch at its share of the router\'s balance', async () => {
    await bond.send('setShortfall', [10_000n * ONE]);
    await deposit(router, PRIMARY, 1000n * ONE);
    toNextEpoch(chain);
    await router.send('dispatch');
    // Total 1,000; cushion pot 730; cap 25% of 1,000 = 250.
    assert.equal(await chain.balanceOf(bond.address), 250n * ONE);
    assert.equal(await router.call('cushionBalance'), 480n * ONE);
  });

  test('a Q-Day freeze closes the lanes in and pays only the Cushion', async () => {
    await bond.send('setShortfall', [100n * ONE]);
    await deposit(router, PRIMARY, 1000n * ONE);
    await q.send('declare', [Number(chain.timestamp)]);
    await expectRevert(deposit(router, PRIMARY, ONE), 'LaneClosed');
    toNextEpoch(chain);
    const opsBefore = await chain.balanceOf(OPS);
    await router.send('dispatch');
    assert.equal(await chain.balanceOf(bond.address), 100n * ONE);
    assert.equal(await chain.balanceOf(budget.address), 0n);
    assert.equal(await chain.balanceOf(OPS), opsBefore);
  });

  test('a refusing port keeps its money in the router', async () => {
    await budget.send('setClosed', [true]);
    await deposit(router, PRIMARY, 1000n * ONE);
    toNextEpoch(chain);
    await router.send('dispatch');
    assert.equal(await chain.balanceOf(budget.address), 0n);
    assert.equal(await router.call('daoBalance'), (730n * ONE * 5500n) / 7300n);
  });

  describe('governance', () => {
    test('lines move together, within range, compare-and-swap', async () => {
      await expectRevert(
        router.send('setParamsDiff', [[{ key: key('operationsLineBps'), expected: 2700, value: 3000 }]]),
        'LinesNotWhole',
      );
      await expectRevert(
        router.send('setParamsDiff', [[{ key: key('operationsLineBps'), expected: 2700, value: 3600 }]]),
        'ParamOutOfRange',
      );
      await router.send('setParamsDiff', [[
        { key: key('operationsLineBps'), expected: 2700, value: 3000 },
        { key: key('daoLineBps'), expected: 5500, value: 5200 },
      ]]);
      assert.equal(await router.call('operationsLineBps'), 3000n);
      await expectRevert(
        router.send('setParamsDiff', [[{ key: key('qurrlDispatchCapBps'), expected: 999, value: 1500 }]]),
        'ParamMismatch',
      );
      await expectRevert(router.send('setParamsDiff', [[{ key: key('nope'), expected: 0, value: 0 }]]), 'UnknownKey');
      await expectRevert(
        router.send('setOperations', [addr(5)], { from: ACCOUNTS.mallory }),
        'OnlyGovernance',
      );
    });

    test('ports are wired once, by the deployer', async () => {
      await expectRevert(router.send('wireCushion', [addr(5)]), 'PortAlreadyWired');
    });
  });
});
