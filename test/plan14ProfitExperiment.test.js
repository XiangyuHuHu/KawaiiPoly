import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolymarketPaperPlan14, evaluatePlan14Entry, PLAN14_VERSION, PLAN14_PROFIT_EXPERIMENT_VERSION } from '../src/polymarketPlan14.js';
import { createPlan14ProfitExperiment, observePlan14ProfitExperiment as observeAll, resolvePlan14ProfitExperiment,
  releasePlan14ProfitExperiment as releaseAll, summarizePlan14ProfitExperiment } from '../src/plan14ProfitExperiment.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// Existing policy assertions remain independent of the additional matched controls.
const observePlan14ProfitExperiment = (...args) => observeAll(...args).filter(e => !e.order.lane.endsWith('Control'));
const releasePlan14ProfitExperiment = (...args) => releaseAll(...args).filter(e => !e.order.lane.endsWith('Control'));
const policyLanes = state => Object.entries(state.lanes).filter(([key]) => !key.endsWith('Control')).map(([, lane]) => lane);
const nowMs = Date.parse('2099-01-10T00:01:00Z'), targetMs = nowMs + 240000;
const sentiment = { available: true, marketSlug: 'btc-test', upPrice:.5, downPrice:.5, upBestAsk:.51, downBestAsk:.51 };
const signal = { symbol:'BTC-USD', prediction:{targetTimeIso:new Date(targetMs).toISOString(),comparisonBasePrice:100},
  schedule:{currentSlotIso:'2099-01-10T00:00:00Z',nextSlotIso:new Date(targetMs).toISOString(),secondsToNext:240},
  indicators:{currentPrice:100.1,volatility15mPct:.001,currentQuoteTime:nowMs} };
const book = {up:{bid:.49,ask:.51,asks:[{price:.51,size:100}],bookTimeMs:nowMs},
  down:{bid:.49,ask:.51,asks:[{price:.51,size:100}],bookTimeMs:nowMs}};
