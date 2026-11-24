// Shared model-tier normalization and official API list-price tables.
// Single source of truth for both Node (usage-index / usage / QuotaEstimator)
// and browser renderers (usage-ui). Pure, serializable, dependency-free.
module.exports = function createPricing() {
  const tierMap = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    med: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    'extra high': 'XHigh',
    max: 'Max',
    thinking: 'Thinking',
    tiered: 'Tiered',
    orchestrator: 'Orchestrator',
  };
  const tierParen = /\s*\((extra[\s-]+high|xhigh|high|medium|med|low|minimal|thinking|max|tiered|orchestrator)\)\s*$/i;
  const tierSuffix = /[\s-]+(extra[\s-]+high|xhigh|high|medium|med|low|minimal|thinking|max|tiered|orchestrator)$/i;
  const orchParen = /^orchestrator\s*\((.+)\)$/i;
  const orchPrefix = /^orchestrator[\s-]+(.+)$/i;
  // Known published Gemini 4 codenames seed bare Orchestrator aliases even if only the
  // Orchestrator entry appears in a slice. Any new codename (e.g. Gemini 4 Krypton or
  // Gemini 5 Helix) is discovered dynamically from observed full names.
  const geminiSeedAliases = new Map([
    ['argon', 'Gemini 4 Argon'],
    ['argon trial', 'Gemini 4 Argon Trial'],
    ['carbon', 'Gemini 4 Carbon'],
    ['hydrogen', 'Gemini 4 Hydrogen'],
    ['neon', 'Gemini 4 Neon'],
  ]);
  const geminiCodename = /^gemini[\s-]+(\d+(?:\.\d+)?)[\s-]+(.+)$/i;
  const geminiGenericTier = /^(?:pro|flash|ultra|nano|lite|mini|exp|experimental|preview|thinking|live)(?:[\s-].*)?$/i;

  function formatModelBase(base) {
    let name = base.trim().replace(/\s+/g, ' ');
    if (!name) return 'Unknown';
    if (!/[A-Z\s]/.test(name) && name.includes('-')) {
      name = name.replace(/(^|-)(\d+)-(\d)(?=$|-)/g, '$1$2.$3').replace(/-/g, ' ');
      name = name
        .split(' ')
        .map(tok => (tok === 'gpt' ? 'GPT' : /^o\d/.test(tok) ? tok : /^[a-z]/.test(tok) ? tok[0].toUpperCase() + tok.slice(1) : tok))
        .join(' ');
    } else if (!/[A-Z\s]/.test(name) && !/^o\d/.test(name) && /^[a-z]/.test(name)) {
      name = name[0].toUpperCase() + name.slice(1);
    } else {
      name = name.replace(/(^|[\s-])(\d+)-(\d)(?=$|[\s-])/g, '$1$2.$3');
    }
    return name;
  }

  const parsedCache = new Map();
  function parseModelBase(raw) {
    const input = String(raw || '').trim();
    const hit = parsedCache.get(input);
    if (hit) return hit;
    let base = input.replace(/-n$/i, '').trim();
    const tiers = [];
    for (let i = 0; i < 3; i++) {
      let m = base.match(tierParen) || base.match(tierSuffix);
      if (m) {
        const rest = base.slice(0, m.index).trim();
        if (!rest) break;
        tiers.unshift(tierMap[m[1].toLowerCase().replace(/[\s-]+/g, ' ')] || m[1]);
        base = rest;
        continue;
      }
      m = base.match(orchParen) || base.match(orchPrefix);
      if (m) {
        const inner = m[1].trim();
        if (!inner) break;
        tiers.unshift('Orchestrator');
        base = inner;
        continue;
      }
      break;
    }
    const fullName = formatModelBase(base);
    let shortName = fullName, shortKey = null, hasPrefix = false;
    const gm = fullName.match(geminiCodename);
    if (gm && /^[a-z]/i.test(gm[2]) && !geminiGenericTier.test(gm[2])) {
      shortName = gm[2];
      shortKey = shortName.toLowerCase();
      hasPrefix = true;
    }
    const key = fullName.toLowerCase();
    const tier = tiers.join(' · ');
    const parsed = { key, name: shortName, fullName, shortKey, hasPrefix, tier, hasDisplay: /[A-Z\s]/.test(base) };
    if (parsedCache.size >= 2048) parsedCache.clear();
    parsedCache.set(input, parsed);
    return parsed;
  }

  function defaultShortAliases() {
    const shortAliases = new Map();
    for (const [sk, fn] of geminiSeedAliases) {
      shortAliases.set(sk, { key: fn.toLowerCase(), name: fn.replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, ''), fullName: fn });
    }
    return { shortAliases, ambiguousShorts: new Set() };
  }

  const seedState = defaultShortAliases();

  function buildShortAliases(rawModels = []) {
    const observed = new Map();
    for (const raw of rawModels) {
      const p = parseModelBase(raw);
      if (!p.hasPrefix || !p.shortKey) continue;
      const cur = observed.get(p.shortKey);
      if (cur === undefined) observed.set(p.shortKey, { key: p.key, name: p.name, fullName: p.fullName });
      else if (cur && cur.key !== p.key) observed.set(p.shortKey, null);
    }
    const shortAliases = new Map();
    const ambiguousShorts = new Set();
    for (const [sk, fn] of geminiSeedAliases) {
      if (!observed.has(sk)) {
        shortAliases.set(sk, { key: fn.toLowerCase(), name: fn.replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, ''), fullName: fn });
      }
    }
    for (const [sk, info] of observed) {
      if (info) shortAliases.set(sk, info);
      else ambiguousShorts.add(sk);
    }
    return { shortAliases, ambiguousShorts };
  }

  function parseModelTier(raw, aliases = seedState) {
    const p = parseModelBase(raw);
    const shortAliases = aliases?.shortAliases || seedState.shortAliases;
    const ambiguousShorts = aliases?.ambiguousShorts || seedState.ambiguousShorts;
    if (!p.hasPrefix) {
      const alias = shortAliases.get(p.key);
      if (alias) return { ...p, key: alias.key, name: alias.name, fullName: alias.fullName };
    } else if (p.shortKey && ambiguousShorts.has(p.shortKey)) {
      return { ...p, name: p.fullName };
    }
    return p;
  }

  // Official global API pricing policy in USD per 1M tokens:
  // base / long: [uncachedInput, cacheRead, cacheWrite, output].
  // All 3 vendors bill thinking/reasoning tokens at the model's output rate with no
  // per-effort surcharge; longAt marks official prompt-length step-ups (>100K/200K/272K).
  function modelPrice(key, date = '') {
    const k = String(key || '').toLowerCase(), d = String(date || '');
    const afterDec26 = d >= '2026-12-01', afterJan27 = d >= '2027-01-01';
    if (/^gemini 4 neon\b/.test(k)) return { base: [3, 0.15, 0, 15], note: 'flat1m' };
    if (/^gemini 4 hydrogen\b/.test(k)) return { base: [1.5, 0.075, 0, 7.5], note: 'flat1m' };
    if (/^gemini 4 (carbon|argon)\b/.test(k)) return afterDec26 ? { base: [4, 0.2, 0, 20], note: 'flat1m' } : { base: [2, 0.1, 0, 10], note: 'intro' };
    if (/^gemini 3\.[678] flash\b/.test(k)) return afterJan27 ? { base: [1.5, 0.15, 0, 7.5] } : { base: [0.75, 0.075, 0, 3.75], note: 'intro' };
    if (/^gemini 3\.5 flash[\s-]lite\b/.test(k)) return { base: [0.3, 0.03, 0, 2.5] };
    if (/^gemini 3\.1 flash[\s-]lite\b/.test(k)) return { base: [0.25, 0.025, 0, 1.5] };
    if (/^gemini 2\.5 flash[\s-]lite\b/.test(k)) return { base: [0.1, 0.01, 0, 0.4] };
    if (/^gemini 2\.5 flash\b/.test(k)) return { base: [0.3, 0.03, 0, 2.5] };
    if (/^gemini 2\.0 flash\b/.test(k)) return { base: [0.1, 0.025, 0, 0.4] };
    if (/^gemini (?:3(?:\.\d+)? )?flash\b/.test(k)) return { base: [0.5, 0.05, 0, 3] };
    if (/^gemini 2\.5 pro\b/.test(k)) return { base: [1.25, 0.125, 0, 10], longAt: 200000, long: [2.5, 0.25, 0, 15] };
    if (/^gemini (?:3(?:\.\d+)? )?pro\b/.test(k)) return { base: [2, 0.2, 0, 12], longAt: 200000, long: [4, 0.4, 0, 18] };
    if (/^claude (?:opus 5\.5|5\.5 opus)\b/.test(k)) return { base: [4, 0.2, 5, 20], note: 'flat1m' };
    if (/^claude (?:sonnet 5\.5|5\.5 sonnet)\b/.test(k)) return { base: [2, 0.1, 2.5, 10], note: 'flat1m' };
    if (/^claude (?:haiku 5\.5|5\.5 haiku)\b/.test(k)) return { base: [0.1, 0.01, 0.125, 0.5], longAt: 100000, long: [0.5, 0.05, 0.625, 2.5] };
    if (/^claude (?:opus 4\.6|4\.6 opus)\b/.test(k)) return { base: [5, 0.5, 6.25, 25], note: 'flat1m' };
    if (/^claude (?:opus 4\.5|4\.5 opus)\b/.test(k)) return { base: [5, 0.5, 6.25, 25] };
    if (/^claude (?:opus (?:3|4(?:\.1)?)|(?:3|4(?:\.1)?) opus)\b/.test(k)) return { base: [15, 1.5, 18.75, 75] };
    if (/^claude opus\b/.test(k)) return { base: [5, 0.5, 6.25, 25] };
    if (/^claude (?:sonnet 4\.6|4\.6 sonnet)\b/.test(k)) return { base: [3, 0.3, 3.75, 15], note: 'flat1m' };
    if (/^claude (?:sonnet|[\d.]+ sonnet)\b/.test(k)) return { base: [3, 0.3, 3.75, 15] };
    if (/^claude (?:haiku 3\.5|3\.5 haiku)\b/.test(k)) return { base: [0.8, 0.08, 1, 4] };
    if (/^claude (?:haiku|[\d.]+ haiku)\b/.test(k)) return { base: [1, 0.1, 1.25, 5] };
    if (/^gpt 5\.4 nano\b/.test(k)) return { base: [0.2, 0.02, 0.2, 1.25] };
    if (/^gpt 5\.4 mini\b/.test(k)) return { base: [0.75, 0.075, 0.75, 4.5] };
    if (/^gpt 5\.4\b/.test(k)) return { base: [2.5, 0.25, 2.5, 15], longAt: 272000, long: [5, 0.5, 5, 22.5] };
    if (/^gpt 5 mini\b/.test(k)) return { base: [0.25, 0.025, 0.25, 2] };
    if (/^gpt 5\b/.test(k)) return { base: [1.25, 0.125, 1.25, 10] };
    if (/^gpt-oss 120b\b/.test(k)) return { base: [0.15, 0.075, 0.15, 0.6] };
    if (/^gpt 4\.1\b/.test(k)) return { base: [2, 0.5, 2, 8] };
    if (/^gpt 4o\b/.test(k)) return { base: [2.5, 1.25, 2.5, 10] };
    if (/^o3 pro\b/.test(k)) return { base: [20, 5, 20, 80] };
    if (/^o3\b/.test(k)) return { base: [2, 0.5, 2, 8] };
    if (/^o4 mini\b/.test(k)) return { base: [1.1, 0.275, 1.1, 4.4] };
    return null;
  }

  function tokenCost(r, p) {
    if (!p) return null;
    const inp = (r.uncached || 0) + (r.cacheRead || 0) + (r.cacheWrite || 0);
    const avgIn = p.longAt && r.requests > 0 ? inp / r.requests : 0;
    const rate = p.long && avgIn > p.longAt ? p.long : p.base;
    return ((r.uncached || 0) * rate[0] + (r.cacheRead || 0) * rate[1] + (r.cacheWrite || 0) * rate[2] + (r.output || 0) * rate[3]) / 1e6;
  }

  function requestCostUsd(row, date = '', aliases = seedState) {
    if (!row) return null;
    const { key } = parseModelTier(row.model, aliases);
    const p = modelPrice(key, date);
    if (!p) return null;
    return tokenCost({
      uncached: row.uncached || 0,
      cacheRead: row.cacheRead ?? row.cache_read ?? 0,
      cacheWrite: row.cacheWrite ?? row.cache_write ?? 0,
      output: row.output || 0,
      requests: 1,
    }, p);
  }

  function quotaFamily(raw) {
    const s = String(raw || '');
    if (/(?:^|[^a-z])argon(?:$|[^a-z])/i.test(s)) return 'gemini-argon';
    if (/gemini|hydrogen|carbon|neon|orchestrator/i.test(s)) return 'gemini';
    if (/claude|sonnet|opus|haiku|anthropic|gpt|openai/i.test(s) || /(?:^|[^a-z0-9])o[134](?:$|[^a-z0-9])/i.test(s) || /^3p(?:$|[-_])/i.test(s)) return '3p';
    return null;
  }

  function shiftDate(date, deltaDays) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().slice(0, 10);
  }

  function computeFamilyRates(days, today, { hasDedicatedArgon = false, aliases = null } = {}) {
    const recentFrom = today ? shiftDate(today, -6) : '';
    const normFam = raw => {
      const f = quotaFamily(raw);
      return f === 'gemini-argon' && !hasDedicatedArgon ? 'gemini' : f;
    };
    const resolvedAliases = aliases || buildShortAliases((days || []).flatMap(d => Object.keys(d?.models || {})));
    const recentPool = {}, allPool = {};
    let recentAllCost = 0, recentAllTok = 0, allCost = 0, totalAllTok = 0;
    for (const day of days || []) {
      const inRecent = recentFrom && day.date >= recentFrom && day.date <= today;
      for (const [rawModel, r] of Object.entries(day.models || {})) {
        const { key: model } = parseModelTier(rawModel, resolvedAliases);
        const p = modelPrice(model, day.date);
        const c = tokenCost(r, p);
        const tok = r.total || 0;
        if (c === null || tok <= 0) continue;
        allCost += c;
        totalAllTok += tok;
        if (inRecent) {
          recentAllCost += c;
          recentAllTok += tok;
        }
        const fam = normFam(model);
        if (fam) {
          const ap = allPool[fam] || (allPool[fam] = { cost: 0, tok: 0 });
          ap.cost += c;
          ap.tok += tok;
          if (inRecent) {
            const rp = recentPool[fam] || (recentPool[fam] = { cost: 0, tok: 0 });
            rp.cost += c;
            rp.tok += tok;
          }
        }
      }
    }
    const fallbackRate = recentAllTok > 0 ? recentAllCost / recentAllTok : (totalAllTok > 0 ? allCost / totalAllTok : null);
    return fam => {
      const normalized = fam === 'gemini-argon' && !hasDedicatedArgon ? 'gemini' : fam;
      const rp = normalized && recentPool[normalized];
      if (rp && rp.tok > 0) return rp.cost / rp.tok;
      const ap = normalized && allPool[normalized];
      if (ap && ap.tok > 0) return ap.cost / ap.tok;
      return fallbackRate;
    };
  }

  return {
    geminiSeedAliases,
    formatModelBase,
    parseModelBase,
    buildShortAliases,
    parseModelTier,
    modelPrice,
    tokenCost,
    requestCostUsd,
    quotaFamily,
    computeFamilyRates,
  };
};
