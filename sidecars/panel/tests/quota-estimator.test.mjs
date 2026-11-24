import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaEstimator } from '../quota-estimator.mjs';

const ACCT = 'a'.repeat(64);
const weeklySpec = (remaining, resetMinute = 29928480) => ({
  id: 'gemini:weekly',
  groupId: 'gemini',
  window: 'weekly',
  remaining,
  idle: remaining >= 1,
  resetMinute,
});
const fiveHSpec = (remaining, resetMinute = 29920000) => ({
  id: 'gemini:5h',
  groupId: 'gemini',
  window: '5h',
  remaining,
  idle: remaining >= 1,
  resetMinute,
});

test('weekly cold start shows at 2% with >=5 requests while 1% stays null', () => {
  const est = new QuotaEstimator();
  // 1% used, 6 requests, no prior -> null
  assert.equal(est.estimate(ACCT, weeklySpec(0.99), { observedTokens: 12_000_000, requests: 6 }).estimatedFullTokens, null);
  // 2% used, only 3 requests -> null (prevents single-request noise)
  assert.equal(est.estimate(ACCT, weeklySpec(0.98), { observedTokens: 24_000_000, requests: 3 }).estimatedFullTokens, null);
  // 2% used, 5 requests -> displays ~1.2B
  const at2 = est.estimate(ACCT, weeklySpec(0.98), { observedTokens: 24_000_000, requests: 5 });
  assert.equal(at2.estimatedFullTokens, 1_200_000_000);
  // 4.1% used (like user screenshot: 46.5M / 0.041) -> displays ~1.13B
  const at41 = est.estimate(ACCT, weeklySpec(0.959), { observedTokens: 46_500_000, requests: 40 });
  assert.ok(at41.estimatedFullTokens >= 1_100_000_000 && at41.estimatedFullTokens <= 1_200_000_000, `got ${at41.estimatedFullTokens}`);
});

test('cross-cycle Empirical Bayes warm start smooths 1% estimates after a scheduled reset', () => {
  const est = new QuotaEstimator();
  // Cycle 1 reaches high confidence (>=8%, >=10 reqs) at true full = 1.2B
  est.estimate(ACCT, weeklySpec(0.90, 29920000), { observedTokens: 120_000_000, requests: 30 });
  // Cycle 2 begins (new resetMinute) with a noisy early 1% reading (raw = 1.5B)
  const warm = est.estimate(ACCT, weeklySpec(0.99, 29930080), { observedTokens: 15_000_000, requests: 3 });
  assert.ok(warm.estimatedFullTokens !== null, 'warm start should display at 1%');
  // w = 0.01 / (0.01 + 0.025) = 0.2857 -> ~1.286B (pulled smoothly toward 1.2B prior, not jumping to 1.5B)
  assert.ok(warm.estimatedFullTokens >= 1_250_000_000 && warm.estimatedFullTokens <= 1_320_000_000, `got ${warm.estimatedFullTokens}`);
});

test('sudden mid-cycle quota reset isolates pre-reset tokens and preserves prior integrity', () => {
  const est = new QuotaEstimator();
  // Establish stable 1.0B prior in cycle 1
  est.estimate(ACCT, weeklySpec(0.85, 29920000), { observedTokens: 150_000_000, requests: 40 });
  // Cycle 2 runs to 40% (400M toks), then provider suddenly resets remaining back to 98% within same resetMinute!
  est.estimate(ACCT, weeklySpec(0.60, 29930080), { observedTokens: 400_000_000, requests: 120 });
  // Immediately after bounce (remaining=0.99, observedTokens still includes 400M from earlier in window)
  const bounced = est.estimate(ACCT, weeklySpec(0.99, 29930080), { observedTokens: 400_000_000, requests: 120 });
  assert.equal(bounced.estimatedFullTokens, null, 'zero post-reset delta should not emit inflated 40B estimate');
  // Now user consumes 3% post-reset (30M additional tokens -> total observedTokens 430M, remaining 0.96)
  est.estimate(ACCT, weeklySpec(0.98, 29930080), { observedTokens: 410_000_000, requests: 124 });
  est.estimate(ACCT, weeklySpec(0.97, 29930080), { observedTokens: 420_000_000, requests: 128 });
  const postReset = est.estimate(ACCT, weeklySpec(0.96, 29930080), { observedTokens: 430_000_000, requests: 132 });
  // Post-reset estimate must stay ~1.0B, NOT 430M / 0.04 = 10.75B!
  assert.ok(postReset.estimatedFullTokens >= 950_000_000 && postReset.estimatedFullTokens <= 1_050_000_000, `got ${postReset.estimatedFullTokens}`);
});

