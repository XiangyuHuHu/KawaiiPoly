import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPolymarketPaperPlan14, evaluatePlan14Entry, PLAN14_VERSION, PLAN14_PROFIT_EXPERIMENT_VERSION } from '../src/polymarketPlan14.js';
import { createPlan14ProfitExperiment, observePlan14ProfitExperiment, resolvePlan14ProfitExperiment,
  releasePlan14ProfitExperiment, summarizePlan14ProfitExperiment } from '../src/plan14ProfitExperiment.js';
import { PolymarketTradingService } from '../src/polymarketTrading.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const nowMs = Date.parse('2099-01-10T00:01:00Z'), targetMs = nowMs + 240000;
const sentiment = { available: true, marketSlug: 'btc-test', upPrice:.5, downPrice:.5, upBestAsk:.51, downBestAsk:.51 };
const signal = { symbol:'BTC-USD', prediction:{targetTimeIso:new Date(targetMs).toISOString(),comparisonBasePrice:100},
  schedule:{currentSlotIso:'2099-01-10T00:00:00Z',nextSlotIso:new Date(targetMs).toISOString(),secondsToNext:240},
  indicators:{currentPrice:100.1,volatility15mPct:.001,currentQuoteTime:nowMs} };
const book = {up:{bid:.49,ask:.51,bookTimeMs:nowMs},down:{bid:.49,ask:.51,bookTimeMs:nowMs}};
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
  for(const lane of Object.values(s.lanes)){assert.equal(lane.cash,490);assert.equal(lane.filled,1);assert.equal(lane.invested,10);}
  const a=s.lanes.baseline.open[0],b=s.lanes.baselineStress.open[0];
  close(a.shares,10/.51*(1-.07*(1-.51)));close(b.ask,.52);assert.ok(b.shares<a.shares);
  const other={...p,symbol:'ETH-USD'};
  assert.equal(observePlan14ProfitExperiment(s,other,{...sentiment,marketSlug:'eth-test'},nowMs).length,4);
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
    const s=new PolymarketTradingService({config:{plan14Enabled:true,plan14ProfitExperimentEnabled:true},stateDir:folder});
    const bucket=s.getBucket('plan14');bucket.auto.enabled=true;
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
    assert.equal(events.length,4);assert.ok(events.every(e=>e.type==='entry'));
    const reloaded=new PolymarketTradingService({config:{plan14Enabled:true,plan14ProfitExperimentEnabled:true},stateDir:folder});
    await reloaded.load();
    assert.deepEqual(reloaded.getBucket('plan14').plan14ProfitExperiment,bucket.plan14ProfitExperiment);
  }finally{
    assert.equal(dirname(resolve(folder)),resolve(tmpdir()));await rm(folder,{recursive:true});
  }
});
