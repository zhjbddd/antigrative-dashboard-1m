// Hybrid quota full-capacity estimator:
// 1. Differentiated per-window cold-start thresholds (weekly 2% + >=5 reqs, 5h 3% + >=5 reqs, or >=5% standalone)
// 2. Active-cycle monotonic sampling + mid-cycle reset detection + Theil-Sen median slope
// 3. Cross-cycle Empirical Bayes shrinkage with automatic regime-shift bypass for official quota changes
// 4. Primary estimation in equivalent API USD cost space (Δcost / Δu) when priced coverage >= 95%,
//    with seamless token-space fallback for unpriced/unknown models and legacy calibration state.
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
const FILE_NAME = 'quota-calibration-v1.json';
const MAX_ACCOUNTS = 16;
const MAX_WINDOWS = 16;
const MAX_SAMPLES = 40;
const SHIFT_HIGH = 1.45;
const SHIFT_LOW = 0.68;
const RESET_SHIFT_MINUTES = 2;
const MID_CYCLE_BOUNCE_DELTA = 0.005;
const SAMPLE_MIN_STEP = 0.002;
const COST_MIN_PRICED_COVERAGE = 0.95;

const WINDOW_CFG = {
  weekly: {
    coldMinUsed: 0.02,
    coldMinReqs: 5,
    soloMinUsed: 0.05,
    warmMinUsed: 0.01,
    priorShrinkU0: 0.025,
    slopeMinSpan: 0.02,
    slopeMinPairDu: 0.004,
    shiftMinUsed: 0.03,
    shiftMinReqs: 8,
    priorUpdateMinUsed: 0.08,
    priorUpdateMinReqs: 10,
  },
  '5h': {
    coldMinUsed: 0.03,
    coldMinReqs: 5,
    soloMinUsed: 0.05,
    warmMinUsed: 0.015,
    priorShrinkU0: 0.04,
    slopeMinSpan: 0.03,
    slopeMinPairDu: 0.008,
    shiftMinUsed: 0.05,
    shiftMinReqs: 8,
    priorUpdateMinUsed: 0.10,
    priorUpdateMinReqs: 10,
  },
};

function cfgFor(windowKind) {
  return WINDOW_CFG[windowKind] || WINDOW_CFG['5h'];
}

function finitePos(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function roundUsd(n) {
  return Number(n.toFixed(6));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function thinSamples(samples, limit = MAX_SAMPLES) {
  if (samples.length <= limit) return samples;
  const out = [samples[0]];
  const inner = limit - 2;
  const lastIdx = samples.length - 1;
  for (let i = 1; i <= inner; i++) {
    const idx = Math.round((i * lastIdx) / (inner + 1));
    const item = samples[idx];
    if (item && item !== out[out.length - 1]) out.push(item);
  }
  out.push(samples[lastIdx]);
  return out;
}

export function computeTheilSenSlope(samples, livePoint, cfg, valueKey = 't') {
  const pts = [];
  if (Array.isArray(samples)) {
    for (const s of samples) {
      if (s && finitePos(s.u) && finitePos(s[valueKey])) pts.push(s);
    }
  }
  if (livePoint && finitePos(livePoint.u) && finitePos(livePoint[valueKey])) {
    const last = pts[pts.length - 1];
    if (!last || livePoint.u > last.u + 1e-6) pts.push(livePoint);
  }
  if (pts.length < 3) return null;
  const spanU = pts[pts.length - 1].u - pts[0].u;
  if (spanU < cfg.slopeMinSpan) return null;
  const slopes = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const du = pts[j].u - pts[i].u;
      const dv = pts[j][valueKey] - pts[i][valueKey];
      if (du >= cfg.slopeMinPairDu && dv > 0) slopes.push(dv / du);
    }
  }
  return slopes.length >= 2 ? median(slopes) : null;
}

