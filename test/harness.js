/**
 * Local ZVM execution harness — the private network this project tests against.
 *
 * QRL Zond's ZVM is an EVM fork and hypc emits standard EVM bytecode, so the
 * compiled artifacts execute unmodified under @ethereumjs/vm. That buys two
 * things the public testnet cannot give us: control over `block.timestamp`,
 * which every timelock and Q-Day path depends on, and the freedom to deploy
 * throwaway contracts without leaving permanent litter on a shared chain.
 *
 * Addresses here are plain 0x/20-byte EVM addresses. On the live network the
 * same 20 bytes are rendered with a `Q` prefix; the difference is presentation
 * only and does not affect execution.
 *
 * CAVEAT: this harness runs stock EVM, so precompiles the real ZVM may not ship
 * would silently appear to work. Never rely on one the Hyperion compiler itself
 * refuses to expose — `ecrecover` above all.
 */
const fs = require('fs');
const path = require('path');
const { createVM } = require('@ethereumjs/vm');
const { Common, Mainnet, Hardfork } = require('@ethereumjs/common');
const {
  createAddressFromString,
  hexToBytes,
  bytesToHex,
  createAccount,
} = require('@ethereumjs/util');
const { Interface, AbiCoder, keccak256, toUtf8Bytes } = require('ethers');

const ROOT = path.join(__dirname, '..');
const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });

const coder = AbiCoder.defaultAbiCoder();

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'build', `${name}.json`), 'utf8'));
}

/** Deterministic test accounts. */
const ACCOUNTS = {
  admin: '0x' + '11'.repeat(20),
  attester: '0x' + '22'.repeat(20),
  oracle: '0x' + '33'.repeat(20),
  alice: '0x' + '44'.repeat(20),
  bob: '0x' + '55'.repeat(20),
  mallory: '0x' + '66'.repeat(20),
  guardian: '0x' + '77'.repeat(20),
};

const role = (name) => keccak256(toUtf8Bytes(name));
const DEFAULT_ADMIN_ROLE = '0x' + '00'.repeat(32);

/** keccak256(abi.encodePacked(ethContract, tokenId)), matching the registry docs. */
function assetHash(ethContract, tokenId) {
  return keccak256(
    Buffer.concat([
      Buffer.from(ethContract.replace(/^0x/, ''), 'hex'),
      Buffer.from(BigInt(tokenId).toString(16).padStart(64, '0'), 'hex'),
    ]),
  );
}

/**
 * A deployed contract bound to the chain, with ABI-typed methods.
 *
 * `send` mutates state and throws a decoded custom error on revert; `call`
 * is the read path. Both take `{ from, value }` as an optional final argument.
 */
class Contract {
  constructor(chain, name, address) {
    this.chain = chain;
    this.name = name;
    this.address = address;
    this.iface = new Interface(artifact(name).abi);
  }

  async send(method, args = [], opts = {}) {
    const data = this.iface.encodeFunctionData(method, args);
    const res = await this.chain.execute(this.address, opts.from || ACCOUNTS.admin, data, opts.value || 0n);
    return { ...res, decoded: this._decodeResult(method, res.returnValue) };
  }

  async call(method, args = [], opts = {}) {
    const data = this.iface.encodeFunctionData(method, args);
    const res = await this.chain.execute(this.address, opts.from || ACCOUNTS.admin, data, 0n, true);
    const out = this._decodeResult(method, res.returnValue);
    return out && out.length === 1 ? out[0] : out;
  }

  _decodeResult(method, returnValue) {
    const frag = this.iface.getFunction(method);
    if (!frag.outputs.length) return [];
    return this.iface.decodeFunctionResult(frag, returnValue);
  }

  /** Decoded logs this contract emitted in a receipt, filtered by event name. */
  events(res, name) {
    const out = [];
    for (const log of res.logs) {
      if (log.address.toLowerCase() !== this.address.toLowerCase()) continue;
      let parsed;
      try {
        parsed = this.iface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        continue;
      }
      if (parsed && (!name || parsed.name === name)) out.push(parsed);
    }
    return out;
  }
}

class Chain {
  constructor(vm) {
    this.vm = vm;
    this.blockNumber = 1n;
    this.timestamp = 1_700_000_000n;
    this.gasPool = 30_000_000n;
  }

  static async create() {
    let chain;
    const blockchain = {
      getBlock: async (n) => {
        const num = BigInt(n);
        const outOfRange = num >= chain.blockNumber || chain.blockNumber - num > 256n;
        return {
          hash: () =>
            hexToBytes(outOfRange ? '0x' + '00'.repeat(32) : keccak256(toUtf8Bytes(`block-${num}`))),
        };
      },
    };
    chain = new Chain(await createVM({ common, blockchain }));
    for (const addr of Object.values(ACCOUNTS)) await chain.fund(addr);
    return chain;
  }

