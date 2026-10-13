import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { normalizedProbability, netShares, portfolioReplay, chronologicalSplit, clusterInterval } from '../src/plan14Backtest.js';
import { computePlan14OrderUsd, evaluatePlan14Entry, PLAN14_PROFIT_EXPERIMENT_VERSION } from '../src/polymarketPlan14.js';
const folder = resolve(process.argv[2] || 'data/analysis/plan14-optimize-20261005');
const input = JSON.parse(readFileSync(join(folder, 'input.json')));
const official = JSON.parse(readFileSync(join(folder, 'official-outcomes.json')));
const quotes = input.opportunities.filter(q => q.timeframe === '5m' && q.model?.freshBook
  && ['up', 'down'].includes(official[q.marketSlug]?.actualDirection)).sort((a,b)=>a.observedAtIso.localeCompare(b.observedAtIso));
const round = n => Math.round(n*100)/100;
const logit = p => Math.log(Math.max(.005,Math.min(.995,p))/(1-Math.max(.005,Math.min(.995,p))));
const predict = (q,c) => 1/(1+Math.exp(-logit(normalizedProbability(q.model.marketUp,q.model.spotUp,c.weight))/c.temperature));
const candidates = [{id:'recorded_v9_entry',recorded:true,weight:.23,temperature:1,minElapsed:.1},
  {id:'runtime_v10_candidate',runtime:true,weight:.4,temperature:.85,minElapsed:.1},
  ...[.1,.23,.4,.6].map(weight=>({id:`retain_gates_w${weight}`,retained:true,weight,temperature:1,minElapsed:.1})),
  ...[.23,.4,.6].flatMap(weight=>[.85,1,1.15].flatMap(temperature=>[.1,.3].map(minElapsed=>({
    id:`two_sides_w${weight}_T${temperature}_elapsed${minElapsed}`,weight,temperature,minElapsed}))))];
