import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const liveJsPath = join(root, 'public', 'polymarket-live.js');
const liveHtmlPath = join(root, 'public', 'polymarket.html');

test('polymarket-live.js passes node syntax check', () => {
  const result = spawnSync(process.execPath, ['--check', liveJsPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'syntax check failed');
});

test('polymarket-live.js groups live orders without wallet-follow UI', () => {
  const source = readFileSync(liveJsPath, 'utf8');
  assert.match(source, /return \['plan9', 'plan8', 'plan5', 'plan4', 'plan3_6', 'plan3', 'plan13', 'plan12', 'plan11', 'plan2_6', 'plan2_5', 'plan2', 'plan1'\]/);
  assert.match(source, /plan2_5:\s*'Plan2\.5'/);
  assert.match(source, /plan11:\s*'Plan11'/);
  assert.match(source, /plan12:\s*'Plan12'/);
  assert.match(source, /function indexFilledStopLossSells/);
  assert.match(source, /function relatedStopSellForBuy/);
  assert.match(source, /止损卖出 \$\{fillTxt\}（线 \$\{linePct\.toFixed\(0\)\}%）/);
  assert.match(source, /function liveOrderCostBasis/);

  assert.match(source, /function isDustClosedLiveOrder/);
  assert.match(source, /灰尘仓/);
  assert.match(source, /持仓 · 已买入/);
  assert.match(source, /低于 \$\{minimum\} 份自动卖出门槛/);
  assert.match(source, /\.filter\(\(order\) => !shouldHideLiveOrderRow\(order\)\)/);
  assert.match(source, /function isNoisyStructuralBlockedBuy/);
  assert.match(source, /余额\\\/敞口不够最小单/);
  assert.match(source, /plan3_6:\s*'Plan3\.6'/);
  assert.match(source, /plan4:\s*'Plan4'/);
  assert.doesNotMatch(source, /togglePlan4Live/);
  assert.doesNotMatch(source, /\/api\/polymarket\/plan[489]\/live/);
  assert.doesNotMatch(source, /api\/polymarket\/\$\{planId\}\/live/);
  assert.doesNotMatch(source, /WALLET_FOLLOW_PLANS/);
  assert.doesNotMatch(source, /\/api\/polymarket\/wallet-follow/);
  assert.doesNotMatch(source, /输入地址跟单/);
  assert.match(source, /Historical wallet-follow orders keep plan4 attribution/);
  assert.match(source, /live-auto\/symbols/);
  assert.match(source, /liveSymbolSyncGuard/);
  assert.match(source, /plan8:\s*'Plan8'/);
  assert.match(source, /plan9:\s*'Plan9'/);
  assert.doesNotMatch(source, /for \(const planId of auto\.enabledPlans \|\| \[\]\) \{\s*await postJson\('\/api\/polymarket\/live-auto\/start'/);
  assert.equal((source.match(/function shortSymbol\(/g) || []).length, 1);
});

test('polymarket-live.js prefers planRuns status over heavy live-plan preview timeouts', () => {
  const source = readFileSync(liveJsPath, 'utf8');
  assert.match(source, /function renderLivePlanRunStatusCard/);
  assert.match(source, /function formatLivePreviewFetchError/);
  assert.match(source, /预览超时（策略仍在后台跑/);
  assert.match(source, /auto\.planRuns\?\.\[planId\]/);
  assert.match(source, /timeoutMs:\s*20000/);
  assert.match(source, /if \(planId === 'plan1'\) continue/);
  assert.doesNotMatch(source, /WALLET_FOLLOW_PLANS/);
});

test('polymarket.html has no wallet-follow toggle or leader form', () => {
  const html = readFileSync(liveHtmlPath, 'utf8');
  assert.doesNotMatch(html, /data-plan-id="plan11"/);
  assert.match(html, /当前没有已批准的实盘策略/);
  for (const retired of ['plan1', 'plan2_6', 'plan3_5', 'plan4', 'plan6', 'plan8', 'plan9', 'plan11', 'plan12', 'plan13', 'plan14']) {
    assert.doesNotMatch(html, new RegExp(`data-plan-id="${retired}"`));
  }
  assert.doesNotMatch(html, /跟单/);
  assert.doesNotMatch(html, /pmLiveFollowLeaders/);
  assert.doesNotMatch(html, /Plan6 Leader/);
  assert.doesNotMatch(html, /polymarket-plan(4|8|9|10)\.html/);
  assert.match(html, /不会在启动服务时偷偷开启/);
  assert.match(html, /pmLiveAutoStopAll/);
  assert.match(html, /Plan14 仅模拟盘/);
});

test('live-auto start/stop does not block UI on readiness or sync tick', () => {
  const liveJs = readFileSync(liveJsPath, 'utf8');
  assert.match(liveJs, /data\.deferredTick/);
  assert.match(liveJs, /首轮检查后台进行中/);
  assert.doesNotMatch(
    liveJs,
    /await Promise\.all\(\[refreshLiveOrders\(\), refreshReadiness\(\), refreshStatus\(\)\]\)/
  );

  const server = readFileSync(join(root, 'server.js'), 'utf8');
  assert.match(server, /live-auto\/start[\s\S]*?deferredTick:\s*true/);
  assert.match(server, /live-auto\/symbols/);
  assert.match(server, /setLiveAutoSymbols/);
  assert.doesNotMatch(server, /runPolymarketLiveFollowAutoLoop/);
  assert.doesNotMatch(server, /wallet-follow/);
  assert.doesNotMatch(server, /buildPolymarketPaperPlan4/);
  assert.doesNotMatch(server, /PolymarketPlan(4|8|9|10)Engine/);
  assert.doesNotMatch(server, /runPolymarketPlan(4|8|9|10)Loop/);
  assert.doesNotMatch(server, /\/api\/polymarket\/plan(4|8|9|10)\b/);
  assert.match(server, /POLYMARKET_PAPER_CORE_PLAN_IDS = \['plan14'\]/);
  assert.match(server, /POLYMARKET_LIVE_CORE_PLAN_IDS = \[\]/);
  assert.doesNotMatch(
    server,
    /live-auto\/start[\s\S]{0,400}?const tick = await runPolymarketLiveAutoTick\(\)/
  );
});

test('paper page shows Plan14 and Plan15', () => {
  const html = readFileSync(join(root, 'public', 'polymarket-paper.html'), 'utf8');
  const analyticsHtml = readFileSync(join(root, 'public', 'polymarket-analytics.html'), 'utf8');
  const js = readFileSync(join(root, 'public', 'polymarket-paper.js'), 'utf8');
  assert.match(html, /data-plan-tab="plan14"/);
  assert.match(html, /data-plan="plan14"/);
  const tabs = [...html.matchAll(/data-plan-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19']);
  for (const retired of ['plan1', 'plan2', 'plan2_5', 'plan2_6', 'plan11', 'plan12', 'plan13']) {
    assert.doesNotMatch(html, new RegExp(`data-plan-tab="${retired}"`));
    assert.doesNotMatch(html, new RegExp(`data-plan="${retired}"`));
  }
  assert.doesNotMatch(analyticsHtml, /data-plan-tab="plan3_5"/);
  const analyticsTabs = [...analyticsHtml.matchAll(/data-plan-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(analyticsTabs, ['current', 'plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19']);
  assert.doesNotMatch(html, /href="\/polymarket-plan(4|7|8|9|10)\.html"/);
  assert.doesNotMatch(html, /跟单/);
  assert.match(js, /PAPER_PLAN_IDS = \['plan14', 'plan15', 'plan16', 'plan17', 'plan18', 'plan19'\]/);
  assert.doesNotMatch(js, /plan3_5/);
  assert.doesNotMatch(js, /plan3-events/);
  assert.doesNotMatch(js, /THREE_COIN/);
  assert.doesNotMatch(js, /WALLET_FOLLOW_PLANS/);
  assert.doesNotMatch(js, /plan6: 'Plan6/);
  assert.doesNotMatch(js, /pmPlan7Equity/);
  const check = spawnSync(process.execPath, ['--check', join(root, 'public', 'polymarket-paper.js')], {
    encoding: 'utf8'
  });
  assert.equal(check.status, 0, check.stderr || 'paper.js syntax check failed');
});

test('polymarketPlan2.js has no duplicate cross-symbol exports', () => {
  const source = readFileSync(join(root, 'src', 'polymarketPlan2.js'), 'utf8');
  const check = spawnSync(process.execPath, ['--check', join(root, 'src', 'polymarketPlan2.js')], {
    encoding: 'utf8'
  });
  assert.equal(check.status, 0, check.stderr || 'plan2 syntax check failed');
  assert.equal((source.match(/export function applyCrossSymbolLeaderToDirection/g) || []).length, 1);
  assert.equal((source.match(/export function buildPlan2CrossFollowTier/g) || []).length, 1);
});

test('server and plan3 pass syntax check after plan2_5 split', () => {
  for (const rel of ['server.js', 'src/polymarketPlan3.js', 'src/polymarketTrading.js']) {
    const file = join(root, rel);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${rel}: ${check.stderr || 'syntax check failed'}`);
  }
  const server = readFileSync(join(root, 'server.js'), 'utf8');
  assert.equal((server.match(/import \{ createStatsDb \}/g) || []).length, 1);
  const plan3 = readFileSync(join(root, 'src', 'polymarketPlan3.js'), 'utf8');
  assert.equal((plan3.match(/export function evaluatePlan3BandStatsGate/g) || []).length, 1);
});
