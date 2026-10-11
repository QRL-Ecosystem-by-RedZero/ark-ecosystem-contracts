/**
 * The testnet build profile of the governance stack (scripts/lib/profile.js):
 * one factor for every duration, or no build.
 *
 * The stack shares Ark Staking's epoch clock (design N5), so its testnet build
 * must scale exactly as that repository's does — one day to ten minutes — and
 * a duration the rewrite cannot scale must stop the build rather than pass
 * through at the specification's length.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PROFILES, profile, rewriteSource, rewriteSources, ProfileError } = require('../scripts/lib/profile');

const CONTRACTS = path.join(__dirname, '..', 'contracts');

test('the testnet and rapid profiles are the staking factors: one day is 600 s and 60 s', () => {
  assert.equal(PROFILES.testnet.day, 600);
  assert.equal(PROFILES.rapid.day, 60);
  assert.equal(PROFILES.spec.day, 86400);
  assert.throws(() => profile('fast'), ProfileError);
});

test('days and hours in code scale by the one factor; comments and strings keep the specification', () => {
  const src = 'uint64 constant A = 7 days; // 7 days\nuint64 constant B = 48 hours; string s = "24 hours";';
  const { text, rewrites } = rewriteSource(src, profile('testnet'));
  assert.match(text, /A = \(7 \* 600\);/);
  assert.match(text, /B = \(48 \* 25\);/);
  assert.match(text, /\/\/ 7 days/);
  assert.match(text, /"24 hours"/);
  assert.equal(rewrites.length, 2);
  assert.equal(rewriteSource(src, profile('spec')).text, src);
});

test('a duration in seconds, minutes, weeks or years stops a profiled build', () => {
  for (const unit of ['seconds', 'minutes', 'weeks', 'years']) {
    assert.throws(() => rewriteSource(`uint64 constant X = 3 ${unit};`, profile('testnet')), ProfileError, unit);
  }
});

test('the governance sources scale without a refusal, and the epoch is seventy minutes at the testnet profile', () => {
  const read = (rel) => ({ content: fs.readFileSync(path.join(CONTRACTS, rel), 'utf8') });
  const files = ['ArkToken.hyp', 'VeArk.hyp', 'ArkTimelock.hyp', 'ArkGovernor.hyp', 'ArkQDayOracle.hyp', 'utils/ArkEpoch.hyp', 'utils/ArkGovTables.hyp'];
  const { sources, rewrites } = rewriteSources(Object.fromEntries(files.map((f) => [f, read(f)])), profile('testnet'));
  assert.ok(rewrites.length >= 20, `${rewrites.length} durations rewritten`);
  assert.match(sources['utils/ArkEpoch.hyp'].content, /EPOCH_LENGTH = \(7 \* 600\);/);
  assert.match(sources['ArkGovernor.hyp'].content, /QDAY_PERIOD = \(48 \* 25\);/);
  assert.match(sources['ArkQDayOracle.hyp'].content, /CERTIFICATION_WINDOW = \(24 \* 25\);/);
});
