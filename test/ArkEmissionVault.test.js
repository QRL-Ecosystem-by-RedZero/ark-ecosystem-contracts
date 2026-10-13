/**
 * ArkEmissionVault and VeArk.lockFor: the emission schedule, the channel
 * roots, the Genesis lock, the 2.5 lock bonus and the Genesis campaign
 * (ArkAllocation-Design.md §5, §6, A7-A12, adopted 2026-10-13).
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { solidityPackedKeccak256, keccak256, concat, getBytes } = require('ethers');
const { expectRevert } = require('./fixtures');
const { Chain, ACCOUNTS, DAY, WEEK, YEAR, MAX_LOCK, ONE, key, addr, deployArkToken, epochOf } = require('./gov-fixture');

const GOV = ACCOUNTS.admin;
const PUBLISHER = ACCOUNTS.attester;
const M = 1_000_000n * ONE;
const U1 = addr(0xa1);
const U2 = addr(0xa2);
const CH = { STAKING: 0, ACORN: 1, GOVERNANCE: 2, LIQUIDITY: 3, CAMPAIGN: 4, RESERVE: 5, AMBASSADORS: 6 };

const leaf = (account, channel, amount) =>
  solidityPackedKeccak256(['address', 'uint8', 'uint256'], [account, channel, amount]);

/** Sorted-pair Merkle tree, the shape OpenZeppelin's MerkleProof verifies. */
function tree(leaves) {
  const hashPair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  const proof = (index) => {
    const out = [];
    let i = index;
    for (let l = 0; l < layers.length - 1; l++) {
      const sib = i ^ 1;
      if (sib < layers[l].length) out.push(layers[l][sib]);
      i >>= 1;
    }
    return out;
  };
  return { root: layers[layers.length - 1][0], proof };
}

/** A root paying `entries` = [[account, amount], ...] on `channel`. */
function rootFor(channel, entries) {
  const leaves = entries.map(([a, amt]) => leaf(a, channel, amt));
  const t = tree(leaves);
  return { root: t.root, proofOf: (i) => t.proof(i), total: entries.reduce((s, [, a]) => s + a, 0n) };
}

async function fixture() {
  const chain = await Chain.create();
  const ark = await deployArkToken(chain);
  const q = await chain.deploy('QDayStateDouble');
  const phase = await chain.deploy('ArkPhase', ['address', 'address', 'uint256'], [q.address, GOV, WEEK]);
  const startEpoch = epochOf(chain) + 1n;
  const vault = await chain.deploy(
    'ArkEmissionVault',
    ['address', 'address', 'uint256', 'uint256', 'address'],
    [ark.address, phase.address, WEEK, startEpoch, PUBLISHER],
  );
  const ve = await chain.deploy('VeArk', ['address', 'address[]'], [ark.address, [vault.address, ACCOUNTS.bob]]);
  await ve.send('addDistributor', [vault.address]);
  await vault.send('setVeArk', [ve.address]);
  await ark.send('transfer', [vault.address, 450n * M], { from: ACCOUNTS.alice });
  return { chain, ark, phase, vault, ve, startEpoch };
}

/** Moves to `offset` seconds into epoch `e`. */
function toEpoch(chain, e, offset = 60) {
  const target = Number(e) * WEEK + offset;
  chain.advanceTime(target - Number(chain.timestamp));
}

