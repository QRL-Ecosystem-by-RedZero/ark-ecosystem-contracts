/**
 * QRL testnet v3 (QIP-55) transport, for the governance stack.
 *
 * Mirrors contracts/staking/scripts/qrl.js and the v3 notes of its CLAUDE.md
 * (items 26-32), and stays beside this repository's v2 `qrl.js` rather than
 * replacing it: the insurance scripts still target the 20-byte line.
 *
 *  - Addresses are 64 bytes, rendered `Q` + 128 hex. The first 20 bytes equal
 *    the pre-v3 address of the same mnemonic.
 *  - @theqrl/web3 1.0.x / @theqrl/wallet.js 6.x / @theqrl/abi 1.x, installed as
 *    the npm aliases `@theqrl/web3-v3`, `@theqrl/wallet.js-v6`, `@theqrl/abi-v3`
 *    so they sit beside the v2 line's 0.5.0 / 2.0.2.
 *  - ABI words and log slots are 64 bytes. Constructor arguments are encoded
 *    with @theqrl/abi (ethers cannot produce QIP-55 words) and logs are decoded
 *    by hand (`decodeLog`).
 *  - Private networks only, enforced in code (`assertPrivate`).
 */
const fs = require('fs');
const path = require('path');
const { keccak256 } = require('ethers');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
  return env;
}

/** Refuses any non-local RPC unless ALLOW_PUBLIC_RPC=1 (CLAUDE.md §2). */
function assertPrivate(env) {
  if (env.ALLOW_PUBLIC_RPC === '1') return;
  const url = env.QRL_RPC_URL || '';
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(url);
  if (!local) throw new Error(`QRL_RPC_URL "${url}" is not a private network; set ALLOW_PUBLIC_RPC=1 to override`);
}

function connect(env) {
  if (!env.DEPLOYER_MNEMONIC) throw new Error('DEPLOYER_MNEMONIC missing');
  assertPrivate(env);
  const { Web3 } = require('@theqrl/web3-v3');
  const { MLDSA87 } = require('@theqrl/wallet.js-v6');
  const web3 = new Web3(env.QRL_RPC_URL);
  const wallet = MLDSA87.newWalletFromMnemonic(env.DEPLOYER_MNEMONIC);
  const account = web3.qrl.accounts.seedToAccount(wallet.getHexExtendedSeed());
  web3.qrl.accounts.wallet.add(account);
  return { web3, account };
}