function entries(c) {
  const selected=[], keys=new Set();
  for(const q of quotes) {
    const entryMs=Date.parse(q.observedAtIso),targetMs=Date.parse(q.targetTimeIso),key=`${q.symbol}|${targetMs}`;
    const remain=targetMs-entryMs;
    if(keys.has(key)||remain<45000||remain>(1-c.minElapsed)*300000)continue;
    if([q.model.bookTimeMs?.up,q.model.bookTimeMs?.down,q.model.inputs?.quoteTimeMs]
      .some(t=>!Number.isFinite(t)||entryMs-t < -2000||entryMs-t>10000))continue;
    const p=predict(q,c);
    let sides=c.recorded?(q.decision.allowed?[q.decision.selected]:[]):q.candidates;
    if(c.retained||c.runtime){
      const d=evaluatePlan14Entry({signal:{prediction:{targetTimeIso:q.targetTimeIso,comparisonBasePrice:q.model.inputs.open},
        indicators:{currentPrice:q.model.inputs.spot,volatility15mPct:q.model.inputs.volatility,
          currentQuoteTime:q.model.inputs.quoteTimeMs}},sentiment:{available:true},now:new Date(entryMs),
        book:Object.fromEntries(q.candidates.map(s=>[s.direction,{bid:s.bid,ask:s.ask,bookTimeMs:q.model.bookTimeMs[s.direction]}])),
        config:{plan14ModelWeight5m:c.runtime ? .23 : c.weight},
        ...(c.runtime?{policyVersion:PLAN14_PROFIT_EXPERIMENT_VERSION}:{})});
      sides=d.allowed?[d.selected]:[];
    }
    const valid=sides.filter(s=>s&&s.ask>0&&s.ask<=.90&&s.bid>0&&s.ask>s.bid&&s.spread<=.05+1e-9
      &&Math.abs(s.ask-s.mid)<=.05+1e-9).map(s=>({...s,p:c.runtime?s.p:(s.direction==='up'?p:1-p),
        cost:10/netShares(10,s.ask)})).map(s=>({...s,edge:s.p-s.cost}))
      .filter(s=>c.recorded||s.edge>=.01-1e-9).sort((a,b)=>b.edge-a.edge);
    if(!valid.length)continue;
    const side=valid[0];keys.add(key);
    selected.push({id:key,symbol:q.symbol,entryMs,targetMs,releaseMs:targetMs+240000,ask:side.ask,
      p:side.p,feeRate:.07,wins:official[q.marketSlug].actualDirection===side.direction});
  }
  return selected;
}
const allTargets=[...new Set(quotes.map(q=>Date.parse(q.targetTimeIso)))].sort((a,b)=>a-b);
const boundaries=chronologicalSplit(allTargets.map(targetMs=>({targetMs})));
const subset=(rows,name)=>rows.filter(r=>boundaries[name].some(w=>w.targetMs===r.targetMs));
const strip=({trades,...rest})=>rest;
const table=candidates.map(c=>{
  const rs=entries(c), sets={all:rs,train:subset(rs,'train'),validation:subset(rs,'validation'),test:subset(rs,'test')};
  const scores={};for(const [name,rows] of Object.entries(sets)){
    scores[name]={fixed10:strip(portfolioReplay(rows)),adverseFixed10:strip(portfolioReplay(rows,{slippage:.01})),
      funded:strip(portfolioReplay(rows,{stake:({cash,candidate})=>computePlan14OrderUsd({cash,candidate})})),
      returnBudget:strip(portfolioReplay(rows,{stake:({cash,candidate:s})=>{
        const floor=Math.max(1,Math.ceil(5*s.ask*100-1e-6)/100);
        const usd=Math.max(floor,cash*Math.min(.03,Math.max(0,s.p/s.cost-1)*.25));
        return usd>cash*.03+1e-9?0:round(usd);
      }})),
      brier:rows.length?round(rows.reduce((a,r)=>a+(r.p-(r.wins?1:0))**2,0)/rows.length*10000)/10000:null};
  }
  return {candidate:c,...scores};
});
const baseRows=entries(candidates[0]);
const baseSplit=Object.fromEntries(['train','validation','test'].map(name=>[name,subset(baseRows,name)]));
const allocationSizer=(exponent,scale=1)=>({cash,candidate:s})=>{
  const floor=Math.max(1,Math.ceil(5*s.ask*100-1e-6)/100);
  const score=(s.p-s.cost)/(1-s.cost)*Math.pow((1-s.cost)/s.cost,exponent);
  const usd=Math.max(floor,cash*Math.min(.03,Math.max(0,score)*.25*scale));
  return usd>cash*.03+1e-9?0:round(usd);
};
const referenceInvested=baseSplit.train.reduce((sum,r)=>sum+allocationSizer(0)({cash:500,candidate:{...r,cost:10/netShares(10,r.ask)}}),0);
const allocation=[0,.25,.5,1].map(exponent=>{
  // Equalize the training entry budget using features only, not realized winners.
  let lo=.001,hi=4;
  for(let i=0;i<50;i++){
    const scale=(lo+hi)/2;
    const total=baseSplit.train.reduce((sum,r)=>sum+allocationSizer(exponent,scale)({cash:500,candidate:{...r,cost:10/netShares(10,r.ask)}}),0);
    if(total>referenceInvested)hi=scale;else lo=scale;
  }
  const scale=(lo+hi)/2,sets={all:baseRows,train:baseSplit.train,validation:baseSplit.validation,test:baseSplit.test};
  return {exponent,scale,referenceInvested,scores:Object.fromEntries(Object.entries(sets).map(([name,rs])=>[name,
    {normal:strip(portfolioReplay(rs,{stake:allocationSizer(exponent,scale)})),
      adverse:strip(portfolioReplay(rs,{stake:allocationSizer(exponent,scale),slippage:.01}))}]))};
});
// Common samples, not policy-specific selected trades, for the proper probability score.
const common=new Map();
for(const q of quotes){
  const entryMs=Date.parse(q.observedAtIso),targetMs=Date.parse(q.targetTimeIso),key=`${q.symbol}|${targetMs}`;
  if(common.has(key)||targetMs-entryMs<45000||targetMs-entryMs>270000)continue;
  if([q.model.inputs?.quoteTimeMs,q.model.bookTimeMs?.up,q.model.bookTimeMs?.down]
    .some(t=>!Number.isFinite(t)||entryMs-t < -2000||entryMs-t>10000))continue;
  common.set(key,{...q,targetMs,y:official[q.marketSlug].actualDirection==='up'?1:0});
}
const predictive=[...new Map(candidates.map(c=>[`${c.weight}|${c.temperature}`,c])).values()].map(c=>({
  weight:c.weight,temperature:c.temperature,scores:Object.fromEntries(['train','validation','test'].map(name=>{
    const rs=subset([...common.values()],name);
    return [name,{n:rs.length,brier:rs.reduce((sum,q)=>sum+(predict(q,c)-q.y)**2,0)/rs.length}];
  }))})).sort((a,b)=>a.scores.train.brier-b.scores.train.brier);