function sanitizeSample(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = Number(raw.t), u = Number(raw.u), r = Number(raw.r || 0);
  if (!Number.isFinite(t) || t < 0 || !Number.isFinite(u) || u <= 0 || u > 1) return null;
  const out = { t: Math.round(t), u: Number(u.toFixed(5)), r: Number.isFinite(r) && r >= 0 ? Math.round(r) : 0 };
  const c = Number(raw.c);
  if (Number.isFinite(c) && c > 0) out.c = roundUsd(c);
  return out;
}

function sanitizeShiftConfirm(raw, valueKey = 't') {
  if (!raw || typeof raw !== 'object') return null;
  const dir = raw.dir === 1 || raw.dir === -1 ? raw.dir : 0;
  const u = Number(raw.u), v = Number(raw[valueKey]), r = Number(raw.r);
  if (!dir || !Number.isFinite(u) || u <= 0 || u > 1 || !Number.isFinite(v) || v < 0 || !Number.isFinite(r) || r < 0) return null;
  return { dir, u: Number(u.toFixed(5)), [valueKey]: valueKey === 'c' ? roundUsd(v) : Math.round(v), r: Math.round(r) };
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const samples = Array.isArray(raw.samples) ? raw.samples.map(sanitizeSample).filter(Boolean).slice(-MAX_SAMPLES) : [];
  const midCycleReset = raw.midCycleReset === true;
  // Legacy v0.9.16 entries with midCycleReset=true lack anchorCostUsd; keep null
  // rather than 0 so pre-anchor cost is never attributed to the post-anchor delta.
  const anchorCostUsd = typeof raw.anchorCostUsd === 'number' && Number.isFinite(raw.anchorCostUsd) && raw.anchorCostUsd >= 0
    ? roundUsd(raw.anchorCostUsd)
    : (midCycleReset ? null : 0);
  return {
    priorFullTokens: finitePos(raw.priorFullTokens) ? Math.round(raw.priorFullTokens) : null,
    priorBaseFullTokens: finitePos(raw.priorBaseFullTokens) ? Math.round(raw.priorBaseFullTokens) : null,
    priorCycles: Number.isSafeInteger(raw.priorCycles) && raw.priorCycles >= 0 ? raw.priorCycles : 0,
    priorFullUsd: finitePos(raw.priorFullUsd) ? roundUsd(raw.priorFullUsd) : null,
    priorBaseFullUsd: finitePos(raw.priorBaseFullUsd) ? roundUsd(raw.priorBaseFullUsd) : null,
    priorUsdCycles: Number.isSafeInteger(raw.priorUsdCycles) && raw.priorUsdCycles >= 0 ? raw.priorUsdCycles : 0,
    resetMinute: Number.isSafeInteger(raw.resetMinute) ? raw.resetMinute : null,
    midCycleReset,
    confirmedShift: raw.confirmedShift === true,
    shiftConfirm: sanitizeShiftConfirm(raw.shiftConfirm, 't'),
    costConfirmedShift: raw.costConfirmedShift === true,
    costShiftConfirm: sanitizeShiftConfirm(raw.costShiftConfirm, 'c'),
    anchorTokens: Number.isFinite(raw.anchorTokens) && raw.anchorTokens >= 0 ? Math.round(raw.anchorTokens) : 0,
    anchorCostUsd,
    anchorUsed: Number.isFinite(raw.anchorUsed) && raw.anchorUsed >= 0 && raw.anchorUsed <= 1 ? Number(raw.anchorUsed.toFixed(5)) : 0,
    anchorReqs: Number.isFinite(raw.anchorReqs) && raw.anchorReqs >= 0 ? Math.round(raw.anchorReqs) : 0,
    samples,
  };
}

function freshEntry(resetMinute = null) {
  return {
    priorFullTokens: null,
    priorBaseFullTokens: null,
    priorCycles: 0,
    priorFullUsd: null,
    priorBaseFullUsd: null,
    priorUsdCycles: 0,
    resetMinute,
    midCycleReset: false,
    confirmedShift: false,
    shiftConfirm: null,
    costConfirmedShift: false,
    costShiftConfirm: null,
    anchorTokens: 0,
    anchorCostUsd: 0,
    anchorUsed: 0,
    anchorReqs: 0,
    samples: [],
  };
}