describe('VeArk.lockFor', () => {
  let chain, ark, ve;

  beforeEach(async () => {
    chain = await Chain.create();
    ark = await deployArkToken(chain);
    ve = await chain.deploy('VeArk', ['address', 'address[]'], [ark.address, [ACCOUNTS.bob]]);
    await ve.send('addDistributor', [ACCOUNTS.alice]);
    await ark.send('approve', [ve.address, 1000n * M], { from: ACCOUNTS.alice });
  });

  test('only a registered distributor locks for another account', async () => {
    await expectRevert(ve.send('lockFor', [ACCOUNTS.mallory, ONE, Number(chain.timestamp) + YEAR], { from: ACCOUNTS.mallory }), 'NotDistributor');
    await expectRevert(ve.send('addDistributor', [ACCOUNTS.mallory], { from: ACCOUNTS.mallory }), 'NotDistributorAdmin');
  });

  test('creates a lock owned and delegated by the account, paid by the distributor', async () => {
    const before = await ark.call('balanceOf', [ACCOUNTS.alice]);
    await ve.send('lockFor', [ACCOUNTS.mallory, 100n * ONE, Number(chain.timestamp) + MAX_LOCK], { from: ACCOUNTS.alice });
    const lock = await ve.call('lockOf', [ACCOUNTS.mallory]);
    assert.equal(lock.amount, 100n * ONE);
    assert.equal((await ve.call('delegateeOf', [ACCOUNTS.mallory])).toLowerCase(), ACCOUNTS.mallory.toLowerCase());
    assert.equal(before - (await ark.call('balanceOf', [ACCOUNTS.alice])), 100n * ONE);
    assert.ok((await ve.call('weightOf', [ACCOUNTS.mallory])) > 390n * ONE, 'about 4x at a full lock');
  });

  test('tops up an existing lock and extends it, never shortens it', async () => {
    const t = Number(chain.timestamp);
    await ve.send('lockFor', [ACCOUNTS.mallory, 10n * ONE, t + YEAR], { from: ACCOUNTS.alice });
    const first = await ve.call('lockOf', [ACCOUNTS.mallory]);
    await ve.send('lockFor', [ACCOUNTS.mallory, 5n * ONE, t + 30 * DAY], { from: ACCOUNTS.alice });
    const kept = await ve.call('lockOf', [ACCOUNTS.mallory]);
    assert.equal(kept.amount, 15n * ONE);
    assert.equal(kept.end, first.end, 'a shorter request keeps the longer end');
    await ve.send('lockFor', [ACCOUNTS.mallory, 5n * ONE, t + MAX_LOCK], { from: ACCOUNTS.alice });
    const longer = await ve.call('lockOf', [ACCOUNTS.mallory]);
    assert.equal(longer.amount, 20n * ONE);
    assert.ok(longer.end > first.end);
  });

  test('re-arms an expired lock', async () => {
    const t = Number(chain.timestamp);
    await ve.send('lockFor', [ACCOUNTS.mallory, 10n * ONE, t + 14 * DAY], { from: ACCOUNTS.alice });
    chain.advanceTime(30 * DAY);
    await ve.send('lockFor', [ACCOUNTS.mallory, 10n * ONE, Number(chain.timestamp) + YEAR], { from: ACCOUNTS.alice });
    const lock = await ve.call('lockOf', [ACCOUNTS.mallory]);
    assert.equal(lock.amount, 20n * ONE);
    assert.ok(lock.end > BigInt(Number(chain.timestamp) + YEAR - 8 * DAY));
  });

  test('G11 binds the account, not the distributor', async () => {
    await expectRevert(ve.send('lockFor', [ACCOUNTS.bob, ONE, Number(chain.timestamp) + YEAR], { from: ACCOUNTS.alice }), 'ProtocolOwned');
  });

  test('the admin role hands over once and the old admin loses it', async () => {
    await ve.send('setDistributorAdmin', [ACCOUNTS.guardian]);
    await expectRevert(ve.send('addDistributor', [ACCOUNTS.mallory]), 'NotDistributorAdmin');
    await ve.send('addDistributor', [ACCOUNTS.mallory], { from: ACCOUNTS.guardian });
    assert.equal(await ve.call('isDistributor', [ACCOUNTS.mallory]), true);
  });

  test('totalWeight is part of the interface', async () => {
    await ve.send('lockFor', [ACCOUNTS.mallory, 10n * ONE, Number(chain.timestamp) + YEAR], { from: ACCOUNTS.alice });
    assert.ok((await ve.call('totalWeight')) >= 10n * ONE);
  });
});

