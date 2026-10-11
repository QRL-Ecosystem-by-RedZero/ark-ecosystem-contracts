/**
 * The shared deposit port: what ArkFlowReceiver enforces for every inheritor,
 * what ArkFlowSend does when a receiver cannot take the money, and that the
 * copies of the interface in the sibling repos stay byte-identical.
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { keccak256, toUtf8Bytes } = require('ethers');
const { Chain, ACCOUNTS } = require('./harness');

const lane = (name) => keccak256(toUtf8Bytes(`quantumark.lane.${name}.v1`));
const CUSHION = lane('cushion');
const TREASURY = lane('treasury.qurrl-primary');
const INSURANCE = lane('treasury.insurance');
const UNKNOWN = lane('nothing');
const REF = '0x' + '01'.repeat(32);

async function fixture() {
  const chain = await Chain.create();
  const sink = await chain.deploy('FlowSink');
  const sender = await chain.deploy('FlowSender');
  return { chain, sink, sender };
}

describe('ArkFlowReceiver', () => {
  let chain, sink;

  before(async () => {
    ({ chain, sink } = await fixture());
  });

  test('anyone may deposit on a declared lane, and the event names the sender', async () => {
    const res = await sink.send('deposit', [TREASURY, REF], { from: ACCOUNTS.mallory, value: 5n });
    const [ev] = sink.events(res, 'Deposited');
    assert.equal(ev.args.lane, TREASURY);
    assert.equal(ev.args.amount, 5n);
    assert.equal(await sink.call('laneTotal', [TREASURY]), 5n);
    assert.equal(await sink.call('credited'), 5n);
    assert.equal(await chain.balanceOf(sink.address), 5n);
  });

  test('zero, unknown and closed lanes revert before anything moves', async () => {
    await assert.rejects(sink.send('deposit', [TREASURY, REF]), (e) => e.reverted);
    await assert.rejects(sink.send('deposit', [UNKNOWN, REF], { value: 1n }), (e) => e.reverted);
    await assert.rejects(sink.send('deposit', [INSURANCE, REF], { value: 1n }), (e) => e.reverted);
    assert.equal(await sink.call('laneTotal', [INSURANCE]), 0n);
  });

  test('a governance-style switch opens a reserved lane', async () => {
    await sink.send('setInsuranceOpen', [true]);
    await sink.send('deposit', [INSURANCE, REF], { value: 2n });
    assert.equal(await sink.call('laneTotal', [INSURANCE]), 2n);
  });

  test('a freeze closes ordinary lanes and leaves the defensive one open', async () => {
    await sink.send('setFrozen', [true]);
    await assert.rejects(sink.send('deposit', [TREASURY, REF], { value: 1n }), (e) => e.reverted);
    await sink.send('deposit', [CUSHION, REF], { value: 7n });
    assert.equal(await sink.call('acceptsLane', [TREASURY]), false);
    assert.equal(await sink.call('acceptsLane', [CUSHION]), true);
    await sink.send('setFrozen', [false]);
  });

  test('a ceiling bounds the lane and room shrinks as it fills', async () => {
    await sink.send('setCeiling', [10n]);
    const info = await sink.call('laneInfo', [CUSHION]);
    assert.equal(info.room, 3n, '7 already held');
    await assert.rejects(sink.send('deposit', [CUSHION, REF], { value: 4n }), (e) => e.reverted);
    await sink.send('deposit', [CUSHION, REF], { value: 3n });
    assert.equal(await sink.call('acceptsLane', [CUSHION]), false);
  });
});

describe('ArkFlowSend', () => {
  let chain, sink, sender;

  before(async () => {
    ({ chain, sink, sender } = await fixture());
  });

  test('sends in full where the lane has room', async () => {
    const res = await sender.send('push', [sink.address, TREASURY, REF, 9n], { value: 9n });
    assert.equal(sender.events(res, 'Pushed')[0].args.sent, 9n);
    assert.equal(await chain.balanceOf(sink.address), 9n);
  });

  test('clamps to the lane room and keeps the rest', async () => {
    await sink.send('setCeiling', [4n]);
    const res = await sender.send('push', [sink.address, CUSHION, REF, 9n], { value: 9n });
    assert.equal(sender.events(res, 'Pushed')[0].args.sent, 4n);
    assert.equal(await chain.balanceOf(sender.address), 5n, 'the unsent value stays with the sender');
  });

  test('a closed, unknown or absent receiver returns 0 and never reverts', async () => {
    const bad = await chain.deploy('NotAReceiver');
    for (const [target, l] of [
      [sink.address, INSURANCE],
      [sink.address, UNKNOWN],
      [bad.address, TREASURY],
      [ACCOUNTS.bob, TREASURY],
    ]) {
      const res = await sender.send('push', [target, l, REF, 3n], { value: 3n });
      assert.equal(sender.events(res, 'Pushed')[0].args.sent, 0n);
    }
  });
});

describe('copies of the port in the sibling repos', () => {
  const FILES = [
    'contracts/interfaces/IArkFlow.hyp',
    'contracts/utils/ArkFlowReceiver.hyp',
  ];
  // ARK_SIBLINGS: comma-separated checkouts; by default the workspace layout projects/<name>/contracts.
  const SIBLINGS = (process.env.ARK_SIBLINGS || '../../ark-staking/contracts,../../qurrl/contracts')
    .split(',')
    .map((dir) => path.resolve(__dirname, '..', dir.trim()));
  for (const repo of SIBLINGS) {
    for (const file of FILES) {
      const other = path.join(repo, file);
      const label = path.relative(path.join(__dirname, '..'), repo).replace(/\\/g, '/');
      test(`${label}/${file} is byte-identical, where the copy exists`, (t) => {
        if (!fs.existsSync(other)) return t.skip(`${label} is not checked out beside this repository`);
        assert.equal(
          fs.readFileSync(other, 'utf8'),
          fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
        );
      });
    }
  }
});