  advanceTime(seconds) {
    this.timestamp += BigInt(seconds);
    this.blockNumber += BigInt(seconds) / 12n + 1n;
  }

  /**
   * Moves to a new block, 12 seconds later per block. Transactions sent without
   * an advance share one block, which is exactly what a snapshot taken at
   * `block.number - 1` must be tested against.
   */
  mine(blocks = 1) {
    this.blockNumber += BigInt(blocks);
    this.timestamp += 12n * BigInt(blocks);
  }

  blockContext() {
    return {
      header: {
        number: this.blockNumber,
        timestamp: this.timestamp,
        gasLimit: 30_000_000n,
        baseFeePerGas: 7n,
        difficulty: 0n,
        prevRandao: hexToBytes(keccak256(toUtf8Bytes(`randao-${this.blockNumber}`))),
        coinbase: createAddressFromString('0x' + '11'.repeat(20)),
      },
    };
  }

  async fund(addr, wei = 10n ** 21n) {
    await this.vm.stateManager.putAccount(
      createAddressFromString(addr),
      createAccount({ balance: wei }),
    );
  }

  async balanceOf(addr) {
    const acc = await this.vm.stateManager.getAccount(createAddressFromString(addr));
    return acc ? acc.balance : 0n;
  }

  /**
   * Deploys an artifact. `argTypes`/`argValues` are the constructor signature;
   * hypc places constructor args after the creation code as usual.
   */
  async deploy(name, argTypes = [], argValues = [], from = ACCOUNTS.admin) {
    const art = artifact(name);
    let data = art.bytecode;
    if (argTypes.length) data += coder.encode(argTypes, argValues).replace(/^0x/, '');

    const res = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: undefined,
      data: hexToBytes(data),
      gasLimit: this.gasPool,
      value: 0n,
      block: this.blockContext(),
    });
    if (res.execResult.exceptionError) {
      throw new Error(`deploy ${name} failed: ${res.execResult.exceptionError.error}`);
    }
    return new Contract(this, name, res.createdAddress.toString());
  }

  /** Attaches an already-deployed address under a different ABI. */
  at(name, address) {
    return new Contract(this, name, address);
  }

  async execute(to, from, dataHex, value = 0n, readOnly = false) {
    const res = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: createAddressFromString(to),
      data: hexToBytes(dataHex),
      gasLimit: this.gasPool,
      value,
      block: this.blockContext(),
    });

    const ret = bytesToHex(res.execResult.returnValue);
    if (res.execResult.exceptionError) {
      const e = new Error(decodeRevert(ret) || res.execResult.exceptionError.error);
      e.reverted = true;
      e.data = ret;
      throw e;
    }
    if (readOnly) {
      // runCall commits; for a view path there is nothing to roll back because
      // the callee is `view` and wrote nothing.
    }
    return {
      returnValue: ret,
      gasUsed: res.execResult.executionGasUsed,
      logs: (res.execResult.logs || []).map(([address, topics, data]) => ({
        address: '0x' + Buffer.from(address).toString('hex'),
        topics: topics.map((t) => '0x' + Buffer.from(t).toString('hex')),
        data: '0x' + Buffer.from(data).toString('hex'),
      })),
    };
  }
}

/** All custom errors declared across the project, for revert decoding. */
let errorIface;
function revertInterface() {
  if (errorIface) return errorIface;
  const frags = new Map();
  for (const f of fs.readdirSync(path.join(ROOT, 'build'))) {
    for (const item of artifact(f.replace(/\.json$/, '')).abi) {
      if (item.type === 'error') frags.set(item.name, item);
    }
  }
  errorIface = new Interface([...frags.values()]);
  return errorIface;
}

function decodeRevert(ret) {
  if (!ret || ret === '0x') return null;
  if (ret.startsWith('0x08c379a0')) {
    return coder.decode(['string'], '0x' + ret.slice(10))[0];
  }
  if (ret.startsWith('0x4e487b71')) {
    return `Panic(${coder.decode(['uint256'], '0x' + ret.slice(10))[0]})`;
  }
  try {
    const parsed = revertInterface().parseError(ret);
    return parsed ? parsed.name : null;
  } catch {
    return null;
  }
}

module.exports = { Chain, Contract, artifact, ACCOUNTS, role, DEFAULT_ADMIN_ROLE, assetHash, coder };