test('regime-shift detection bypasses display immediately and requires non-overlapping confirmation to rewrite prior fast', () => {
  const est = new QuotaEstimator();
  // Cycle 1: true full = 1.0B
  est.estimate(ACCT, weeklySpec(0.85, 29920000), { observedTokens: 150_000_000, requests: 50 });

  // Cycle 2: Official provider CUTS quota in half (true full = 500M)
  // First out-of-bounds reading at 4% (10 reqs): display immediately follows 500M, but shift is not yet confirmed
  const cut1 = est.estimate(ACCT, weeklySpec(0.96, 29930080), { observedTokens: 20_000_000, requests: 10 });
  assert.equal(cut1.estimatedFullTokens, 500_000_000);
  // Second non-overlapping increment (+3% = 15M tokens, +6 reqs -> total 7%, 35M, 16 reqs) confirms same direction
  const cut2 = est.estimate(ACCT, weeklySpec(0.93, 29930080), { observedTokens: 35_000_000, requests: 16 });
  assert.equal(cut2.estimatedFullTokens, 500_000_000);
  // Reaching 10% (25 reqs) now writes prior with fast alpha = 0.65 -> 0.65*500M + 0.35*1000M = 675M
  est.estimate(ACCT, weeklySpec(0.90, 29930080), { observedTokens: 50_000_000, requests: 25 });
  assert.equal(est.accounts.get(ACCT).get('gemini:weekly').priorFullTokens, 675_000_000);

  // Cycle 3: Single transient spike at 4% (raw = 2.0B) that later reverts to normal ~700M by 10%
  // MUST NOT unlock fast alpha = 0.65 prior rewrite!
  const spike = est.estimate(ACCT, weeklySpec(0.96, 29940160), { observedTokens: 80_000_000, requests: 10 });
  assert.equal(spike.estimatedFullTokens, 2_000_000_000, 'display responds while anomalous');
  // Later returns to normal ~700M at 10% (70M tokens -> ratio 700/675 = 1.037, inside normal range)
  est.estimate(ACCT, weeklySpec(0.90, 29940160), { observedTokens: 70_000_000, requests: 25 });
  assert.equal(est.accounts.get(ACCT).get('gemini:weekly').confirmedShift, false, 'transient reverted spike must not confirm shift');
});

test('mid-cycle reset resets request counter anchor too (pre-reset requests cannot satisfy post-reset thresholds)', () => {
  // Case A: No prior yet; bounce from 6% -> 4% after 120 pre-reset requests.
  const estA = new QuotaEstimator();
  estA.estimate(ACCT, weeklySpec(0.94, 29930080), { observedTokens: 60_000_000, requests: 120 });
  estA.estimate(ACCT, weeklySpec(0.96, 29930080), { observedTokens: 60_000_000, requests: 120 });
  // Post-reset: +2% used and ONLY +2 post-reset requests (total 122, but effReqs = 2 < 5)
  const tooFewReqs = estA.estimate(ACCT, weeklySpec(0.94, 29930080), { observedTokens: 80_000_000, requests: 122 });
  assert.equal(tooFewReqs.estimatedFullTokens, null, 'pre-reset 120 requests must not satisfy post-reset coldMinReqs=5');
  // Once post-reset reaches +5 requests (total 125) at +2% used -> displays exact post-anchor 1.0B
  const enoughReqs = estA.estimate(ACCT, weeklySpec(0.94, 29930080), { observedTokens: 80_000_000, requests: 125 });
  assert.equal(enoughReqs.estimatedFullTokens, 1_000_000_000);

  // Case B: With 1.0B prior; bounce from 40% -> 30% after 120 pre-reset requests.
  // Post-reset +3% with only +2 reqs (effReqs = 2 < 8) at 2x raw (2.0B) must NOT bypass prior via shift check!
  const estB = new QuotaEstimator();
  estB.estimate(ACCT, weeklySpec(0.60, 29930080), { observedTokens: 400_000_000, requests: 120 });
  estB.estimate(ACCT, weeklySpec(0.70, 29930080), { observedTokens: 400_000_000, requests: 120 });
  const shrunk = estB.estimate(ACCT, weeklySpec(0.67, 29930080), { observedTokens: 460_000_000, requests: 122 });
  // Because effUsed = 0.03 and effReqs = 2 (< 8), it blends 0.03/(0.03+0.025)=0.545 with 1.0B prior (~1.545B), NOT 2.0B!
  assert.ok(shrunk.estimatedFullTokens < 1_700_000_000, `pre-reset reqs must not unlock shift bypass, got ${shrunk.estimatedFullTokens}`);
});