function artifact(name, buildDir) {
  return JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.json`), 'utf8'));
}

const sizeOf = (hex) => (hex.length - 2) / 2;

/** Signs locally and submits; the nonce is the pool's so a pending tx is followed, not replaced. */
async function sendRaw(web3, account, { to, data, value = 0n, gas = 3_000_000 }) {
  const [nonce, chainId, block] = await Promise.all([
    web3.qrl.getTransactionCount(account.address, 'pending'),
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
  const receipt = await web3.qrl.sendSignedTransaction(signed.rawTransaction);
  if (receipt.status !== undefined && BigInt(receipt.status) !== 1n) throw new Error(`tx to ${to} reverted`);
  return receipt;
}

/** ABI-encodes constructor arguments in 64-byte QIP-55 words. */
function encodeCtor(abi, args) {
  const { ConstructorFragment, defaultAbiCoder } = require('@theqrl/abi-v3');
  const entry = abi.find((e) => e.type === 'constructor');
  if (!entry) return '0x';
  return defaultAbiCoder.encode(ConstructorFragment.from(entry).inputs, args);
}

/** Calldata for `method(args)` in 64-byte words, via web3's contract codec. */
function encodeCall(web3, abi, method, args) {
  return new web3.qrl.Contract(abi).methods[method](...args).encodeABI();
}

/**
 * Decodes one QIP-55 log against `{ signature, topics: [{name,type}], data: [...] }`.
 * topic0 is the 32-byte hash left-aligned in a 64-byte slot; `address` is the
 * whole slot; numerics are right-aligned. Returns null when topic0 differs.
 */
function decodeLog(web3, spec, log) {
  const topic0 = String(web3.utils.sha3(spec.signature));
  if (String(log.topics[0]).slice(0, 66).toLowerCase() !== topic0.toLowerCase()) return null;
  const word = (type, hex) => {
    if (hex.length !== 128) throw new Error(`a QIP-55 log slot is 64 bytes, got ${hex.length / 2}`);
    if (type === 'address') return `Q${hex.toLowerCase()}`;
    if (type === 'bytes32') return `0x${hex.slice(0, 64).toLowerCase()}`;
    if (/^uint/.test(type)) return BigInt(`0x${hex}`);
    throw new Error(`decodeLog does not decode ${type}`);
  };
  const args = {};
  (spec.topics || []).forEach((f, i) => (args[f.name] = word(f.type, String(log.topics[i + 1]).replace(/^0x/, ''))));
  const data = String(log.data).replace(/^0x/, '');
  (spec.data || []).forEach((f, i) => (args[f.name] = word(f.type, data.slice(i * 128, (i + 1) * 128))));
  return args;
}

const DEPLOYED_EVENT = {
  signature: 'Deployed(address,bytes32,address,bytes32)',
  topics: [
    { name: 'uploader', type: 'address' },
    { name: 'uploadId', type: 'bytes32' },
  ],
  data: [
    { name: 'deployed', type: 'address' },
    { name: 'codeHash', type: 'bytes32' },
  ],
};

/** Direct deploy; returns the Q-form address. */
async function deploy(web3, account, art, args, gas = 8_000_000) {
  const data = art.bytecode + encodeCtor(art.abi, args).replace(/^0x/, '');
  const [nonce, chainId, block] = await Promise.all([
    web3.qrl.getTransactionCount(account.address, 'pending'),
    web3.qrl.getChainId(),
    web3.qrl.getBlock('latest'),
  ]);
  const baseFee = BigInt(block.baseFeePerGas || 7);
  const tip = 1_000_000_000n;
  const signed = await account.signTransaction({
    data,
    gas,
    nonce: Number(nonce),
    chainId: Number(chainId),
    type: 2,
    maxPriorityFeePerGas: tip.toString(),
    maxFeePerGas: (baseFee * 2n + tip).toString(),
  });
  const receipt = await web3.qrl.sendSignedTransaction(signed.rawTransaction);
  if (!receipt.contractAddress) throw new Error(`${art.contractName}: no contract address in receipt`);
  return String(receipt.contractAddress);
}

/**
 * Creation code above the direct ceiling is assembled on chain by ChunkedDeployer
 * (CLAUDE.md §1). Only contracts that take their wiring authority from a
 * constructor argument may go this way: the created contract sees the
 * ChunkedDeployer as `msg.sender`.
 */
async function deployChunked(web3, account, chunked, deployerArt, art, args, { pieceBytes = 12000, log = () => {} } = {}) {
  // Only the account that created a ChunkedDeployer can use it (staking audit
  // D19, 2026-09-29): refused here before a piece is sent rather than at the
  // first append.
  const bare = (a) => String(a).replace(/^(0x|Q)/i, '').toLowerCase();
  const owner = await new web3.qrl.Contract(deployerArt.abi, chunked).methods.owner().call();
  if (bare(owner) !== bare(account.address)) {
    throw new Error(`${art.contractName}: the ChunkedDeployer at ${chunked} belongs to ${owner}, not to ${account.address}`);
  }
  const body = art.bytecode.replace(/^0x/, '');
  const codeHash = keccak256(art.bytecode);
  const uploadId = codeHash;
  for (let i = 0; i < body.length; i += pieceBytes * 2) {
    const piece = '0x' + body.slice(i, i + pieceBytes * 2);
    await sendRaw(web3, account, { to: chunked, data: encodeCall(web3, deployerArt.abi, 'append', [uploadId, piece]), gas: 8_000_000 });
    log(`   ${art.contractName} piece ${i / (pieceBytes * 2) + 1}`);
  }
  const ctor = encodeCtor(art.abi, args);
  const receipt = await sendRaw(web3, account, {
    to: chunked,
    data: encodeCall(web3, deployerArt.abi, 'deploy', [uploadId, codeHash, ctor]),
    gas: 15_000_000,
  });
  for (const l of receipt.logs || []) {
    const ev = decodeLog(web3, DEPLOYED_EVENT, l);
    if (ev) return ev.deployed;
  }
  throw new Error(`${art.contractName}: ChunkedDeployer emitted no Deployed event`);
}

module.exports = { ROOT, loadEnv, assertPrivate, connect, artifact, sizeOf, sendRaw, encodeCall, encodeCtor, decodeLog, deploy, deployChunked };
