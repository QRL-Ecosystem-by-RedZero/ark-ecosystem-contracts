# Ark Ecosystem Contracts

The ecosystem layer of Quantum Ark on **QRL**, written in **Hyperion**: one ARK
token, one veARK vote source, one governor and one timelock that govern every
Quantum Ark product, the Q-Day declaration oracle, the ecosystem phase, and the
`IArkFlow` lanes through which money moves between products.

Products (Ark Staking, Qurrl, and the others) live in their own repositories and
plug into this layer through the ports described below.

## Quick start

```bash
npm ci
npm run check            # vendor OpenZeppelin 4.9.6, compile with hypc, run the tests
```

The tests run on a local QRVM harness (`test/harness.js`). Nothing here deploys to
a shared network by default: `scripts/qrl.js` refuses any non-local `QRL_RPC_URL`
unless `ALLOW_PUBLIC_RPC=1` is set.

## Contracts

| Contract | Purpose |
| --- | --- |
| [ArkToken.hyp](contracts/ArkToken.hyp) | ARK, fixed supply minted once into five allocation buckets; contributor allocation vests |
| [VeArk.hyp](contracts/VeArk.hyp) | Vote-escrowed ARK: weight = amount × time left, the only vote source of the ecosystem |
| [ArkGovernor.hyp](contracts/ArkGovernor.hyp) | Proposal rounds, the Q-Day ratification vote and court escalations |
| [ArkGovernorRules.hyp](contracts/ArkGovernorRules.hyp) | Which proposal kind may call which selector, through [ArkGovTables](contracts/utils/ArkGovTables.hyp) |
| [ArkTimelock.hyp](contracts/ArkTimelock.hyp) | Delays every governed call by the row its selector occupies; objection window; guardian |
| [ArkMultisig.hyp](contracts/ArkMultisig.hyp) | The proposer and guardian multisigs of the early stages |
| [ArkQDayOracle.hyp](contracts/ArkQDayOracle.hyp) | Q-Day declaration: one bonded attester freezes, a quorum certifies, veARK ratifies |
| [ArkPhase.hyp](contracts/ArkPhase.hyp) | The ecosystem phase (0-4) every product reads its coefficients by |
| [ChunkedDeployer.hyp](contracts/ChunkedDeployer.hyp) | Deploys creation code too large for one QRL request |

Interfaces a product implements or calls are in [contracts/interfaces](contracts/interfaces):
`IArkStakeGovernable` (keyed parameter diffs), `IObjectionSource`,
`IArkCourtEscalation`, `IArkPhase`, `IArkQDayOracle` and `IArkFlow` (lanes,
receiver and sender). Repositories that hold a copy of `IArkFlow.hyp`,
`ArkFlowReceiver.hyp` or `ChunkedDeployer.hyp` keep it byte-identical to this
one; `test/ArkFlow.test.js` checks the copies of sibling checkouts named in
`ARK_SIBLINGS` (by default `../../ark-staking/contracts` and
`../../qurrl/contracts`).

## Two compiler lines

The npm `@theqrl/hypc` 0.0.2 (v2 line) builds `build/` and runs the tests. The
QIP-55 v3 line (64-byte addresses, 512-bit QRVM) needs a native compiler:

```bash
HYPC_BIN=/path/to/hypc npm run compile:qrvm            # -> build-qrvm/
HYPC_BIN=/path/to/hypc npm run compile:testnet -- --qrvm   # testnet clock profile
```

`--profile testnet|rapid` scales every duration by one factor for test networks
and records the profile in each artifact.

## Deploying the governance stack

```bash
npm run deploy:governance     # multisigs, timelock, token, veARK, rules, oracle, governor
npm run governance:keys       # the timelock rows: selectors, keys, delays
```

## License

[MIT](LICENSE)