function estimateSpace({
  samples,
  livePoint,
  valueKey,
  effVal,
  effUsed,
  effReqs,
  midCycleReset,
  canUseRatio,
  cfg,
  prior,
  priorFull,
  priorCycles,
  confirmedShift,
  shiftConfirm,
  allowUpdate,
  roundVal,
}) {
  const ratioEst = canUseRatio && effVal > 0 && effUsed > 0 ? effVal / effUsed : null;
  const slopeEst = computeTheilSenSlope(samples, livePoint, cfg, valueKey);

  let obsEst = null;
  if (midCycleReset) {
    obsEst = slopeEst ?? ratioEst;
  } else if (slopeEst !== null && ratioEst !== null) {
    // If whole-cycle ratio diverges markedly from local incremental slope
    // (e.g. initial offset from another device before local usage began), trust slope.
    const divergence = ratioEst / slopeEst;
    if (divergence < 0.8 || divergence > 1.25) obsEst = slopeEst;
    else obsEst = 0.6 * ratioEst + 0.4 * slopeEst;
  } else {
    obsEst = slopeEst ?? ratioEst;
  }

  let mutated = false;
  let nextConfirmedShift = confirmedShift;
  let nextShiftConfirm = shiftConfirm;
  let nextPriorFull = priorFull;
  let nextPriorCycles = priorCycles;

  const hasPrior = finitePos(prior);
  const standaloneReady = effUsed >= cfg.soloMinUsed || (effUsed >= cfg.coldMinUsed && effReqs >= cfg.coldMinReqs);
  const warmReady = hasPrior && effUsed >= cfg.warmMinUsed && (effVal > 0 || slopeEst !== null);

  let estimatedFull = null;
  if (obsEst !== null && (standaloneReady || warmReady)) {
    if (!hasPrior) {
      estimatedFull = roundVal(obsEst);
    } else {
      const canDetectShift = effUsed >= cfg.shiftMinUsed && effReqs >= cfg.shiftMinReqs && canUseRatio;
      const ratioToPrior = obsEst / prior;
      const shiftDir = ratioToPrior > SHIFT_HIGH ? 1 : (ratioToPrior < SHIFT_LOW ? -1 : 0);
      if (canDetectShift && shiftDir !== 0) {
        if (allowUpdate && !nextConfirmedShift) {
          const sc = nextShiftConfirm;
          if (!sc || sc.dir !== shiftDir) {
            nextShiftConfirm = { dir: shiftDir, u: Number(effUsed.toFixed(5)), [valueKey]: roundVal(effVal), r: Math.round(effReqs) };
            mutated = true;
          } else {
            const du = effUsed - sc.u;
            const dv = effVal - sc[valueKey];
            const dr = effReqs - sc.r;
            if (du >= cfg.slopeMinSpan && dv > 0 && dr >= 4) {
              const segRatio = (dv / du) / prior;
              const segConfirmed = shiftDir === 1 ? segRatio > SHIFT_HIGH : segRatio < SHIFT_LOW;
              if (segConfirmed) {
                nextConfirmedShift = true;
                mutated = true;
              }
            }
          }
        }
        // Immediately follow the observed regime on display without waiting for slow shrinkage.
        estimatedFull = roundVal(obsEst);
      } else {
        // Reading returned within normal prior range -> clear unconfirmed shift marker.
        if (allowUpdate && !nextConfirmedShift && nextShiftConfirm) {
          nextShiftConfirm = null;
          mutated = true;
        }
        const w = effUsed / (effUsed + cfg.priorShrinkU0);
        estimatedFull = roundVal(w * obsEst + (1 - w) * prior);
      }
    }
  }

  // Safely update cross-cycle prior only when post-anchor cycle proves high confidence.
  // Fast learning rate (alpha = 0.65) applies only after non-overlapping shift confirmation.
  if (allowUpdate && obsEst !== null && effUsed >= cfg.priorUpdateMinUsed && effReqs >= cfg.priorUpdateMinReqs) {
    let candidate;
    if (!hasPrior) {
      candidate = roundVal(obsEst);
    } else {
      const alpha = nextConfirmedShift ? 0.65 : 0.30;
      candidate = roundVal(alpha * obsEst + (1 - alpha) * prior);
    }
    if (candidate !== nextPriorFull) {
      nextPriorFull = candidate;
      if (nextPriorCycles === 0 || hasPrior) {
        nextPriorCycles = Math.max(1, nextPriorCycles);
      }
      mutated = true;
    }
  }

  return {
    estimatedFull,
    priorFull: nextPriorFull,
    priorCycles: nextPriorCycles,
    confirmedShift: nextConfirmedShift,
    shiftConfirm: nextShiftConfirm,
    mutated,
  };
}