const selected=table.find(r=>!r.candidate.retained&&!r.candidate.recorded&&r.candidate.minElapsed===.1
  &&r.candidate.weight===predictive[0].weight&&r.candidate.temperature===predictive[0].temperature);
const pairedDeltas={};
if(selected){for(const name of ['validation','test']){
  const sums=new Map();for(const [sign,c] of [[1,selected.candidate],[-1,candidates[0]]]){
    for(const t of portfolioReplay(subset(entries(c),name)).trades)sums.set(t.targetMs,(sums.get(t.targetMs)||0)+sign*t.pnl);
  }
  pairedDeltas[name]=clusterInterval([...sums].map(([targetMs,pnl])=>({targetMs,pnl})));
}}
const report={frozenAtIso:input.frozenAtIso,quotes:quotes.length,windows:allTargets.length,
  first:quotes[0]?.observedAtIso,last:quotes.at(-1)?.observedAtIso,
  trainEndIso:boundaries.trainEndIso,validationEndIso:boundaries.validationEndIso,
  assumptions:{capital:500,fixedStake:10,feeRate:.07,redemptionDelaySeconds:240,exit:'hold_to_official_settlement for all candidates',
    limitations:input.limitations.concat(['Entry comparison only: all candidates hold, not the running version exit rules.',
      'No depth or latency simulation. Some quotes are missed by historic prescreen.','Model and allocation explorations create selection bias; new forward control is required.',
      'Training probability-score selection was formalized after exploratory PnL inspection, not a preregistered blind test.'])},table,allocation,
  predictive:{commonSamples:common.size,selectionRule:'Lowest training Brier on each coin/window first fresh observed quote; minElapsed fixed at 0.10',
    table:predictive,selectedCandidate:selected?.candidate||null,pairedDeltas}};
writeFileSync(join(folder,'optimization.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({quotes:report.quotes,windows:report.windows,first:report.first,last:report.last,
  splits:[report.trainEndIso,report.validationEndIso],table:table.map(r=>({id:r.candidate.id,
    fixed:[r.train.fixed10.pnl,r.validation.fixed10.pnl,r.test.fixed10.pnl,r.all.fixed10.pnl],
    funded:[r.train.funded.pnl,r.validation.funded.pnl,r.test.funded.pnl,r.all.funded.pnl],
    returnBudget:[r.train.returnBudget.pnl,r.validation.returnBudget.pnl,r.test.returnBudget.pnl,r.all.returnBudget.pnl],
    n:[r.train.fixed10.n,r.validation.fixed10.n,r.test.fixed10.n,r.all.fixed10.n],
    adverseTest:r.test.adverseFixed10.pnl})),allocation},null,2));
