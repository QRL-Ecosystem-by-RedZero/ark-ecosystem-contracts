/**
 * Shared test helpers.
 */
const assert = require('node:assert/strict');

/** Asserts the call reverts, and that the custom error is exactly `name`. */
async function expectRevert(promise, name) {
  try {
    await promise;
  } catch (e) {
    assert.equal(e.reverted, true, `expected a revert, got: ${e.message}`);
    if (name) assert.equal(e.message, name, `expected revert ${name}, got ${e.message}`);
    return e;
  }
  assert.fail(`expected revert ${name || ''} but the call succeeded`);
}

module.exports = { expectRevert };