export class QuotaEstimator {
  constructor(directory = null) {
    this.directory = directory;
    this.accounts = new Map();
    this.loaded = !directory;
    this.loading = null;
    this.dirty = false;
    this.saving = null;
    this.saveTimer = null;
    this.disposed = false;
  }

  filePath() {
    return this.directory ? join(this.directory, FILE_NAME) : null;
  }

  async load() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    const file = this.filePath();
    if (!file) { this.loaded = true; return; }
    this.loading = (async () => {
      try {
        const text = await readFile(file, 'utf8');
        const parsed = JSON.parse(text);
        if (parsed?.version === VERSION && parsed.accounts && typeof parsed.accounts === 'object') {
          for (const [acct, wins] of Object.entries(parsed.accounts).slice(0, MAX_ACCOUNTS)) {
            if (!acct || !wins || typeof wins !== 'object') continue;
            const map = this.accounts.get(acct) || new Map();
            for (const [winId, raw] of Object.entries(wins).slice(0, MAX_WINDOWS)) {
              if (map.has(winId)) continue;
              const entry = sanitizeEntry(raw);
              if (entry) map.set(winId, entry);
            }
            if (map.size) this.accounts.set(acct, map);
          }
        }
      } catch {
        // Missing or unreadable calibration file falls back cleanly to cold start.
      } finally {
        this.loaded = true;
        this.loading = null;
      }
    })();
    return this.loading;
  }

  ensureEntry(accountKey, specId) {
    let acctMap = this.accounts.get(accountKey);
    if (!acctMap) {
      acctMap = new Map();
      this.accounts.set(accountKey, acctMap);
      while (this.accounts.size > MAX_ACCOUNTS) {
        this.accounts.delete(this.accounts.keys().next().value);
      }
    }
    let entry = acctMap.get(specId);
    if (!entry) {
      entry = freshEntry();
      acctMap.set(specId, entry);
      while (acctMap.size > MAX_WINDOWS) {
        acctMap.delete(acctMap.keys().next().value);
      }
    }
    return entry;
  }

  scheduleSave() {
    if (!this.directory || this.disposed) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush({ createDir: false });
    }, 1500);
    this.saveTimer.unref?.();
  }

  serialize() {
    const accounts = {};
    for (const [acct, winMap] of this.accounts) {
      const wins = {};
      for (const [id, entry] of winMap) wins[id] = entry;
      accounts[acct] = wins;
    }
    return JSON.stringify({ version: VERSION, accounts });
  }

  async flush({ createDir = true } = {}) {
    if (!this.directory || !this.dirty) return;
    if (this.saving) return this.saving;
    const file = this.filePath();
    this.dirty = false;
    const payload = this.serialize();
    const tmp = join(this.directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
    this.saving = (async () => {
      try {
        if (createDir) {
          await mkdir(this.directory, { recursive: true });
        } else {
          const info = await stat(this.directory).catch(() => null);
          if (!info?.isDirectory()) return;
        }
        await writeFile(tmp, payload, 'utf8');
        await rename(tmp, file);
      } catch {
        // Best-effort calibration persistence must never break usage summaries.
      } finally {
        this.saving = null;
        if (this.dirty && !this.disposed) this.scheduleSave();
      }
    })();
    return this.saving;
  }

  dispose() {
    this.disposed = true;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  }

  estimate(accountKey, spec, count, { allowUpdate = true, recentUsdPerToken = null } = {}) {
    const usedFraction = typeof spec.remaining === 'number' ? Math.max(0, Math.min(1, 1 - spec.remaining)) : null;
    if (!count || !count.requests || spec.idle || usedFraction === null || usedFraction <= 0 || !finitePos(count.observedTokens)) {
      return {
        observedTokens: count?.observedTokens || 0,
        estimatedFullTokens: null,
        requests: count?.requests || 0,
        usedFraction,
      };
    }

    const hasCostInput = finitePos(count.observedCostUsd);
    const pricedTokens = typeof count.pricedTokens === 'number' && Number.isFinite(count.pricedTokens)
      ? count.pricedTokens
      : (hasCostInput ? count.observedTokens : 0);
    const pricedCoverage = count.observedTokens > 0 ? pricedTokens / count.observedTokens : 0;
    const costEligible = hasCostInput && pricedCoverage >= COST_MIN_PRICED_COVERAGE;

    const cfg = cfgFor(spec.window);
    const entry = accountKey ? this.ensureEntry(accountKey, spec.id) : freshEntry(spec.resetMinute);
    let mutated = false;

    // 1. Detect scheduled/early cycle reset via resetMinute shift.
    if (allowUpdate && entry.resetMinute !== null && Math.abs(entry.resetMinute - spec.resetMinute) > RESET_SHIFT_MINUTES) {
      entry.priorBaseFullTokens = entry.priorFullTokens;
      entry.priorBaseFullUsd = entry.priorFullUsd;
      entry.resetMinute = spec.resetMinute;
      entry.midCycleReset = false;
      entry.confirmedShift = false;
      entry.shiftConfirm = null;
      entry.costConfirmedShift = false;
      entry.costShiftConfirm = null;
      entry.anchorTokens = 0;
      entry.anchorCostUsd = 0;
      entry.anchorUsed = 0;
      entry.anchorReqs = 0;
      entry.samples = [];
      mutated = true;
    } else if (allowUpdate && entry.resetMinute === null) {
      entry.resetMinute = spec.resetMinute;
      entry.priorBaseFullTokens = entry.priorFullTokens;
      entry.priorBaseFullUsd = entry.priorFullUsd;
      mutated = true;
    }

    // 2. Detect sudden mid-cycle quota reset/top-up (remaining jumped UP while resetMinute stayed steady).
    const prevSample = entry.samples[entry.samples.length - 1] || null;
    if (allowUpdate && prevSample && usedFraction < prevSample.u - MID_CYCLE_BOUNCE_DELTA) {
      entry.priorBaseFullTokens = entry.priorFullTokens;
      entry.priorBaseFullUsd = entry.priorFullUsd;
      entry.midCycleReset = true;
      entry.confirmedShift = false;
      entry.shiftConfirm = null;
      entry.costConfirmedShift = false;
      entry.costShiftConfirm = null;
      entry.anchorTokens = Math.round(count.observedTokens);
      entry.anchorCostUsd = costEligible ? roundUsd(count.observedCostUsd) : null;
      entry.anchorUsed = Number(usedFraction.toFixed(5));
      entry.anchorReqs = Math.round(count.requests);
      entry.samples = [{
        t: entry.anchorTokens,
        ...(costEligible ? { c: entry.anchorCostUsd } : {}),
        u: entry.anchorUsed,
        r: entry.anchorReqs,
      }];
      mutated = true;
    }

    // 3. Record monotonic sample points when usedFraction advances meaningfully.
    if (allowUpdate) {
      const last = entry.samples[entry.samples.length - 1] || null;
      const sample = {
        t: Math.round(count.observedTokens),
        ...(costEligible ? { c: roundUsd(count.observedCostUsd) } : {}),
        u: Number(usedFraction.toFixed(5)),
        r: Math.round(count.requests),
      };
      if (!last) {
        entry.samples.push(sample);
        mutated = true;
      } else if (
        sample.u >= last.u + SAMPLE_MIN_STEP &&
        (sample.t > last.t || (costEligible && finitePos(sample.c) && (!finitePos(last.c) || sample.c > last.c)))
      ) {
        entry.samples.push(sample);
        if (entry.samples.length > MAX_SAMPLES) entry.samples = thinSamples(entry.samples, MAX_SAMPLES);
        mutated = true;
      }
    }

    // 4-6. Run estimation in equivalent USD cost space (when priced) and token space (fallback).
    const effTokens = entry.midCycleReset ? Math.max(0, count.observedTokens - entry.anchorTokens) : count.observedTokens;
    const effUsed = entry.midCycleReset ? Math.max(0, usedFraction - entry.anchorUsed) : usedFraction;
    const effReqs = entry.midCycleReset ? Math.max(0, count.requests - entry.anchorReqs) : count.requests;
    const livePoint = {
      t: count.observedTokens,
      ...(costEligible ? { c: count.observedCostUsd } : {}),
      u: usedFraction,
      r: count.requests,
    };

    const tokenRes = estimateSpace({
      samples: entry.samples,
      livePoint,
      valueKey: 't',
      effVal: effTokens,
      effUsed,
      effReqs,
      midCycleReset: entry.midCycleReset,
      canUseRatio: true,
      cfg,
      prior: entry.priorBaseFullTokens,
      priorFull: entry.priorFullTokens,
      priorCycles: entry.priorCycles,
      confirmedShift: entry.confirmedShift,
      shiftConfirm: entry.shiftConfirm,
      allowUpdate,
      roundVal: Math.round,
    });
    if (tokenRes.mutated) {
      entry.priorFullTokens = tokenRes.priorFull;
      entry.priorCycles = tokenRes.priorCycles;
      entry.confirmedShift = tokenRes.confirmedShift;
      entry.shiftConfirm = tokenRes.shiftConfirm;
      mutated = true;
    }

    let estimatedFullUsd = null;
    if (costEligible) {
      const canUseCostRatio = !entry.midCycleReset || entry.anchorCostUsd !== null;
      const effCost = entry.midCycleReset
        ? (entry.anchorCostUsd !== null ? Math.max(0, count.observedCostUsd - entry.anchorCostUsd) : 0)
        : count.observedCostUsd;
      const costRes = estimateSpace({
        samples: entry.samples,
        livePoint,
        valueKey: 'c',
        effVal: effCost,
        effUsed,
        effReqs,
        midCycleReset: entry.midCycleReset,
        canUseRatio: canUseCostRatio,
        cfg,
        prior: entry.priorBaseFullUsd,
        priorFull: entry.priorFullUsd,
        priorCycles: entry.priorUsdCycles,
        confirmedShift: entry.costConfirmedShift,
        shiftConfirm: entry.costShiftConfirm,
        allowUpdate,
        roundVal: roundUsd,
      });
      if (costRes.mutated) {
        entry.priorFullUsd = costRes.priorFull;
        entry.priorUsdCycles = costRes.priorCycles;
        entry.costConfirmedShift = costRes.confirmedShift;
        entry.costShiftConfirm = costRes.shiftConfirm;
        mutated = true;
      }
      estimatedFullUsd = costRes.estimatedFull;
    }

    if (mutated && accountKey) this.scheduleSave();

    const convRate = finitePos(recentUsdPerToken)
      ? recentUsdPerToken
      : (costEligible && count.observedTokens > 0 ? count.observedCostUsd / count.observedTokens : null);
    const estimatedFullTokens = estimatedFullUsd !== null && finitePos(convRate)
      ? Math.round(estimatedFullUsd / convRate)
      : tokenRes.estimatedFull;

    return {
      observedTokens: count.observedTokens,
      ...(costEligible ? { observedCostUsd: roundUsd(count.observedCostUsd) } : {}),
      estimatedFullTokens,
      ...(estimatedFullUsd !== null ? { estimatedFullUsd } : {}),
      requests: count.requests,
      usedFraction,
    };
  }
}
