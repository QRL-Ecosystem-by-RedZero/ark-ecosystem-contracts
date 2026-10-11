/**
 * ArkMultisig: k-of-n approval by transaction, current owners only, self-governed
 * owner set — and its use as the S1 proposer of ArkTimelock.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { expectRevert } = require('./fixtures');
const { Chain, ACCOUNTS, DAY, key, diff } = require('./gov-fixture');

const OWNERS = [ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.oracle];

describe('ArkMultisig', () => {
  let chain;
  let ms;
  let tl;
  let params;

  beforeEach(async () => {
    chain = await Chain.create();
    ms = await chain.deploy('ArkMultisig', ['address[]', 'uint256'], [OWNERS, 2]);
    tl = await chain.deploy('ArkTimelock', ['address', 'address'], [ms.address, ACCOUNTS.guardian]);
    params = await chain.deploy('ParamsDouble', ['address'], [tl.address]);
    await params.send('defineParam', [key('bufferBps'), 250, 1500, 250]);
  });

  async function submit(target, data, from = ACCOUNTS.alice, value = 0n) {
    const res = await ms.send('submit', [target, value, data], { from });
    return ms.events(res, 'Submitted')[0].args.id;
  }

  test('constructor refuses a threshold of zero or above the owner count', async () => {
    await assert.rejects(chain.deploy('ArkMultisig', ['address[]', 'uint256'], [OWNERS, 0]));
    await assert.rejects(chain.deploy('ArkMultisig', ['address[]', 'uint256'], [OWNERS, 4]));
    await assert.rejects(chain.deploy('ArkMultisig', ['address[]', 'uint256'], [[ACCOUNTS.alice, ACCOUNTS.alice], 1]));
  });

  test('k approvals schedule on the timelock; k-1 do not', async () => {
    const payload = tl.iface.encodeFunctionData('schedule', [params.address, diff([['bufferBps', 250, 300]])]);
    const id = await submit(tl.address, payload);
    await expectRevert(ms.send('execute', [id], { from: ACCOUNTS.alice }), 'BelowThreshold');
    await ms.send('approve', [id], { from: ACCOUNTS.bob });
    const res = await ms.send('execute', [id], { from: ACCOUNTS.bob });
    const [ev] = tl.events(res, 'Scheduled');
    // bufferBps is a value-transfer key since PV-19 (2026-09-30): 30 days, objectable by Leg B at S1.
    assert.equal(ev.args.delay, BigInt(30 * DAY), 'the multisig cannot shorten the table either');
    assert.equal((await tl.call('objectionOf', [ev.args.opId]))[0], true);
    await expectRevert(ms.send('execute', [id], { from: ACCOUNTS.bob }), 'AlreadyExecuted');
  });

  test('non-owners can neither submit, approve nor execute', async () => {
    await expectRevert(ms.send('submit', [tl.address, 0, '0x'], { from: ACCOUNTS.mallory }), 'NotOwner');
    const id = await submit(tl.address, '0x');
    await expectRevert(ms.send('approve', [id], { from: ACCOUNTS.mallory }), 'NotOwner');
    await expectRevert(ms.send('execute', [id], { from: ACCOUNTS.mallory }), 'NotOwner');
  });

  test('a revoked approval stops counting', async () => {
    const id = await submit(tl.address, '0x');
    await ms.send('approve', [id], { from: ACCOUNTS.bob });
    await ms.send('revoke', [id], { from: ACCOUNTS.bob });
    assert.equal(await ms.call('approvalCount', [id]), 1n);
    await expectRevert(ms.send('revoke', [id], { from: ACCOUNTS.bob }), 'NotApproved');
  });

  test('the owner set changes only through the multisig itself, and a removed owner approval stops counting', async () => {
    await expectRevert(ms.send('removeOwner', [ACCOUNTS.bob], { from: ACCOUNTS.alice }), 'OnlySelf');

    const pending = await submit(tl.address, '0x', ACCOUNTS.bob); // bob approves this one
    const rm = await submit(ms.address, ms.iface.encodeFunctionData('removeOwner', [ACCOUNTS.bob]));
    await ms.send('approve', [rm], { from: ACCOUNTS.oracle });
    await ms.send('execute', [rm], { from: ACCOUNTS.alice });
    assert.equal(await ms.call('isOwner', [ACCOUNTS.bob]), false);
    assert.equal(await ms.call('approvalCount', [pending]), 0n);
  });

  test('removing owners lowers an unreachable threshold, never to zero', async () => {
    const rm = await submit(ms.address, ms.iface.encodeFunctionData('removeOwner', [ACCOUNTS.bob]));
    await ms.send('approve', [rm], { from: ACCOUNTS.oracle });
    await ms.send('execute', [rm], { from: ACCOUNTS.alice });
    const rm2 = await submit(ms.address, ms.iface.encodeFunctionData('removeOwner', [ACCOUNTS.oracle]));
    await ms.send('approve', [rm2], { from: ACCOUNTS.oracle });
    await ms.send('execute', [rm2], { from: ACCOUNTS.alice });
    assert.equal(await ms.call('threshold'), 1n);
    const rm3 = await submit(ms.address, ms.iface.encodeFunctionData('removeOwner', [ACCOUNTS.alice]));
    await expectRevert(ms.send('execute', [rm3], { from: ACCOUNTS.alice }), 'TxFailed');
  });
});
