/**
 * Build profiles for the governance stack, and the one rewrite a non-spec
 * profile may make.
 *
 * The one rule this module exists to enforce: **a time-compressed build scales
 * every duration by the same factor, or it does not build.**
 *
 * WHY THIS REPOSITORY HAS A PROFILE AT ALL
 * ----------------------------------------
 * The governance stack and Ark Staking share one epoch clock (design N5,
 * `contracts/utils/ArkEpoch.hyp`): a round opens on the boundary at which a
 * parameter it passes takes effect there, and the governor's objection chamber
 * reads the bond's principal "at the boundary that opened epoch e". Ark
 * Staking's testnet deployment is compiled one day to ten minutes (its
 * `scripts/lib/profile.js`); a governance stack left on the specification's
 * clock would number its epochs 144 times more slowly than the contracts it
 * governs, and on a devnet that is rebuilt from genesis every day no 48-hour
 * timelock operation or Q-Day ratification would ever complete. So the
 * testnet build of this stack is compiled at the same factor.
 *
 * The factor table below is the same as Ark Staking's, day for day. The
 * repositories do not import each other's sources, so it is repeated here
 * rather than required; `contracts/staking/scripts/vendor-governance.js`
 * refuses artifacts whose recorded `profile.day` differs from the staking
 * profile it vendors them for, which is what holds the two tables together.
 * Ark Staking's one override (its QRL claim margin) has no counterpart here.
 *
 * The rewrite runs in memory at compile time: `N days` and `N hours` in code
 * become `(N * seconds-at-the-profile)`; a duration written in `seconds`,
 * `minutes`, `weeks` or `years` stops the build, and comments and strings are
 * never touched. Vendored OpenZeppelin (`lib/`) is exempt.
 */
const DAY = 86400;

const PROFILES = {
  spec: { name: 'spec', day: DAY, suffix: '' },
  testnet: { name: 'testnet', day: 600, suffix: '-testnet' },
  rapid: { name: 'rapid', day: 60, suffix: '-rapid' },
};

const SCALED = { days: DAY, hours: 3600 };
const REFUSED = ['seconds', 'minutes', 'weeks', 'years'];

class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
  }
}

function profile(name) {
  const p = PROFILES[name || 'spec'];
  if (!p) throw new ProfileError(`unknown build profile "${name}"; known: ${Object.keys(PROFILES).join(', ')}`);
  return p;
}

/** `--profile <name>` from argv, or the spec profile. */
function fromArgv(argv = process.argv) {
  const i = argv.indexOf('--profile');
  return profile(i >= 0 ? argv[i + 1] : 'spec');
}

/** Code and non-code (comments, string literals) of a Hyperion source, in order. */
function segments(text) {
  const out = [];
  let i = 0;
  let code = '';
  const flush = () => {
    if (code) out.push({ code: true, text: code });
    code = '';
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    let end = -1;
    if (two === '//') {
      end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
    } else if (two === '/*') {
      end = text.indexOf('*/', i + 2);
      end = end < 0 ? text.length : end + 2;
    } else if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      end = i + 1;
      while (end < text.length && text[end] !== q) end += text[end] === '\\' ? 2 : 1;
      end += 1;
    }
    if (end < 0) {
      code += text[i++];
      continue;
    }
    flush();
    out.push({ code: false, text: text.slice(i, end) });
    i = end;
  }
  flush();
  return out;
}

const LITERAL = /\b(\d[\d_]*)\s+(seconds|minutes|hours|days|weeks|years)\b/g;

/** `{ text, rewrites }`; the spec profile returns the text unchanged. */
function rewriteSource(text, p, file = '<source>') {
  if (p.day === DAY) return { text, rewrites: [] };
  const rewrites = [];
  const out = segments(text)
    .map((s) => {
      if (!s.code) return s.text;
      return s.text.replace(LITERAL, (match, n, unit) => {
        if (REFUSED.includes(unit)) {
          throw new ProfileError(`${file}: "${match}" uses a unit the ${p.name} profile does not scale; write it in days or hours`);
        }
        const seconds = (SCALED[unit] * p.day) / DAY;
        if (!Number.isInteger(seconds)) throw new ProfileError(`${file}: one ${unit} is not a whole number of seconds at the ${p.name} profile`);
        const replacement = `(${n} * ${seconds})`;
        rewrites.push({ file, from: match, to: replacement });
        return replacement;
      });
    })
    .join('');
  return { text: out, rewrites };
}

/** Rewrites a `{ path: { content } }` source map; `skip(path)` exempts a file. */
function rewriteSources(sources, p, skip = () => false) {
  const out = {};
  const rewrites = [];
  for (const [file, { content }] of Object.entries(sources)) {
    if (skip(file)) {
      out[file] = { content };
      continue;
    }
    const r = rewriteSource(content, p, file);
    out[file] = { content: r.text };
    rewrites.push(...r.rewrites);
  }
  return { sources: out, rewrites };
}

module.exports = { PROFILES, profile, fromArgv, rewriteSource, rewriteSources, ProfileError, DAY };
