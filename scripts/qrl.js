/**
 * QRL Zond (Hyperion) connection helpers.
 *
 * Notes on this chain that differ from a stock EVM setup:
 *  - Addresses are 20 bytes but rendered with a `Q` prefix, not `0x`.
 *  - Signatures are ML-DSA-87 (post-quantum), not secp256k1. There is no
 *    private key in the ECDSA sense; accounts come from a 34-word mnemonic
 *    -> 51-byte extended seed.
 *  - The RPC exposes a `qrl_*` namespace instead of `eth_*`.
 *    @theqrl/web3@0.5.0 is the release line that matches both the namespace and
 *    the 20-byte address format.
 *
 * Adapted from the QRL ecosystem's reference scripts for this toolchain.
 */
const fs = require('fs');
const path = require('path');
const { Web3 } = require('@theqrl/web3');
const { MLDSA87 } = require('@theqrl/wallet.js');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) {
    throw new Error('.env missing — copy .env.example and fill in DEPLOYER_MNEMONIC');
  }
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/**
 * Refuses to connect to anything but a private network.
 *
 * Deploying throwaway iterations to the shared public testnet leaves permanent
 * contract litter, so the guard is here rather than in a comment. Override with
 * ALLOW_PUBLIC_RPC=1 in .env only when a public deployment is genuinely wanted.
 */
function assertPrivate(env) {
  if (env.ALLOW_PUBLIC_RPC === '1') return;
  const url = env.QRL_RPC_URL || '';
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/.test(url);
  if (!isLocal) {
    throw new Error(
      `QRL_RPC_URL "${url}" is not a private network.\n` +
        'Point it at a local enclave (see CLAUDE.md section 2), or set ALLOW_PUBLIC_RPC=1 to override.',
    );
  }
}

function connect() {
  const env = loadEnv();
  if (!env.DEPLOYER_MNEMONIC) throw new Error('DEPLOYER_MNEMONIC missing from .env');
  assertPrivate(env);

  const web3 = new Web3(env.QRL_RPC_URL);
  const wallet = MLDSA87.newWalletFromMnemonic(env.DEPLOYER_MNEMONIC);
  const account = web3.qrl.accounts.seedToAccount(wallet.getHexExtendedSeed());
  web3.qrl.accounts.wallet.add(account);

  return { web3, account, env };
}

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${name}.json`), 'utf8'));
}

/**
 * Signs locally and submits via qrl_sendRawTransaction.
 *
 * A contract built as `new Contract(abi, address)` is not bound to the local
 * wallet, so web3 would otherwise fall back to `qrl_sendTransaction` and ask the
 * node to sign. Signing explicitly avoids depending on that distinction.
 */
async function sendRaw(web3, account, { to, data, value = 0n, gas }) {
  const [nonce, chainId, block] = await Promise.all([
    web3.qrl.getTransactionCount(account.address, 'latest'),
    web3.qrl.getChainId(),
    web3.qrl.getBlock('latest'),
  ]);

  const baseFee = BigInt(block.baseFeePerGas || 7);
  const tip = 1_000_000_000n;

  const signed = await account.signTransaction({
    to,
    data,
    value: value.toString(),
    gas,
    nonce: Number(nonce),
    chainId: Number(chainId),
    type: 2,
    maxPriorityFeePerGas: tip.toString(),
    maxFeePerGas: (baseFee * 2n + tip).toString(),
  });

  return web3.qrl.sendSignedTransaction(signed.rawTransaction);
}

async function deploy(web3, account, name, args = [], gas = 6_000_000) {
  const art = artifact(name);
  const instance = new web3.qrl.Contract(art.abi);
  const deployed = await instance
    .deploy({ data: art.bytecode, arguments: args })
    .send({ from: account.address, gas, type: 2 });
  return deployed;
}

function creationCode(web3, name, args = []) {
  const art = artifact(name);
  const instance = new web3.qrl.Contract(art.abi);
  return instance.deploy({ data: art.bytecode, arguments: args }).encodeABI();
}

function saveDeployment(name, data) {
  const dir = path.join(ROOT, 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2));
  return path.join(dir, `${name}.json`);
}

module.exports = { connect, artifact, deploy, sendRaw, creationCode, saveDeployment, loadEnv, ROOT };