const plan = () => buildPolymarketPaperPlan14({signal,sentiment,plan14Book:book,now:new Date(nowMs),portfolio:{cash:500,portfolioInitialized:true}});
const close = (a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('candidate changes only its estimate/entry; default v9 action and sizing are unchanged',()=>{
  const p=plan(),base=evaluatePlan14Entry({signal,sentiment,book,now:new Date(nowMs)});
  assert.equal(p.strategyVersion,PLAN14_VERSION);
  assert.equal(p.profitExperiment.candidate.model.policyVersion,PLAN14_PROFIT_EXPERIMENT_VERSION);
  assert.deepEqual(p.decision, {...base,reason:p.decision.reason});
  assert.equal(p.action.limitPrice,base.selected.ask);
  assert.equal(p.profitExperiment.candidate.model.modelWeight,.4);
  assert.equal(p.profitExperiment.candidate.model.temperature,.85);
  assert.ok(p.profitExperiment.candidate.selected.p > base.selected.p);
});

test('candidate compares both real asks, rejects flat/no-fee-edge and stale evidence',()=>{
  const flat={...signal,indicators:{...signal.indicators,currentPrice:100}};
  const d=evaluatePlan14Entry({signal:flat,sentiment,book,now:new Date(nowMs),policyVersion:PLAN14_PROFIT_EXPERIMENT_VERSION});
  assert.equal(d.allowed,false);
  const stale={...book,down:{...book.down,bookTimeMs:nowMs-11000}};
  assert.equal(evaluatePlan14Entry({signal,sentiment,book:stale,now:new Date(nowMs),policyVersion:PLAN14_PROFIT_EXPERIMENT_VERSION}).skipReason,'stale_book');
  const pre=evaluatePlan14Entry({signal,sentiment,now:new Date(nowMs),policyVersion:PLAN14_PROFIT_EXPERIMENT_VERSION});
  assert.equal(pre.allowed,false);assert.equal(pre.prescreen,true);
});

test('candidate can independently buy a cheap side and never synthesizes ask from the opposite ask',()=>{
  const neutral={...signal,indicators:{...signal.indicators,currentPrice:100}};
  const cheap={up:{bid:.14,ask:.16,bookTimeMs:nowMs},down:{bid:.84,ask:.86,bookTimeMs:nowMs}};
  const args={signal:neutral,sentiment,book:cheap,now:new Date(nowMs)};
  assert.equal(evaluatePlan14Entry(args).allowed,false);
  const d=evaluatePlan14Entry({...args,policyVersion:PLAN14_PROFIT_EXPERIMENT_VERSION});
  assert.equal(d.allowed,true);assert.equal(d.selected.direction,'up');assert.equal(d.selected.ask,.16);
  assert.notEqual(d.selected.ask,1-cheap.down.ask);
  assert.ok(d.selected.cost>d.selected.ask);assert.ok(d.selected.edge>=.01);
});

test('temperature estimate is direction symmetric without altering the default normalized blend',()=>{
  const upBook={up:{bid:.69,ask:.71,bookTimeMs:nowMs},down:{bid:.29,ask:.31,bookTimeMs:nowMs}};
  const args={sentiment,now:new Date(nowMs),policyVersion:PLAN14_PROFIT_EXPERIMENT_VERSION};
  const a=evaluatePlan14Entry({...args,signal,book:upBook});
  const mirror={...signal,indicators:{...signal.indicators,currentPrice:10000/100.1}};
  const b=evaluatePlan14Entry({...args,signal:mirror,book:{up:upBook.down,down:upBook.up}});
  close(a.model.blendedUp+b.model.blendedUp,1);
  assert.equal(a.selected.direction,'up');assert.equal(b.selected.direction,'down');
});

test('four independent funded lanes debit cash, pay fees, preserve one coin/window and stress fills',()=>{
  const s=createPlan14ProfitExperiment(nowMs),p=plan();
  assert.equal(observePlan14ProfitExperiment(s,p,sentiment,nowMs).length,4);
  assert.equal(observePlan14ProfitExperiment(s,p,sentiment,nowMs).length,0);
  for(const lane of policyLanes(s)){assert.equal(lane.cash,490);assert.equal(lane.filled,1);assert.equal(lane.invested,10);}
  const a=s.lanes.baseline.open[0],b=s.lanes.baselineStress.open[0];
  close(a.shares,10/.51*(1-.07*(1-.51)));close(b.ask,.52);assert.ok(b.shares<a.shares);
  const other={...p,symbol:'ETH-USD'};
  assert.equal(observePlan14ProfitExperiment(s,other,{...sentiment,marketSlug:'eth-test'},nowMs).length,4);
});

test('experiment walks sorted real asks for $10 and records consumed depth and per-level fees',()=>{
  const depth=[{price:'0.60',size:'100'},{price:'0.51',size:'4'},
    {price:0,size:10},{price:.4,size:-1},{price:'bad',size:50}];
  const p=buildPolymarketPaperPlan14({signal,sentiment,now:new Date(nowMs),
    plan14Book:{...book,up:{...book.up,asks:depth}}});
  const s=createPlan14ProfitExperiment(nowMs);
  assert.equal(observePlan14ProfitExperiment(s,p,sentiment,nowMs).length,4);
  const o=s.lanes.baseline.open[0],shares=4+(10-4*.51)/.6;
  close(o.avgFillPrice,10/shares);close(o.ask,o.avgFillPrice);
  assert.equal(o.latencyPenalty,0);assert.equal(o.depthUsed.length,2);
  assert.deepEqual(o.depthUsed[0],{price:.51,fillPrice:.51,shares:4,usd:2.04});
  close(o.depthUsed[1].shares,(10-2.04)/.6);
  close(o.depthUsed.reduce((sum,l)=>sum+l.usd,0),10);
  close(o.feeUsd,.069972+.22288);
  close(o.shares,shares-.069972/.51-.22288/.6);
  assert.ok(s.lanes.baselineStress.open[0].avgFillPrice>o.avgFillPrice);
});

test('latency cents are adverse on the selected down asks and stack with stress slippage',()=>{
  const p=plan();
  p.profitExperiment.asks.down=[{price:.51,size:100}];
  p.profitExperiment.asks.up=[{price:.8,size:100}];
  for(const key of ['baseline','candidate']) p.profitExperiment[key].selected={...p.profitExperiment[key].selected,direction:'down'};
  const s=createPlan14ProfitExperiment(nowMs);
  const events=observePlan14ProfitExperiment(s,p,sentiment,nowMs,.07,{plan14ProfitExperimentLatencyPenaltyCents:2});
  assert.equal(events.length,4);
  for(const {order:o} of events){
    const price=o.lane.endsWith('Stress')?.54:.53;
    assert.equal(o.direction,'down');close(o.avgFillPrice,price);close(o.latencyPenalty,.02);
    close(o.depthUsed[0].fillPrice,price);close(o.depthUsed[0].shares,10/price);
    assert.equal(o.usd,10);
  }
});

test('missing or insufficient depth skips without debit or reserving the window; retry can fill',()=>{
  for(const asks of [undefined,[],[{price:.51,size:19}], [{price:.51,size:Infinity}]]){
    const s=createPlan14ProfitExperiment(nowMs),p=plan();p.profitExperiment.asks.up=asks;
    assert.deepEqual(observePlan14ProfitExperiment(s,p,sentiment,nowMs),[]);
    for(const lane of policyLanes(s)){
      assert.equal(lane.cash,500);assert.equal(lane.invested,0);assert.equal(lane.filled,0);
      assert.equal(lane.skips,1);assert.deepEqual(lane.open,[]);assert.deepEqual(lane.lastFilledTargetMs,{});
    }
    p.profitExperiment.asks.up=[{price:.51,size:100}];
    assert.equal(observePlan14ProfitExperiment(s,p,sentiment,nowMs).length,4);
  }
});

test('invalid latency or penalized prices at one skip experiment fills',()=>{
  for(const cents of [-1,NaN,Infinity,49]){
    const s=createPlan14ProfitExperiment(nowMs);
    assert.deepEqual(observePlan14ProfitExperiment(s,plan(),sentiment,nowMs,.07,
      {plan14ProfitExperimentLatencyPenaltyCents:cents}),[]);
    assert.ok(policyLanes(s).every(l=>l.cash===500 && l.skips===1));
  }
});

test('official outcome and redemption delay are mandatory; no repeated settlement or free future capital',()=>{
  const s=createPlan14ProfitExperiment(nowMs);observePlan14ProfitExperiment(s,plan(),sentiment,nowMs);
  resolvePlan14ProfitExperiment(s,sentiment.marketSlug,{actualDirection:'up',priceSource:'binance'},targetMs+20000);
  assert.equal(s.lanes.baseline.open[0].status,'open');assert.equal(releasePlan14ProfitExperiment(s,targetMs+300000).length,0);
  resolvePlan14ProfitExperiment(s,sentiment.marketSlug,{actualDirection:'up',priceSource:'polymarket-official'},targetMs-1);
  assert.equal(s.lanes.baseline.open[0].status,'open');
  resolvePlan14ProfitExperiment(s,sentiment.marketSlug,{actualDirection:'up',priceSource:'polymarket-official'},targetMs+20000);
  assert.equal(releasePlan14ProfitExperiment(s,targetMs+239999).length,0);assert.equal(s.lanes.baseline.cash,490);
  const es=releasePlan14ProfitExperiment(s,targetMs+240000);assert.equal(es.length,4);
  assert.equal(s.lanes.baseline.cash,508.94);assert.equal(s.lanes.baseline.realizedPnl,8.94);
  assert.equal(releasePlan14ProfitExperiment(s,targetMs+300000).length,0);
  assert.equal(s.lanes.baseline.cash,508.94);
  const restored=JSON.parse(JSON.stringify(s));assert.equal(observePlan14ProfitExperiment(restored,plan(),sentiment,nowMs).length,0);
  assert.equal(summarizePlan14ProfitExperiment(s).lanes.candidate.pending,0);
});

test('a losing candidate loses its full stake and cannot spend more than its own cash',()=>{
  const s=createPlan14ProfitExperiment(nowMs),p=plan();s.lanes.baseline.cash=9;
  const events=observePlan14ProfitExperiment(s,p,sentiment,nowMs);assert.equal(events.length,3);
  assert.equal(s.lanes.baseline.cash,9);assert.equal(s.lanes.baseline.filled,0);
  resolvePlan14ProfitExperiment(s,sentiment.marketSlug,{actualDirection:'down',priceSource:'polymarket-official'},targetMs+300000);
  releasePlan14ProfitExperiment(s,targetMs+300000);
  assert.equal(s.lanes.candidate.cash,490);assert.equal(s.lanes.candidate.realizedPnl,-10);
});

test('invalid, pre-start, future, stale or expired observations never create experiments',()=>{
  for(const [p,t] of [[plan(),nowMs-1],[plan(),nowMs+11000],[{...plan(),targetTimeIso:new Date(nowMs).toISOString()},nowMs],
    [{...plan(),generatedAtIso:new Date(nowMs-1000).toISOString()},nowMs]]){
    const s=createPlan14ProfitExperiment(nowMs);assert.equal(observePlan14ProfitExperiment(s,p,sentiment,t).length,0);
  }
});

test('service officially settles without touching main cash, orders or auto state',async()=>{
  const service=new PolymarketTradingService({config:{plan14Enabled:true,plan14ProfitExperimentEnabled:true}});
  service.persist=async()=>{};const bucket=service.getBucket('plan14');bucket.auto.enabled=true;
  const cash=bucket.portfolio.cash,orders=bucket.paperOrders.length;
  bucket.plan14ProfitExperiment=createPlan14ProfitExperiment(nowMs);
  observePlan14ProfitExperiment(bucket.plan14ProfitExperiment,plan(),sentiment,nowMs);
  let requests=0;
  await service.settlePlan14ProfitExperiment(async()=>{requests++;return{actualDirection:'up',priceSource:'polymarket-official'};},{nowMs:targetMs+300000});
  assert.equal(requests,1);assert.equal(bucket.plan14ProfitExperiment.lanes.candidate.settled,1);
  assert.equal(bucket.portfolio.cash,cash);assert.equal(bucket.paperOrders.length,orders);assert.equal(bucket.auto.enabled,true);
});

test('runtime opportunity integration persists/reloads funded ledgers and append-only entries',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'plan14-profit-test-'));
  try{
    const s=new PolymarketTradingService({config:{plan14Enabled:true,plan14ProfitExperimentEnabled:true,
      plan14ProfitExperimentLatencyPenaltyCents:2},stateDir:folder});
    const bucket=s.getBucket('plan14');bucket.auto.enabled=false;
    const t=Date.now(),n=new Date(t),target=new Date(t+240000).toISOString();
    const freshSignal={...signal,prediction:{...signal.prediction,targetTimeIso:target},
      schedule:{...signal.schedule,currentSlotIso:new Date(t-60000).toISOString(),nextSlotIso:target},
      indicators:{...signal.indicators,currentQuoteTime:t}};
    const freshBook={up:{...book.up,bookTimeMs:t},down:{...book.down,bookTimeMs:t}};
    const p=buildPolymarketPaperPlan14({signal:freshSignal,sentiment,plan14Book:freshBook,now:n});
    const mainCash=bucket.portfolio.cash;
    await s.recordPlan14Opportunity(p,sentiment);
    assert.equal(bucket.plan14ProfitExperiment.lanes.candidate.filled,1);
    assert.equal(bucket.plan14ProfitExperiment.lanes.baseline.filled,1);
    assert.equal(bucket.portfolio.cash,mainCash);assert.equal(bucket.paperOrders.length,0);
    const file=join(folder,'plan14-research',`${n.toISOString().slice(0,10)}-experiments.jsonl`);
    const events=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.length,8);assert.ok(events.every(e=>e.type==='entry'));
    assert.ok(events.every(e=>e.order.latencyPenalty===.02 && e.order.depthUsed.length===1));
    close(events.find(e=>e.order.lane==='baseline').order.avgFillPrice,.53);
    const reloaded=new PolymarketTradingService({config:{plan14Enabled:true,plan14ProfitExperimentEnabled:true},stateDir:folder});
    await reloaded.load();
    assert.deepEqual(reloaded.getBucket('plan14').plan14ProfitExperiment,bucket.plan14ProfitExperiment);
  }finally{
    assert.equal(dirname(resolve(folder)),resolve(tmpdir()));await rm(folder,{recursive:true});
  }
});