test('Theil-Sen robust slope corrects missing foreign-device initial offset and resists outliers', () => {
  const est = new QuotaEstimator();
  // User spent 30% on another machine/cloud before starting locally (observedTokens=5M while used=30%)
  // Then locally uses +1% per 10M tokens (true full = 1.0B)
  est.estimate(ACCT, weeklySpec(0.70, 29928480), { observedTokens: 5_000_000, requests: 2 });
  est.estimate(ACCT, weeklySpec(0.69, 29928480), { observedTokens: 15_000_000, requests: 6 });
  est.estimate(ACCT, weeklySpec(0.68, 29928480), { observedTokens: 25_000_000, requests: 10 });
  const res = est.estimate(ACCT, weeklySpec(0.67, 29928480), { observedTokens: 35_000_000, requests: 14 });
  // Raw T/u = 35M / 0.33 = 106M (severely underestimated!), but Theil-Sen slope = 10M / 0.01 = 1.0B!
  assert.equal(res.estimatedFullTokens, 1_000_000_000);
});

test('calibration state persists atomically across restarts and does not self-shrink cycle 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-quota-est-'));
  try {
    const est1 = new QuotaEstimator(dir);
    await est1.load();
    // Cycle 1 reaches 10% (5h window) -> exact standalone estimate (no self-shrinkage)
    const r1 = est1.estimate(ACCT, fiveHSpec(0.90, 29920000), { observedTokens: 30_000_000, requests: 15 });
    assert.equal(r1.estimatedFullTokens, 300_000_000);
    // Still cycle 1 at 20% with shifted workload (400M full): no self-shrinkage against cycle 1 itself
    const r2 = est1.estimate(ACCT, fiveHSpec(0.80, 29920000), { observedTokens: 80_000_000, requests: 30 });
    assert.equal(r2.estimatedFullTokens, 400_000_000);
    await est1.flush();
    est1.dispose();

    // Restart into a fresh estimator instance loading from disk, then enter cycle 2 at 2%
    const est2 = new QuotaEstimator(dir);
    await est2.load();
    const warm = est2.estimate(ACCT, fiveHSpec(0.98, 29920300), { observedTokens: 8_000_000, requests: 4 });
    // Warm-start on 5h (>=1.5% with 400M prior) -> smooth ~400M
    assert.equal(warm.estimatedFullTokens, 400_000_000);
    est2.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cost-space Theil-Sen stays accurate across Hydrogen->Neon switch and avoids false shift alerts (Issue #21)', () => {
  const est = new QuotaEstimator();
  // Cycle 1 establishes a ~$98 USD prior using cheap Hydrogen ($0.539/M -> ~182M tok full)
  est.estimate(ACCT, weeklySpec(0.85, 29920000), {
    observedTokens: 27_300_000,
    observedCostUsd: 14.70,
    pricedTokens: 27_300_000,
    requests: 40,
  });

  // Cycle 2: Front segment uses Hydrogen ($0.539/M -> $101.32/full); back segment switches to Neon ($0.664/M -> $93.83/full)
  const samples = [
    [0.95, 9_400_000, 5.07, 12],
    [0.90, 18_800_000, 10.13, 24],
    [0.85, 28_200_000, 15.20, 36],
    [0.7704, 43_170_000, 23.26, 55],
    // Switch to Neon (token slope drops ~25%, USD slope stays ~$94)
    [0.72, 50_300_000, 27.99, 70],
    [0.65, 60_200_000, 34.56, 90],
    [0.5543, 73_730_000, 43.53, 120],
  ];
  let last;
  for (const [rem, tok, cost, reqs] of samples) {
    last = est.estimate(ACCT, weeklySpec(rem, 29930080), {
      observedTokens: tok,
      observedCostUsd: cost,
      pricedTokens: tok,
      requests: reqs,
    }, { recentUsdPerToken: 0.595 / 1e6 });
  }
  // True full USD is ~$94-$101 (NOT ~$82.99 from token-slope * 7d-rate mismatch!)
  assert.ok(last.estimatedFullUsd >= 92 && last.estimatedFullUsd <= 103, `expected ~$94-$101, got ${last.estimatedFullUsd}`);
  assert.equal(last.estimatedFullTokens, Math.round(last.estimatedFullUsd / (0.595 / 1e6)));
  assert.equal(est.accounts.get(ACCT).get('gemini:weekly').costConfirmedShift, false, 'Model switch must not confirm a quota shift in USD space');
});

