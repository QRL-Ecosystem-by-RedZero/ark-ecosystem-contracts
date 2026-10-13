/**
 * The rows added on 2026-10-13: the treasury's ARK (`transfer`, target and
 * quarterly cap), the emission vault's keys and selectors, the treasury
 * router's keys, and Qurrl under the timelock (ArkAllocation-Design §7.1,
 * QuantumArk-Treasury-Flows §3, §7).
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Interface } = require('ethers');
const { expectRevert } = require('./fixtures');
const { Chain, ACCOUNTS, DAY, HOUR, WEEK, ONE, key, sel, addr, KIND } = require('./gov-fixture');

const PROPOSER = ACCOUNTS.admin;
const GUARDIAN = ACCOUNTS.guardian;
const SUPPLY = 1_000_000_000n * ONE;
const erc20 = new Interface(['function transfer(address,uint256)', 'function approve(address,uint256)']);
const any = new Interface([
  'function setParamsDiff((bytes32,uint256,uint256)[])',
  'function setRootPublisher(address)',
  'function addDistributor(address)',
  'function setOperations(address)',
  'function payBudget(address,uint256)',
  'function setCushionBps(uint16)',
  'function setTreasury(address)',
  'function setCushion(address)',
  'function setOwner(address)',
  'function setAcornOracle(address)',
  'function setRoyalty(address,uint16)',
  'function grantRole(bytes32,address)',
  'function freeze()',
]);
const diffOf = (changes) => any.encodeFunctionData('setParamsDiff', [changes.map(([k, e, v]) => [key(k), e, v])]);

async function fixture() {
  const chain = await Chain.create();
  const tl = await chain.deploy('ArkTimelock', ['address', 'address'], [PROPOSER, GUARDIAN]);
  const ark = await chain.deploy(
    'ArkToken',
    ['address', 'address', 'address', 'address', 'address', 'uint64'],
    [ACCOUNTS.alice, tl.address, ACCOUNTS.attester, ACCOUNTS.bob, ACCOUNTS.mallory, chain.timestamp],
  );
  return { chain, tl, ark };
}

async function scheduled(tl, target, payload) {
  const res = await tl.send('schedule', [target, payload], { from: PROPOSER });
  const [ev] = tl.events(res, 'Scheduled');
  return { opId: ev.args.opId, eta: ev.args.eta, delay: ev.args.delay };
}

describe('the treasury ARK row', () => {
  let chain, tl, ark;
  beforeEach(async () => {
    ({ chain, tl, ark } = await fixture());
  });

  test('a transfer is schedulable only on the ARK token, once it is named', async () => {
    const pay = erc20.encodeFunctionData('transfer', [ACCOUNTS.bob, ONE]);
    await expectRevert(tl.send('schedule', [ark.address, pay], { from: PROPOSER }), 'TransferTargetNotArk');
    await tl.send('setArkToken', [ark.address], { from: PROPOSER });
    await expectRevert(tl.send('setArkToken', [ark.address], { from: PROPOSER }), 'AlreadySet');
    await expectRevert(tl.send('schedule', [addr(9), pay], { from: PROPOSER }), 'TransferTargetNotArk');
    const { delay } = await scheduled(tl, ark.address, pay);
    assert.equal(delay, BigInt(30 * DAY));
  });

  test('it is objectable at S1 and executes after 30 days', async () => {
    await tl.send('setArkToken', [ark.address], { from: PROPOSER });
    const { opId } = await scheduled(tl, ark.address, erc20.encodeFunctionData('transfer', [ACCOUNTS.bob, 1000n * ONE]));
    const [objectable] = await tl.call('objectionOf', [opId]);
    assert.equal(objectable, true);
    chain.advanceTime(30 * DAY + 1);
    const before = await ark.call('balanceOf', [ACCOUNTS.bob]);
    await tl.send('execute', [opId]);
    assert.equal((await ark.call('balanceOf', [ACCOUNTS.bob])) - before, 1000n * ONE);
    assert.equal(await tl.call('arkSpendRoom'), (SUPPLY * 50n) / 10000n - 1000n * ONE);
  });

  test('the quarter never moves more than arkSpendCapBps of supply', async () => {
    await tl.send('setArkToken', [ark.address], { from: PROPOSER });
    const cap = (SUPPLY * 50n) / 10000n;
    await expectRevert(
      tl.send('schedule', [ark.address, erc20.encodeFunctionData('transfer', [ACCOUNTS.bob, cap + 1n])], { from: PROPOSER }),
      'ArkSpendCapExceeded',
    );
    const a = await scheduled(tl, ark.address, erc20.encodeFunctionData('transfer', [ACCOUNTS.bob, cap]));
    const b = await scheduled(tl, ark.address, erc20.encodeFunctionData('transfer', [ACCOUNTS.mallory, ONE]));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [a.opId]);
    await expectRevert(tl.send('execute', [b.opId]), 'ArkSpendCapExceeded');
  });

  test('the cap is the timelock\'s own key: 30 days, a quarter of 0 - 200 per step', async () => {
    await expectRevert(scheduled(tl, tl.address, diffOf([['arkSpendCapBps', 50, 101]])), 'StepTooLarge');
    const { opId, delay } = await scheduled(tl, tl.address, diffOf([['arkSpendCapBps', 50, 100]]));
    assert.equal(delay, BigInt(30 * DAY));
    chain.advanceTime(30 * DAY + 1);
    await tl.send('execute', [opId]);
    assert.equal(await tl.call('arkSpendCapBps'), 100n);
    await expectRevert(tl.send('setParamsDiff', [[[key('arkSpendCapBps'), 100, 50]]]), 'NotProposer');
  });
});

describe('the 2026-10-13 rows', () => {
  let tl;
  beforeEach(async () => {
    ({ tl } = await fixture());
  });

  const delayOf = (payload) => tl.call('delayFor', [payload]);

  test('selectors: the emission vault, veARK, the router, Qurrl', async () => {
    const rows = [
      [any.encodeFunctionData('setRootPublisher', [addr(1)]), 7 * DAY],
      [any.encodeFunctionData('addDistributor', [addr(1)]), 30 * DAY],
      [any.encodeFunctionData('setOperations', [addr(1)]), 30 * DAY],
      [any.encodeFunctionData('payBudget', [addr(1), 1]), 14 * DAY],
      [any.encodeFunctionData('setCushionBps', [3500]), 30 * DAY],
      [any.encodeFunctionData('setTreasury', [addr(1)]), 30 * DAY],
      [any.encodeFunctionData('setCushion', [addr(1)]), 30 * DAY],
      [any.encodeFunctionData('setOwner', [addr(1)]), 14 * DAY],
      [any.encodeFunctionData('setAcornOracle', [addr(1)]), 14 * DAY],
      [any.encodeFunctionData('setRoyalty', [addr(1), 250]), 30 * DAY],
      [any.encodeFunctionData('grantRole', [key('X'), addr(1)]), 30 * DAY],
      [any.encodeFunctionData('freeze', []), 7 * DAY],
    ];
    for (const [payload, days] of rows) assert.equal(await delayOf(payload), BigInt(days), payload.slice(0, 10));
  });

  test('what moves money or hands a role over is watched by Leg B at S1', async () => {
    for (const payload of [
      any.encodeFunctionData('addDistributor', [addr(1)]),
      any.encodeFunctionData('payBudget', [addr(1), 1]),
      any.encodeFunctionData('setTreasury', [addr(1)]),
      any.encodeFunctionData('grantRole', [key('X'), addr(1)]),
    ]) {
      const [, valueTransfer] = await tl.call('ruleFor', [payload]);
      assert.equal(valueTransfer, true, payload.slice(0, 10));
    }
    const [, owner] = await tl.call('ruleFor', [any.encodeFunctionData('setOwner', [addr(1)])]);
    assert.equal(owner, false);
  });

  test('keys: emission cells 30 days step 2,500; router lines 14 days; every Qurrl minter key 14 days', async () => {
    for (const ch of ['Staking', 'Acorn', 'Governance', 'Liquidity']) {
      for (let p = 0; p < 5; p++) {
        const [d, step] = await tl.call('keyRule', [key(`emission${ch}@${p}`)]);
        assert.equal(d, BigInt(30 * DAY));
        assert.equal(step, 2500n);
      }
    }
    for (const [name, step] of [
      ['operationsLineBps', 375n], ['daoLineBps', 625n], ['liquidityLineBps', 375n],
      ['qurrlDispatchCapBps', 500n], ['cushionDispatchCapBps', 1250n],
    ]) {
      const [d, s] = await tl.call('keyRule', [key(name)]);
      assert.equal(d, BigInt(14 * DAY), name);
      assert.equal(s, step, name);
    }
    const fields = ['acornCap', 'qrlCap', 'fusionCap', 'reqPts', 'reqPtsMin', 'reqPtsMax', 'mintFee', 'mintFeeMin',
      'mintFeeMax', 'fusionFee', 'walletLimit', 'mintDuration', 'fusionDuration', 'lockBaseFee'];
    for (const f of fields) {
      for (let p = 0; p < 5; p++) {
        const [d, s] = await tl.call('keyRule', [key(`${f}@${p}`)]);
        assert.equal(d, BigInt(14 * DAY), `${f}@${p}`);
        assert.equal(s, 0n);
      }
    }
    const [none] = await tl.call('keyRule', [key('acornCap@5')]);
    assert.equal(none, 0n, 'phase 5 does not exist');
  });
});

describe('the governor kinds that carry them', () => {
  test('TreasurySpend, QurrlSeason and AttesterSetChange name exactly their selectors', async () => {
    const chain = await Chain.create();
    const rules = await chain.deploy('ArkGovernorRules');
    const TREASURY_SPEND = 2;
    const QURRL_SEASON = 6;
    const s = (sig) => sel(sig);
    assert.equal(await rules.call('allows', [TREASURY_SPEND, s('transfer(address,uint256)')]), true);
    assert.equal(await rules.call('allows', [TREASURY_SPEND, s('payBudget(address,uint256)')]), true);
    assert.equal(await rules.call('allows', [TREASURY_SPEND, s('setParamsDiff((bytes32,uint256,uint256)[])')]), false);
    assert.equal(await rules.call('allows', [QURRL_SEASON, s('setCushionBps(uint16)')]), true);
    assert.equal(await rules.call('allows', [QURRL_SEASON, s('transfer(address,uint256)')]), false);
    assert.equal(await rules.call('allows', [KIND.AttesterSetChange, s('setRootPublisher(address)')]), true);
    assert.equal(await rules.call('allows', [KIND.AttesterSetChange, s('addDistributor(address)')]), true);
  });
});