test('seeded matched controls choose either real side, settle and retain UTC/event blocks', () => {
  const state = createPlan14ProfitExperiment(nowMs);
  const events = observeAll(state, plan(), sentiment, nowMs, .07, {}, () => .99);
  assert.equal(events.length, 8);
  const control = state.lanes.baselineControl.open[0];
  assert.equal(control.direction, 'down');
  assert.equal(control.marketSlug, state.lanes.baseline.open[0].marketSlug);
  assert.equal(control.pairedOrderId, state.lanes.baseline.open[0].id);
  assert.equal(control.priceBand, 5);
  resolvePlan14ProfitExperiment(state, sentiment.marketSlug, { actualDirection: 'up', priceSource: 'polymarket-official' }, targetMs);
  assert.equal(releaseAll(state, targetMs + 240000).length, 8);
  const summary = summarizePlan14ProfitExperiment(JSON.parse(JSON.stringify(state)));
  assert.equal(summary.byDate['2099-01-10'].baselineControl.realizedPnl, -10);
  assert.equal(summary.byEvent['btc-test'].baseline.wins, 1);
  assert.equal(summary.byDate['2099-01-10'].baseline.pending, 0);
  assert.equal(summary.byEvent['btc-test'].baselineControl.settled, 1);
  const another = createPlan14ProfitExperiment(nowMs);
  observeAll(another, plan(), sentiment, nowMs, .07, {}, () => 0);
  assert.equal(another.lanes.baselineControl.open[0].direction, 'up');
});