test('cost-space ignores legacy midCycleReset without anchorCostUsd and falls back cleanly until post-upgrade slope is ready', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ag-quota-legacy-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    // Simulate a v0.9.16 calibration file mid-cycle after a bounce (has anchorTokens but no anchorCostUsd)
    await writeFile(join(dir, 'quota-calibration-v1.json'), JSON.stringify({
      version: 1,
      accounts: {
        [ACCT]: {
          'gemini:weekly': {
            priorFullTokens: 160_000_000,
            priorBaseFullTokens: 160_000_000,
            priorCycles: 1,
            resetMinute: 29930080,
            midCycleReset: true,
            confirmedShift: false,
            shiftConfirm: null,
            anchorTokens: 43_170_000,
            anchorUsed: 0.2296,
            anchorReqs: 60,
            samples: [
              { t: 43_170_000, u: 0.2296, r: 60 },
              { t: 55_000_000, u: 0.30, r: 80 },
            ],
          },
        },
      },
    }));
    const est = new QuotaEstimator(dir);
    await est.load();
    // First poll after upgrade: only 1 cost-tagged point -> must NOT compute inflated $43.53 / 0.216 = $201!
    const r1 = est.estimate(ACCT, weeklySpec(0.5543, 29930080), {
      observedTokens: 73_730_000,
      observedCostUsd: 43.53,
      pricedTokens: 73_730_000,
      requests: 120,
    });
    assert.equal(r1.estimatedFullUsd, undefined, 'Legacy midCycleReset without anchorCostUsd must not emit inflated cost ratio');
    assert.ok(r1.estimatedFullTokens > 100_000_000 && r1.estimatedFullTokens < 200_000_000);

    // After 2 more post-upgrade monotonic cost points spanning >= 2%, Theil-Sen cost slope activates cleanly (~$95)
    est.estimate(ACCT, weeklySpec(0.54, 29930080), { observedTokens: 75_800_000, observedCostUsd: 44.89, pricedTokens: 75_800_000, requests: 125 });
    const r3 = est.estimate(ACCT, weeklySpec(0.525, 29930080), { observedTokens: 78_000_000, observedCostUsd: 46.32, pricedTokens: 78_000_000, requests: 132 });
    assert.ok(r3.estimatedFullUsd >= 90 && r3.estimatedFullUsd <= 102, `expected ~$95 cost slope, got ${r3.estimatedFullUsd}`);
    est.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unpriced or partially priced windows fall back to token space without polluting USD prior', () => {
  const est = new QuotaEstimator();
  // Establish $100 USD prior in cycle 1
  est.estimate(ACCT, weeklySpec(0.85, 29920000), { observedTokens: 150_000_000, observedCostUsd: 15.0, pricedTokens: 150_000_000, requests: 30 });
  // Cycle 2 has 50% unpriced tokens -> must fall back to token space and keep priorFullUsd intact
  const res = est.estimate(ACCT, weeklySpec(0.90, 29930080), { observedTokens: 100_000_000, observedCostUsd: 5.0, pricedTokens: 50_000_000, requests: 20 });
  assert.equal(res.estimatedFullUsd, undefined);
  assert.equal(res.observedCostUsd, undefined);
  assert.ok(res.estimatedFullTokens > 0);
  assert.equal(est.accounts.get(ACCT).get('gemini:weekly').priorFullUsd, 100);
});