describe('ArkEmissionVault', () => {
  let chain, ark, vault, ve, phase, startEpoch;

  beforeEach(async () => {
    ({ chain, ark, vault, ve, phase, startEpoch } = await fixture());
  });

  describe('the schedule', () => {
    test('years 1-5 pay 132.5 / 112.5 / 81 / 54 / 45 M over 52 epochs; nothing outside', async () => {
      const years = [132_500_000n, 112_500_000n, 81_000_000n, 54_000_000n, 45_000_000n];
      for (let y = 0; y < 5; y++) {
        const e = startEpoch + BigInt(y * 52);
        assert.equal(await vault.call('epochAmount', [e]), (years[y] * ONE) / 52n, `year ${y + 1}`);
      }
      assert.equal(await vault.call('epochAmount', [startEpoch - 1n]), 0n);
      assert.equal(await vault.call('epochAmount', [startEpoch + 260n]), 0n);
      const fourChannels = years.reduce((s, v) => s + v, 0n);
      assert.equal(fourChannels + 25_000_000n, 450_000_000n, 'the four channels plus the campaign are the bucket');
    });

    test('a channel budget is its share of the epoch in the phase in force', async () => {
      const per = await vault.call('epochAmount', [startEpoch]);
      assert.equal(await vault.call('budgetOf', [startEpoch, CH.STAKING]), (per * 5000n) / 10000n);
      assert.equal(await vault.call('budgetOf', [startEpoch, CH.LIQUIDITY]), (per * 1500n) / 10000n);
      await expectRevert(vault.call('budgetOf', [startEpoch, CH.CAMPAIGN]), 'UnknownChannel');
    });
  });

  describe('channel roots and claims', () => {
    test('a root is the publisher\'s, for a closed epoch, within budget, once', async () => {
      const r = rootFor(CH.STAKING, [[U1, 100n * ONE]]);
      toEpoch(chain, startEpoch);
      await expectRevert(vault.send('setRoot', [startEpoch, CH.STAKING, r.root, r.total], { from: PUBLISHER }), 'EpochNotClosed');
      toEpoch(chain, startEpoch + 1n);
      await expectRevert(vault.send('setRoot', [startEpoch, CH.STAKING, r.root, r.total]), 'NotPublisher');
      const budget = await vault.call('budgetOf', [startEpoch, CH.STAKING]);
      await expectRevert(vault.send('setRoot', [startEpoch, CH.STAKING, r.root, budget + 1n], { from: PUBLISHER }), 'RootOverBudget');
      await vault.send('setRoot', [startEpoch, CH.STAKING, r.root, r.total], { from: PUBLISHER });
      await expectRevert(vault.send('setRoot', [startEpoch, CH.STAKING, r.root, r.total], { from: PUBLISHER }), 'RootAlreadySet');
      await expectRevert(vault.send('setRoot', [startEpoch - 1n, CH.STAKING, r.root, 0], { from: PUBLISHER }), 'EpochOutOfSchedule');
    });

    test('year 1 pays only a four-year lock, whatever the claimant asks', async () => {
      const r = rootFor(CH.ACORN, [[U1, 100n * ONE], [ACCOUNTS.bob, 1n]]);
      toEpoch(chain, startEpoch + 1n);
      await vault.send('setRoot', [startEpoch, CH.ACORN, r.root, r.total], { from: PUBLISHER });
      await vault.send('claim', [startEpoch, CH.ACORN, 100n * ONE, r.proofOf(0), false], { from: U1 });
      const lock = await ve.call('lockOf', [U1]);
      assert.equal(lock.amount, 100n * ONE);
      assert.ok(lock.end >= BigInt(Number(chain.timestamp) + MAX_LOCK - WEEK));
      assert.equal(await ark.call('balanceOf', [U1]), 0n, 'nothing liquid in year 1');
      await expectRevert(
        vault.send('claim', [startEpoch, CH.ACORN, 100n * ONE, r.proofOf(0), true], { from: U1 }),
        'AlreadyClaimed',
      );
    });

    test('from year 2 the claimant chooses: the full amount locked or 2/5 liquid', async () => {
      const e = startEpoch + 52n;
      const r = rootFor(CH.GOVERNANCE, [[U1, 100n * ONE], [U2, 50n * ONE]]);
      toEpoch(chain, e + 1n);
      await vault.send('setRoot', [e, CH.GOVERNANCE, r.root, r.total], { from: PUBLISHER });
      await vault.send('claim', [e, CH.GOVERNANCE, 100n * ONE, r.proofOf(0), false], { from: U1 });
      assert.equal(await ark.call('balanceOf', [U1]), 40n * ONE);
      await vault.send('claim', [e, CH.GOVERNANCE, 50n * ONE, r.proofOf(1), true], { from: U2 });
      assert.equal((await ve.call('lockOf', [U2])).amount, 50n * ONE);
    });

    test('a wrong amount or account fails the proof', async () => {
      const r = rootFor(CH.STAKING, [[U1, 100n * ONE], [U2, 1n]]);
      toEpoch(chain, startEpoch + 1n);
      await vault.send('setRoot', [startEpoch, CH.STAKING, r.root, r.total], { from: PUBLISHER });
      await expectRevert(vault.send('claim', [startEpoch, CH.STAKING, 101n * ONE, r.proofOf(0), true], { from: U1 }), 'InvalidProof');
      await expectRevert(vault.send('claim', [startEpoch, CH.STAKING, 100n * ONE, r.proofOf(0), true], { from: U2 }), 'InvalidProof');
    });
  });

  describe('the Genesis campaign', () => {
    let r;
    beforeEach(async () => {
      r = rootFor(CH.CAMPAIGN, [[U1, 300n * ONE], [U2, 600n * ONE]]);
      await vault.send('setCampaignRoot', [CH.CAMPAIGN, r.root], { from: PUBLISHER });
    });

    test('closed before start and after 120 days; the reserve stays open twice as long', async () => {
      await expectRevert(vault.send('claimCampaign', [CH.CAMPAIGN, 300n * ONE, r.proofOf(0), 0], { from: U1 }), 'CampaignClosed');
      const [opens, closes] = await vault.call('campaignWindow', [CH.CAMPAIGN]);
      assert.equal(closes - opens, BigInt(120 * DAY));
      const [, reserveCloses] = await vault.call('campaignWindow', [CH.RESERVE]);
      assert.equal(reserveCloses - opens, BigInt(240 * DAY));
      chain.advanceTime(Number(closes) - Number(chain.timestamp) + 1);
      await expectRevert(vault.send('claimCampaign', [CH.CAMPAIGN, 300n * ONE, r.proofOf(0), 0], { from: U1 }), 'CampaignClosed');
    });

    test('liquid pays 2/3, a lock of at least a year pays the full amount', async () => {
      toEpoch(chain, startEpoch);
      await vault.send('claimCampaign', [CH.CAMPAIGN, 300n * ONE, r.proofOf(0), 0], { from: U1 });
      assert.equal(await ark.call('balanceOf', [U1]), 200n * ONE);
      const t = Number(chain.timestamp);
      await expectRevert(
        vault.send('claimCampaign', [CH.CAMPAIGN, 600n * ONE, r.proofOf(1), t + YEAR - DAY], { from: U2 }),
        'CampaignLockTooShort',
      );
      await vault.send('claimCampaign', [CH.CAMPAIGN, 600n * ONE, r.proofOf(1), t + YEAR + WEEK], { from: U2 });
      assert.equal((await ve.call('lockOf', [U2])).amount, 600n * ONE);
      assert.equal(await vault.call('campaignSpent'), 900n * ONE, 'the pool counts entitlement, not payout');
      await expectRevert(vault.send('claimCampaign', [CH.CAMPAIGN, 300n * ONE, r.proofOf(0), 0], { from: U1 }), 'AlreadyClaimed');
    });

    test('a campaign root is written once', async () => {
      await expectRevert(vault.send('setCampaignRoot', [CH.CAMPAIGN, r.root], { from: PUBLISHER }), 'RootAlreadySet');
      await expectRevert(vault.send('setCampaignRoot', [CH.STAKING, r.root], { from: PUBLISHER }), 'UnknownChannel');
    });

    test('the pool never pays more than 25M', async () => {
      const big = rootFor(CH.RESERVE, [[U1, 25_000_001n * ONE], [U2, 1n]]);
      await vault.send('setCampaignRoot', [CH.RESERVE, big.root], { from: PUBLISHER });
      toEpoch(chain, startEpoch);
      await expectRevert(
        vault.send('claimCampaign', [CH.RESERVE, 25_000_001n * ONE, big.proofOf(0), 0], { from: U1 }),
        'CampaignPoolExceeded',
      );
    });

    test('ambassadors vest linearly over 52 epochs after a 13-epoch cliff', async () => {
      const a = rootFor(CH.AMBASSADORS, [[U1, 520n * ONE], [U2, 1n]]);
      await vault.send('setCampaignRoot', [CH.AMBASSADORS, a.root], { from: PUBLISHER });
      toEpoch(chain, startEpoch + 12n);
      await expectRevert(vault.send('claimVested', [520n * ONE, a.proofOf(0)], { from: U1 }), 'NothingVested');
      toEpoch(chain, startEpoch + 26n);
      await vault.send('claimVested', [520n * ONE, a.proofOf(0)], { from: U1 });
      assert.equal(await ark.call('balanceOf', [U1]), 260n * ONE);
      toEpoch(chain, startEpoch + 60n);
      await vault.send('claimVested', [520n * ONE, a.proofOf(0)], { from: U1 });
      assert.equal(await ark.call('balanceOf', [U1]), 520n * ONE);
      await expectRevert(vault.send('claimVested', [520n * ONE, a.proofOf(0)], { from: U1 }), 'NothingVested');
    });
  });

  describe('governance', () => {
    const k = (ch, p) => key(`emission${ch}@${p}`);

    test('shares move in a compare-and-swap diff that keeps each phase whole', async () => {
      await expectRevert(
        vault.send('setParamsDiff', [[{ key: k('Staking', 0), expected: 5000, value: 4000 }]]),
        'SharesNotWhole',
      );
      await expectRevert(
        vault.send('setParamsDiff', [[{ key: k('Staking', 0), expected: 4000, value: 4000 }]]),
        'ShareMismatch',
      );
      await vault.send('setParamsDiff', [[
        { key: k('Staking', 2), expected: 5000, value: 4000 },
        { key: k('Liquidity', 2), expected: 1500, value: 2500 },
      ]]);
      assert.equal(await vault.call('shareOf', [2, CH.STAKING]), 4000n);
      assert.equal(await vault.call('shareOf', [0, CH.STAKING]), 5000n, 'other phases untouched');
      await expectRevert(vault.send('setParamsDiff', [[{ key: key('nope'), expected: 0, value: 0 }]]), 'UnknownShareKey');
      await expectRevert(
        vault.send('setParamsDiff', [[{ key: k('Acorn', 0), expected: 2000, value: 2000 }]], { from: U1 }),
        'OnlyGovernance',
      );
    });

    test('governance replaces the publisher; veARK is wired once by the deployer', async () => {
      await vault.send('setRootPublisher', [ACCOUNTS.guardian]);
      assert.equal((await vault.call('rootPublisher')).toLowerCase(), ACCOUNTS.guardian.toLowerCase());
      await expectRevert(vault.send('setVeArk', [addr(9)]), 'VeArkAlreadySet');
    });

    test('governance hands over in two steps', async () => {
      await vault.send('proposeGovernance', [ACCOUNTS.guardian]);
      await expectRevert(vault.send('acceptGovernance', [], { from: U1 }), 'NotPendingGovernance');
      await vault.send('acceptGovernance', [], { from: ACCOUNTS.guardian });
      assert.equal((await vault.call('governance')).toLowerCase(), ACCOUNTS.guardian.toLowerCase());
    });
  });

  test('the vault reads the phase from ArkPhase', async () => {
    assert.equal((await vault.call('arkPhase')).toLowerCase(), phase.address.toLowerCase());
  });
});