test('controls stay in the entry price band and skip insufficient real depth', () => {
  const p = plan(); p.profitExperiment.asks.down = [{price: .8, size: 100}];
  const state = createPlan14ProfitExperiment(nowMs);
  observeAll(state, p, sentiment, nowMs, .07, {}, () => .99);
  assert.equal(state.lanes.baselineControl.open[0].direction, 'up');
  const q = plan(); q.profitExperiment.asks.up = [{price: .51, size: 4}, {price: .7, size: 100}];
  q.profitExperiment.asks.down = [{price: .8, size: 100}];
  const skipped = createPlan14ProfitExperiment(nowMs);
  observeAll(skipped, q, sentiment, nowMs, .07, {}, () => 0);
  assert.equal(skipped.lanes.baseline.filled, 1);
  assert.equal(skipped.lanes.baselineControl.filled, 0);
  assert.equal(skipped.lanes.baselineControl.cash, 500);
  assert.equal(skipped.lanes.baselineControl.skips, 1);
});

test('experiment toggle persists independently from main auto and main entry config', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'plan14-toggle-'));
  try {
    const service = new PolymarketTradingService({ config: { plan14Enabled: false, plan14ProfitExperimentEnabled: true }, stateDir: folder });
    assert.equal(service.getBucket('plan14').auto.enabled, false);
    assert.equal(service.plan14ProfitExperimentEnabled(), true);
    await service.setPlan14ProfitExperimentEnabled(false);
    service.getBucket('plan14').auto.enabled = true;
    assert.equal(service.plan14ProfitExperimentEnabled(), false);
    await service.setPlan14ProfitExperimentEnabled(true);
    service.getBucket('plan14').auto.enabled = false;
    await service.persist('plan14');
    const restored = new PolymarketTradingService({ config: { plan14ProfitExperimentEnabled: false }, stateDir: folder });
    await restored.load();
    assert.equal(restored.plan14ProfitExperimentEnabled(), true);
    assert.equal(restored.getBucket('plan14').auto.enabled, false);
  } finally { await rm(folder, { recursive: true }); }
});


test('legacy ledgers recover available blocks without negative pending counts', () => {
  const state = createPlan14ProfitExperiment(nowMs);
  observeAll(state, plan(), sentiment, nowMs, .07, {}, () => 0);
  delete state.byDate; delete state.byEvent;
  for (const key of Object.keys(state.lanes)) if (key.endsWith('Control')) delete state.lanes[key];
  resolvePlan14ProfitExperiment(state, sentiment.marketSlug, { actualDirection: 'up', priceSource: 'polymarket-official' }, targetMs);
  releaseAll(state, targetMs + 240000);
  assert.equal(state.byDate['2099-01-10'].baseline.pending, 0);
  assert.equal(state.byEvent['btc-test'].baseline.settled, 1);
  assert.ok(summarizePlan14ProfitExperiment(state).blockHistoryNote);
});
