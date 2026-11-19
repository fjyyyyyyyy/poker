if(!Array.prototype.at)Array.prototype.at=function(index){index=Math.trunc(index)||0;if(index<0)index+=this.length;return this[index];};
import {evaluate,rank,suit,secureRandom} from './evaluator.js';
import {seededRandom,tableMood} from './personality.js';
import {BET_UNIT,snapBet} from './bet.js';
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const sigmoid=x=>1/(1+Math.exp(-x));
const DECK=Array.from({length:52},(_,i)=>i);
const seatOffset=(v,id)=>(id-v.button+v.players.length)%v.players.length;
const latePosition=(v,id)=>seatOffset(v,id)===0||v.players.length>=5&&seatOffset(v,id)===v.players.length-1;
export function preflopStrength(cards){
 const [a,b]=cards.map(rank).sort((x,y)=>y-x),pair=a===b,suited=suit(cards[0])===suit(cards[1]),gap=a-b;
 if(pair)return clamp(.46+(a-2)*.043,.1,.99);
 return clamp(.10+(a-2)*.031+(b-2)*.019+(suited?.075:0)+(gap===1?.055:gap===2?.025:gap>4?-.06:0)+(a===14?.035:0),.05,.94);
}
function texture(cards,board){
 if(!board.length){const power=preflopStrength(cards);return {power,draw:0,blocker:false,score:power};}
 const all=[...cards,...board];
 let draw=0;
 if(board.length<5){
  const counts=[0,1,2,3].map(s=>all.filter(c=>suit(c)===s).length);
  const ranks=[...new Set(all.map(rank))];
  if(ranks.includes(14))ranks.push(1);
  if(counts.includes(4))draw+=.15;
  let span=0;
  for(let low=1;low<=10;low++)span=Math.max(span,ranks.filter(r=>r>=low&&r<low+5).length);
  if(span===4)draw+=.1;
 }
 const blocker=cards.some(c=>rank(c)===14&&board.filter(b=>suit(b)===suit(c)).length>=2);
 const ev=evaluate(all),boardMax=Math.max(...board.map(rank));
 let power=[.12,.43,.66,.77,.85,.9,.96,.985,.999][ev.category];
 if(ev.category===0)power+=Math.max(...cards.map(rank))/140;
 if(ev.category===1){const pairRank=ev.kickers[0];power+=(pairRank>=boardMax?.14:0)+pairRank/150;if(board.filter(c=>rank(c)===pairRank).length===2&&!cards.some(c=>rank(c)===pairRank))power-=.22;}
 if(board.length===5&&ev.score===evaluate(board).score)power-=.09;
 return {power:clamp(power),draw,blocker,category:ev.category,score:ev.score};
}
function tendencies(player){
 const s=player.stats;
 const vpip=(s.vpip+8)/(s.hands+25),agg=(s.raises+4)/(s.raises+s.calls+8),fold=(s.foldToBet+6)/(s.faced+14),bluff=(s.shownBluffs+1)/(s.showdowns+10);
 // 入池宽、面对下注很少弃牌、几乎不加注 => 跟注站。用先验平滑，前几手不会误判。
 const sticky=clamp((vpip-.34)*1.7+(.43-fold)*1.5+(.5-agg)*.25,0,.68);
 return {vpip,agg,fold,bluff,sticky};
}
function availableCombos(v){
 const blocked=new Set([...v.hole,...v.board]),available=DECK.filter(c=>!blocked.has(c)),combos=[];
 for(let i=0;i<available.length;i++)for(let j=i+1;j<available.length;j++)combos.push({cards:[available[i],available[j]],textures:{}});
 return combos;
}
function publicTexture(combo,street,board){
 return combo.textures[street]??=texture(combo.cards,board);
}
function humanTableRead(v){
 const humans=v.players.filter(player=>player.id!==v.seat&&player.isHuman);
 if(!humans.length)return {loose:false,activeHumans:0,entered:0,avgVpip:0};
 const ids=new Set(humans.map(player=>player.id));
 const entered=new Set();
 for(const event of v.events){
  if(event.kind!=='action'||!ids.has(event.seat)||event.type==='fold'||event.type==='check')continue;
  entered.add(event.seat);
 }
 const active=humans.filter(player=>!player.folded);
 const samples=humans.filter(player=>player.stats?.hands>=3);
 const avgVpip=samples.length?samples.reduce((sum,player)=>sum+player.stats.vpip/player.stats.hands,0)/samples.length:0;
 return {loose:active.length>=2&&(entered.size>=2||avgVpip>.44),activeHumans:active.length,entered:entered.size,avgVpip};
}
function actionLikelihood(v,tendency,late,{event,priorRaises},hand){
 const pre=event.street==='preflop',headsUp=v.players.length===2;
 const size=event.amount/Math.max(v.bb,event.pot-event.amount);
 const looseness=(tendency.vpip-.32)*.33+(late&&pre?.045:0);
 if(event.type==='raise'){
  const base=pre?(headsUp?.58:.7):.63;
  const threshold=clamp(base-looseness+Math.min(3,priorRaises)*(pre?.104:.12)+Math.min(size,2)*.07,.41,.965);
  const value=sigmoid((hand.percentile-threshold)*16);
  const bluff=(.023+tendency.agg*.045+hand.draw*.36+(hand.blocker?.016:0))/(1+priorRaises*.68);
  return .012+value*.76+(1-value)*bluff;
 }
 if(event.type==='call'){
  const threshold=pre?(headsUp?.31:.45):.27;
  const drawPotential=hand.draw*(event.street==='flop'?1.05:.68);
  const strength=sigmoid((hand.percentile+drawPotential-threshold+looseness-Math.min(1.5,size)*.22-priorRaises*.046)*12);
  return Math.min(.98,.08+strength*.72+(tendency.sticky??0)*.09);
 }
 return .79-hand.percentile*(pre?.31:.37);
}
function observedActions(v){
 const raiseCounts={},actions=[];
 for(const event of v.events){
  if(event.kind!=='action'||event.type==='fold')continue;
  const priorRaises=raiseCounts[event.street]??0;
  actions.push({event,priorRaises});
  if(event.type==='raise')raiseCounts[event.street]=priorRaises+1;
 }
 return actions;
}
function rangeFor(v,op,available,modelActions){
 const observations=(modelActions??observedActions(v)).filter(({event})=>event.seat===op.id);
 const tendency=tendencies(op),combos=[],late=latePosition(v,op.id);let total=0;
 for(const combo of available){
  let weight=1;
  for(const entry of observations){
   const e=entry.event,hand=publicTexture(combo,e.street,e.board);
   if(modelActions){weight*=actionLikelihood(v,tendency,late,entry,hand);continue;}
   const {power,draw,blocker}=hand,pre=e.street==='preflop';
   const threshold=pre?.76-tendency.vpip*.5-(late?.07:0):.56;
   const value=sigmoid((power-threshold)*11),bluff=(.035+tendency.agg*.1+draw*.65+(blocker?.05:0));
   let likelihood;
   if(e.type==='raise'){const size=e.amount/Math.max(v.bb,e.pot-e.amount);likelihood=.025+value*(.55+Math.min(size,.8)*.2)+bluff*(1-value);}
   else if(e.type==='call')likelihood=.04+sigmoid((power+draw-threshold+.13)*10)*(.86-.55*value);
   else likelihood=.2+(1-value)*.55+value*.1;
   weight*=clamp(likelihood,.015,.98);
  }
  weight=Math.max(1e-7,weight);total+=weight;combos.push({combo,cumulative:total,weight});
 }
 return {combos,total};
}
function drawRange(range,used,rng){
 for(let n=0;n<18;n++){
  const target=rng()*range.total;let lo=0,hi=range.combos.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(range.combos[m].cumulative<target)lo=m+1;else hi=m;}
  const {combo}=range.combos[lo];if(!used.has(combo.cards[0])&&!used.has(combo.cards[1]))return combo;
 }
 const legal=range.combos.filter(({combo})=>combo.cards.every(c=>!used.has(c)));
 let target=rng()*legal.reduce((sum,entry)=>sum+entry.weight,0);
 return legal.find(entry=>(target-=entry.weight)<=0)?.combo??legal.at(-1).combo;
}
export function estimateEquity(v,{samples=180,rng=secureRandom}={}){
 const available=availableCombos(v),opponents=v.players.filter(p=>p.id!==v.seat&&!p.folded),ranges=opponents.map(p=>rangeFor(v,p,available));let wins=0;
 for(let n=0;n<samples;n++){
  const used=new Set([...v.hole,...v.board]),hands=[];
  // Rotate sampling order to avoid always favoring the same opponent's conditional range.
  for(let j=0;j<ranges.length;j++){const k=(j+n)%ranges.length,{cards}=drawRange(ranges[k],used,rng);cards.forEach(c=>used.add(c));hands.push(cards);}
  const deck=DECK.filter(c=>!used.has(c)),board=[...v.board];
  while(board.length<5){const k=Math.floor(rng()*deck.length);board.push(deck[k]);deck[k]=deck.at(-1);deck.pop();}
  const own=evaluate([...v.hole,...board]).score,others=hands.map(h=>evaluate([...h,...board]).score),best=Math.max(own,...others);
  if(own===best)wins+=1/(1+others.filter(s=>s===own).length);
 }
 return wins/samples;
}
function standardDecision(v,{rng,samples,memory}){
 const persona=v.personality,l=v.legal,me=v.players[v.seat],opps=v.players.filter(p=>p.id!==v.seat&&!p.folded),eq=estimateEquity(v,{rng,samples});
 const sticky=clamp(persona.sticky??0,0,.85);
 const humanRead=humanTableRead(v);
 const tex=texture(v.hole,v.board),pre=v.street==='preflop',position=seatOffset(v,v.seat),late=latePosition(v,v.seat);
 const mood=tableMood(persona,v.events,v.seat);
 if(memory.hand!==v.hand||memory.sessionId!==v.sessionId){Object.keys(memory).forEach(k=>delete memory[k]);memory.hand=v.hand;memory.sessionId=v.sessionId;memory.plan=null;memory.actions=[];}
 const potOdds=l.call/(v.pot+l.call||1),facing=opps.filter(p=>p.bet===v.currentBet&&p.bet>0),opAgg=facing.reduce((a,p)=>a+tendencies(p).agg,0)/(facing.length||1);
 const foldRate=opps.reduce((a,p)=>a+tendencies(p).fold,0)/opps.length;
 const bluffCatch=(opAgg-.5)*persona.adapt*.09+mood.reactance*.12;
 // Select and remember an intent. A trap on a previous street can become a check-raise.
 const priorTrap=memory.plan==='trap';
 if(!pre){
  if(eq>.73&&rng()<persona.trap)memory.plan='trap';
  else if(tex.draw>0&&persona.courage>.35)memory.plan='semi-bluff';
  else if(l.call>0&&eq>.32&&eq<.66&&opAgg>.58)memory.plan='bluff-catch';
  else if(eq>.58)memory.plan='value';
  else if(late&&persona.curiosity>.6&&l.call<Math.max(v.bb,v.pot*.25)&&v.street==='flop')memory.plan='float';
  else if(memory.plan==='float'&&v.street==='turn'&&l.canCheck)memory.plan='take-away';
 }
 // Realization discounts multiway, out-of-position and speculative holdings. No solved/GTO claim.
 let realized=clamp(eq*(late?1:.91)+bluffCatch-mood.caution+(tex.draw&&late?.02:0));
 const choices=[];const add=(type,to,score,reason)=>choices.push({type,to,score,reason});
 if(l.canCheck)add('check',0,realized*v.pot*(1-persona.aggression*.05),'保留摊牌价值，控制底池');
 else add('fold',0,0,'范围胜率与底池赔率不足以继续');
 let callScore=realized*(v.pot+l.call)-l.call;
 if(memory.plan==='bluff-catch')callScore+=v.bb*persona.courage;
 if(memory.plan==='float')callScore+=v.bb*.6*persona.curiosity;
 if(memory.plan==='trap')callScore+=v.bb*persona.trap;
 if(pre){const threshold=.77-persona.loose*.65-(late?.07:0);callScore-=(Math.max(0,threshold-tex.power))*v.bb*5;if(humanRead.loose)callScore-=Math.max(0,.52-tex.power)*v.bb*2.6;}
 if(!l.canCheck)callScore+=v.bb*sticky*.9+l.call*sticky*.22;
 if(!l.canCheck)add('call',0,callScore,bluffCatch>.008?'对手进攻较多，扩大抓诈范围':'以范围胜率比较底池赔率');
 if(l.canRaise){
  const sizes=pre?[Math.round(v.bb*(late?2.4:2.7)),Math.round(v.currentBet*3.1)]:[Math.round(v.pot*.36),Math.round(v.pot*.72),Math.round(v.pot*1.1)];
  if(me.stack<=Math.max(v.pot*1.4,v.bb*12))sizes.push(l.max-me.bet);
  const totals=[...new Set(sizes.map(s=>clamp(pre?s:me.bet+l.call+s,l.min,l.max)).map(x=>x===l.max?l.max:Math.max(l.min,Math.min(l.max,snapBet(x)))))].filter(to=>to>v.currentBet&&(to===l.max||(to%BET_UNIT===0&&to>=l.min&&to<=l.max)));
  const hasInitiative=v.events.filter(e=>e.kind==='action'&&e.type==='raise').at(-1)?.seat===v.seat;
  const value=pre?tex.power>.78:eq>Math.max(.57,1/opps.length*.7);
  const bluffChance=persona.bluff*(late?1.18:.85)*(opps.length>2?.3:1)*(foldRate>.5?1.3:1)*(hasInitiative?1.25:1)*(humanRead.loose?.62:1);
  const bluffIntent=!value&&(memory.plan==='semi-bluff'||memory.plan==='take-away'||rng()<bluffChance)&&(tex.draw>0||tex.blocker||hasInitiative||pre&&late||v.street==='river');
  const slowPlay=value&&memory.plan==='trap'&&opps.length<=2&&!(priorTrap&&l.call>0);
  for(const to of totals){
   const cost=to-me.bet,raiseExtra=to-v.currentBet,pressure=raiseExtra/Math.max(v.pot,v.bb);
   let fe=opps.reduce((a,p)=>{const t=tendencies(p);return a*clamp(t.fold+pressure*.18+(pre?.08:0)-Math.max(0,p.bet/v.bb-2)*.015,.06,.86);},1);
   fe=clamp(fe+(foldRate-.45)*persona.adapt*.12);
   const calledEq=clamp(realized-(1-realized)*(.16+pressure*.05));
   const effectiveCost=Math.min(cost,Math.max(...opps.map(p=>p.stack+p.bet))-me.bet);
   const ev=fe*v.pot+(1-fe)*(calledEq*(v.pot+effectiveCost*1.65)-effectiveCost);
   let score=ev+(value?persona.aggression*v.bb*.7:0);
   if(humanRead.loose)score+=value?v.pot*.035:-v.bb*.35;
   if(!value&&!bluffIntent)score-=v.pot*.45+v.bb;
   if(bluffIntent)score+=v.pot*(.14+tex.draw)+(tex.blocker?v.bb*.6:0);
   if(slowPlay)score-=v.pot*.6;
   if(priorTrap&&l.call>0&&value)score+=v.pot*.18;
   if(memory.plan==='take-away'&&bluffIntent)score+=v.pot*.12;
   if(memory.plan==='bluff-catch'&&!value)score-=v.pot*.2;
   if(pre){
    const previousRaises=v.events.filter(e=>e.kind==='action'&&e.type==='raise').length;
    if(previousRaises===0){
     // Opening is a position-based plan: unopened opponents need not all reach showdown.
     const openThreshold=.67-persona.loose*.30-(late?.08:position===1?.04:0);
     const limpers=v.events.filter(e=>e.kind==='action'&&e.type==='call').length;
     const fit=tex.power-openThreshold;
     score=fit>=0?v.bb*(.45+fit*6+persona.aggression*.35)-Math.max(0,to-v.bb*4)*.13:v.bb*(fit*12-.7);
     if(limpers&&fit>0)score+=v.bb*persona.aggression*.2;
     if(humanRead.loose&&fit>0)score+=v.bb*(.35+persona.aggression*.35);
     if(humanRead.loose&&fit<0)score-=v.bb*.45;
     if(to>v.bb*10&&me.stack>v.bb*15)score-=to*.3;
     if(late&&foldRate>.55&&fit>-.07)score+=v.bb*persona.adapt*.7;
    }else{
     const threshold=.69-persona.loose*.18+Math.min(previousRaises,3)*.045-(late?.035:0);
     score-=Math.max(0,threshold-tex.power)*v.bb*10;
    }
   }
   if(sticky>0)score-=v.pot*sticky*.14+v.bb*sticky*1.5+(value?0:v.pot*sticky*.3);
   score-=Math.max(0,cost-me.stack*.55)*(1-persona.aggression)*.09;
   add('raise',to,score,bluffIntent?(tex.draw?'利用听牌潜力半诈唬':'根据阻断牌、位置与弃牌倾向施压'):'对继续范围做价值下注');
  }
 }
 // A mixed policy: strategic EV plus modest independent uncertainty, rather than deterministic thresholds.
 const temperature=Math.max(v.bb*.18,v.pot*.022)*(persona.loose+.55);
 for(const c of choices)c.utility=c.score-temperature*Math.log(-Math.log(clamp(rng(),.00001,.99999)));
 choices.sort((a,b)=>b.utility-a.utility);
 memory.actions.push({street:v.street,type:choices[0].type,plan:memory.plan});
 return {...choices[0],plan:memory.plan,equity:eq,potOdds,samples,rangeBased:true};
}

function legalRaise(v,amount){
 const {min,max}=v.legal;
 return amount>=max?max:clamp(snapBet(amount),min,max);
}

function candidateActions(v,raiseTo,includeShove){
 const l=v.legal,passive=l.canCheck?'check':'call';
 const actions=l.canCheck?[{type:passive,to:0}]:[{type:'fold',to:0},{type:passive,to:0}];
 if(!l.canRaise)return actions;
 const pot=v.pot+l.call;
 const sizes=[l.min,v.currentBet+pot*.5,v.currentBet+pot];
 if(v.street==='preflop')sizes.push(v.currentBet+v.bb*2);
 if(includeShove||l.max<=v.currentBet+pot*1.6)sizes.push(l.max);
 if(Number.isFinite(raiseTo))sizes.push(raiseTo);
 return actions.concat([...new Set(sizes.map(to=>legalRaise(v,to)))].sort((a,b)=>a-b).map(to=>({type:'raise',to})));
}

function rankCombos(available,street,board){
 const ranked=available.map(combo=>publicTexture(combo,street,board)).sort((a,b)=>a.score-b.score);
 for(let i=0;i<ranked.length;){
  let end=i+1;
  while(end<ranked.length&&ranked[end].score===ranked[i].score)end++;
  const percentile=(i+end)/(2*ranked.length);
  for(let j=i;j<end;j++)ranked[j].percentile=percentile;
  i=end;
 }
 return ranked;
}

function buildModel(v){
 const available=availableCombos(v),actions=observedActions(v);
 const publicBoards=new Map(actions.map(({event})=>[event.street,event.board]));
 publicBoards.delete(v.street);
 for(const [street,board] of publicBoards)rankCombos(available,street,board);
 const ranked=rankCombos(available,v.street,v.board);
 const opponents=v.players.filter(p=>p.id!==v.seat&&!p.folded).map(player=>({
  player,
  range:rangeFor(v,player,available,actions),
  tendency:tendencies(player),
  late:latePosition(v,player.id)
 }));
 return {
  v,
  opponents,
  hero:v.players[v.seat],
  unbeatablyTied:v.board.length===5&&ranked[0].score===ranked.at(-1).score&&ranked[0].score===texture(v.hole,v.board).score
 };
}

function generateScenarios(model,samples,rng,rollout=false){
 const {v,opponents}=model;
 // On the river heads-up, sum over every possible combo and both responses.
 if(!rollout&&v.board.length===5&&opponents.length===1){
  const own=evaluate([...v.hole,...v.board]).score;
  return {
   exact:true,
   outcomes:opponents[0].range.combos.map(({combo,weight})=>({
    hands:[combo], scores:[own,combo.textures.river.score], weight, rolls:null
   }))
  };
 }
 const outcomes=[];
 const observed=[...v.hole,...v.board];
 for(let n=0;n<samples;n++){
  const used=new Set(observed),hands=Array(opponents.length);
  for(let i=0;i<opponents.length;i++){
   const k=(i+n)%opponents.length,combo=drawRange(opponents[k].range,used,rng);
   hands[k]=combo;
   combo.cards.forEach(c=>used.add(c));
  }
  const board=[...v.board];
  if(board.length<5){
   const remaining=DECK.filter(c=>!used.has(c));
   while(board.length<5){
    const index=Math.floor(rng()*remaining.length);
    board.push(remaining[index]);
    remaining[index]=remaining.at(-1);
    remaining.pop();
   }
  }
  const scores=[evaluate([...v.hole,...board]).score,...hands.map(h=>
   v.board.length===5?h.textures.river.score:evaluate([...h.cards,...board]).score
  )];
  const outcome={hands,scores,weight:1,rolls:opponents.map(()=>rng())};
  if(rollout){
   outcome.aggression=opponents.map(()=>rng());
   outcome.responses=opponents.map(()=>rng());
   if(v.board.length>=3&&v.board.length<5){
    outcome.nextBoard=board.slice(0,v.board.length+1);
    outcome.nextHands=[];
    outcome.nextRolls=opponents.map(()=>rng());
   }
  }
  outcomes.push(outcome);
 }
 return {exact:false,outcomes};
}

function continuationProbability(model,opponent,combo,cost,pot){
 if(cost<=0||model.unbeatablyTied)return 1;
 const {v,opponents}=model;
 const {tendency,player}=opponent;
 const {draw,blocker,percentile}=combo.textures[v.street];
 const price=cost/(pot+cost),pre=v.street==='preflop';
 const multiway=opponents.length>1;
 const tightness=(tendency.fold-.43)*.56+(tendency.vpip-.32)*-.24-(tendency.sticky??0)*.44;
 const shortStack=player.stack<=cost*1.6?.07:0;
 const committed=player.bet>v.bb&&player.bet>=cost?.045:0;
 const position=opponent.late?.035:0;
 const pressure=cost/Math.max(v.bb,pot);
 const threshold=pre?.46+price*.86+(multiway?.03:-.08):.36+price*1.05+(multiway?.06:0);
 const potential=draw*(v.street==='flop'?1.06:.66)+(blocker?.025:0);
 const strength=percentile+potential+tendency.agg*.045+shortStack+committed+position;
 return .018+.964*sigmoid((strength-threshold-tightness-Math.max(0,pressure-.4)*.12)*11);
}

function potsFor(model,line,foldedMask){
 const {v,hero,opponents}=model;
 const activeIds=[hero.id,...opponents.map(({player})=>player.id)];
 const contributions=v.players.map(p=>p.total??p.bet);
 contributions[hero.id]+=line.cost;
 const eligible=new Map([[hero.id,0]]);
 for(const [i,{player}] of opponents.entries()){
  if(foldedMask&(1<<i))continue;
  contributions[player.id]+=line.costs[i];
  eligible.set(player.id,i+1);
 }
 const levels=[...new Set(contributions.filter(Boolean))].sort((a,b)=>a-b);
 const pots=[];
 let previous=0,refund=0;
 for(const level of levels){
  const contributors=v.players.filter(p=>contributions[p.id]>=level).map(p=>p.id);
  const amount=(level-previous)*contributors.length;
  previous=level;
  if(contributors.length===1){
   if(contributors[0]===hero.id)refund+=amount;
   continue;
  }
  if(contributions[hero.id]<level&&contributors.some(id=>eligible.has(id)))continue;
  const candidates=contributors.filter(id=>eligible.has(id));
  const contenders=(candidates.length?candidates:activeIds.filter(id=>eligible.has(id)))
   .sort((a,b)=>((seatOffset(v,a)+v.players.length-1)%v.players.length)-((seatOffset(v,b)+v.players.length-1)%v.players.length))
   .map(id=>eligible.get(id));
  if(contenders.includes(0))pots.push({amount,contenders});
 }
 return {pots,refund};
}

function payout(model,scores,{pots,refund}){
 let award=0;
 const unit=model.v.betUnit||BET_UNIT;
 for(const {amount,contenders} of pots){
  const best=Math.max(...contenders.map(index=>scores[index]));
  if(scores[0]!==best)continue;
  const winners=contenders.filter(index=>scores[index]===best);
  const units=Math.floor(amount/unit);
  award+=unit*(Math.floor(units/winners.length)+(winners.indexOf(0)<units%winners.length?1:0));
 }
 return {award,refund};
}

function addOutcome(model,line,scores,foldedMask,weight){
 if(weight<=0)return;
 const settlement=line.pots[foldedMask]??=potsFor(model,line,foldedMask);
 const {award,refund}=payout(model,scores,settlement);
 line.ev+=(award+refund-line.cost)*weight;
 if(award>0)line.winProbability+=weight;
 if(foldedMask===(1<<model.opponents.length)-1&&line.action.type==='raise')line.foldProbability+=weight;
}

function actionEstimates(model,scenarios,actions){
 const {v,hero,opponents}=model;
 const lines=actions.map(action=>{
  const cost=action.type==='raise'?action.to-hero.bet:action.type==='call'?v.legal.call:0;
  const target=action.type==='raise'?action.to:v.currentBet;
  const costs=opponents.map(({player})=>clamp(target-player.bet,0,player.stack));
  return {action,cost,costs,pots:[],ev:0,winProbability:0,foldProbability:0};
 });
 let equity=0,totalWeight=0;
 // Action order affects the price after a player elects to call.
 const order=opponents.map((_,i)=>i).sort((a,b)=>
  (opponents[a].player.id-hero.id+v.players.length)%v.players.length
  -(opponents[b].player.id-hero.id+v.players.length)%v.players.length
 );
 for(const {hands,scores,weight,rolls} of scenarios.outcomes){
  totalWeight+=weight;
  if(scores[0]===Math.max(...scores))equity+=weight/scores.filter(score=>score===scores[0]).length;
  for(const line of lines){
   if(line.action.type==='fold')continue;
   let pot=v.pot+line.cost,foldedMask=0;
   if(scenarios.exact){
    const call=continuationProbability(model,opponents[0],hands[0],line.costs[0],pot);
    addOutcome(model,line,scores,0,weight*call);
    addOutcome(model,line,scores,1,weight*(1-call));
    continue;
   }
   for(const i of order){
    const cost=line.costs[i];
    const call=continuationProbability(model,opponents[i],hands[i],cost,pot);
    if(rolls[i]<call)pot+=cost;
    else foldedMask|=1<<i;
   }
   addOutcome(model,line,scores,foldedMask,weight);
  }
 }
 return {
  equity:clamp(equity/totalWeight),
  actions:lines.map(({action,ev,winProbability,foldProbability})=>({
   ...action,
   ev:ev/totalWeight,
   winProbability:clamp(winProbability/totalWeight),
   foldProbability:clamp(foldProbability/totalWeight)
  }))
 };
}

export function advise(v,{raiseTo,samples=2400,rng,memory}={}){
 if(!v.legal||v.hole.length!==2)throw Error('当前无法分析');
 // Keep a chosen sizing comparable with the other actions when adjusting it.
 const key=memory&&!rng?JSON.stringify([samples,v]):null;
 let model,scenarios;
 if(key&&memory.key===key){
  ({model,scenarios}=memory);
 }else{
  model=buildModel(v);
  const random=rng??seededRandom(v.sessionId^Math.imul(v.hand,0x9e3779b9)^v.events.length);
  scenarios=generateScenarios(model,Math.max(1,samples),random);
  if(key)Object.assign(memory,{key,model,scenarios});
 }
 const {equity,actions}=actionEstimates(model,scenarios,candidateActions(v,raiseTo,true));
 const {type,to}=actions.reduce((best,action)=>action.ev>best.ev? action:best);
 const stickiness=model.opponents.map(opponent=>opponent.tendency.sticky);
 const maxSticky=stickiness.length?Math.max(...stickiness):0;
 const avgFold=model.opponents.length?model.opponents.reduce((sum,opponent)=>sum+opponent.tendency.fold,0)/model.opponents.length:0;
 const note=maxSticky>=.24?'对手里有跟注站：少诈唬、多价值下注，大额下注很难让他们弃牌。'
  :avgFold>=.52&&maxSticky<.12?'对手整体偏紧、弃牌较多：可以适当增加诈唬和偷池。':'';
 return {equity,actions,recommended:{type,to},samples:scenarios.outcomes.length,exact:scenarios.exact,note,sticky:maxSticky};
}

function easyDecision(v,{rng,samples}){
 const l=v.legal,persona=v.personality,pre=v.street==='preflop',sticky=clamp(persona.sticky??0,0,.85),humanRead=humanTableRead(v);
 const equity=estimateEquity(v,{rng,samples});
 const potOdds=l.call/(v.pot+l.call||1);
 const power=texture(v.hole,v.board).power;
 const perceivedEquity=equity+(rng()-.5)*.21;
 const to=legalRaise(v,v.currentBet+Math.max(v.bb*2,(v.pot+l.call)*.5));
 if(l.canRaise&&power>((pre&&humanRead.loose)?.68:pre?.79:.72)&&rng()<.48+persona.aggression*.26-sticky*.3+(humanRead.loose?.08:0)){
  return {type:'raise',to,equity,potOdds,samples,reason:'强牌主动下注'};
 }
 if(l.canCheck)return {type:'check',to:0,equity,potOdds,samples,reason:'过牌看下一张'};
 const call=perceivedEquity>potOdds+.055-persona.loose*.10-sticky*.06&&(pre?power>.36:l.call<v.pot||power>.45);
 return {type:call?'call':'fold',to:0,equity,potOdds,samples,reason:call?'牌力适合跟注':'投入偏高'};
}

function expertContext(model){
 const {v,hero,opponents}=model;
 const actions=v.events.filter(event=>event.kind==='action'&&event.street===v.street);
 const raises=actions.filter(event=>event.type==='raise');
 const lastActions=new Map(actions.map(event=>[event.seat,event]));
 const order=opponents.map((_,i)=>i).sort((a,b)=>
  (opponents[a].player.id-hero.id+v.players.length)%v.players.length
  -(opponents[b].player.id-hero.id+v.players.length)%v.players.length
 );
 const actionable=opponents.filter(({player})=>player.stack>0);
 // Preflop ends at the big blind. On subsequent streets the button acts last.
 const after=opponent=>v.street==='preflop'
  ? (opponent.player.id-v.bbSeat-1+v.players.length)%v.players.length>(hero.id-v.bbSeat-1+v.players.length)%v.players.length
  : (seatOffset(v,opponent.player.id)+v.players.length-1)%v.players.length>(seatOffset(v,hero.id)+v.players.length-1)%v.players.length;
 const playersBehind=actionable.filter(after).length;
 const position=actionable.length?1-playersBehind/actionable.length:1;
 const own=texture(v.hole,v.board);
 const representative=opponents[0].range.combos;
 let softer=0;
 for(const {combo} of representative){
  const score=combo.textures[v.street].score;
  if(score<own.score)softer++;
  else if(score===own.score)softer+=.5;
 }
 const percentile=softer/representative.length;
 const maxOpposingTotal=Math.max(hero.bet,...actionable.map(({player})=>player.bet+player.stack));
 return {...model,actions,raises,lastActions,order,playersBehind,position,own,percentile,
  effective:Math.min(hero.stack,maxOpposingTotal-hero.bet),
  limpers:actions.filter(event=>event.type==='call'&&event.amount>0).length
 };
}

function expertActions(model){
 const {v,hero,raises,limpers,position,effective,opponents}=model,l=v.legal;
 const actions=l.canCheck?[{type:'check',to:0}]:[{type:'fold',to:0},{type:'call',to:0}];
 if(!l.canRaise)return actions;
 const pot=v.pot+l.call;
 const effectiveTotal=hero.bet+effective;
 const inPosition=position>=.7;
 let targets;
 if(v.street==='preflop'){
  if(!raises.length){
   const open=v.bb*(2.45+(!inPosition?.25:0)+limpers*(inPosition?.85:1.1));
   targets=[open,open+v.bb*.45];
  }else{
   const aggressor=raises.at(-1).seat;
   const callers=model.actions.slice(model.actions.lastIndexOf(raises.at(-1))+1).filter(e=>e.type==='call'&&e.amount).length;
   const inPositionToRaiser=inPosition||aggressor===v.sbSeat||aggressor===v.bbSeat&&hero.id!==v.sbSeat;
   const multiplier=raises.length===1?(inPositionToRaiser?2.9:3.7):(inPositionToRaiser?2.15:2.55);
   targets=[v.currentBet*(multiplier+callers*.55)];
  }
 }else{
  const fractions=l.call?(v.street==='river'?[.64,1.05]:[.55,.9]):[.32,.65,1];
  const polar=v.street==='river'&&opponents.length<=2;
  if(polar)fractions.push(1.35);
  targets=fractions.map(fraction=>v.currentBet+pot*fraction);
 }
 // Once a raise leaves little behind, compare it directly with the effective shove.
 if(effectiveTotal-v.currentBet<=pot*1.45||targets.some(to=>to>=effectiveTotal*.78))targets.push(effectiveTotal);
 for(const to of new Set(targets.map(target=>legalRaise(v,Math.min(target,effectiveTotal)))))actions.push({type:'raise',to});
 return actions;
}

function pressureProbability(model,opponent,hand,pot,cost,reopens){
 const {v,opponents,raises}=model;
 const {tendency,late}=opponent;
 const pre=v.street==='preflop';
 const strength=hand.percentile+(pre?0:hand.draw*.28);
 const multiway=Math.min(3,opponents.length-1);
 const price=cost/Math.max(v.bb,pot+cost);
 let cutoff;
 if(cost){
  cutoff=pre?(v.players.length===2?.865:.925):.91;
  cutoff+=Math.min(3,raises.length+Number(reopens))*.052+price*.10+multiway*.013;
 }else{
  cutoff=(pre?(v.players.length===2?.62:.77):.68)+multiway*.045-(late?.07:0);
 }
 const valueMix=sigmoid((strength-cutoff+(tendency.agg-.5)*.10)*22);
 const bluff=(.025+tendency.bluff*.34+(hand.blocker?.045:0)+hand.draw*.24)/(1+multiway+raises.length);
 return valueMix*(cost?.46:.70)+(1-valueMix)*bluff;
}

function canHandlePressure(model,price,size,heroHand=model.own){
 const {v,percentile,raises,opponents,position}=model;
 const pre=v.street==='preflop';
 const onThisStreet=heroHand===model.own;
 const strength=onThisStreet?percentile:heroHand.power;
 const tightness=Math.min(.14,raises.length*.035+Math.max(0,opponents.length-1)*.025);
 const pressure=size/Math.max(v.bb,v.pot);
 const base=onThisStreet?(pre?.68:.59):.49;
 const threshold=base+price*.56+tightness+Math.min(.16,pressure*.045)-position*.035;
 const potential=(v.street!=='river'?heroHand.draw*.75:0)+(heroHand.blocker?.022:0);
 // This choice uses the hero's cards and the observed price, never the aggressor's sampled cards.
 return strength+potential>=threshold||(onThisStreet&&percentile>=.995);
}

function expertPayoff(model,action,outcome){
 const {v,hero,opponents,order,lastActions}=model;
 const {hands,scores,rolls,aggression,responses,nextBoard,nextRolls,nextHands}=outcome;
 const aggressive=action.type==='raise';
 let cost=aggressive?action.to-hero.bet:action.type==='call'?v.legal.call:0;
 let target=aggressive?action.to:v.currentBet;
 let pot=v.pot+cost,foldedMask=0,raiser=-1;
 const costs=opponents.map(()=>0);
 const responds=(i,price,sample)=>{
  if(!price)return true;
  const other=opponents[i];
  return sample<continuationProbability(model,other,hands[i],price,pot);
 };
 const pay=(i,price)=>{costs[i]+=price;pot+=price;};
 for(const i of order){
  const opponent=opponents[i],p=opponent.player;
  if(!p.stack)continue;
  const price=Math.min(p.stack,Math.max(0,target-p.bet));
  const last=lastActions.get(p.id);
  const raiseIncrement=Math.max(v.minRaise,aggressive?action.to-v.currentBet:0);
  const reopens=!last||target-last.to>=raiseIncrement;
  const mayRaise=raiser===-1&&hero.stack>cost&&reopens&&!model.unbeatablyTied&&p.stack>price;
  const hand=hands[i].textures[v.street];
  if(mayRaise&&aggression[i]<pressureProbability(model,opponent,hand,pot,price,aggressive)){
   const increment=v.street==='preflop'?Math.max(v.bb*2,target*(aggressive?1.32:1.6)):Math.max(v.bb,(pot+price)*(price?.67:.56));
   const full=Math.max(raiseIncrement,snapBet(increment));
   const capped=Math.min(p.stack+p.bet,hero.stack+hero.bet);
   // A player must either reach a full raise or exhaust their own stack.
   if(capped>=target+full||(capped>target&&capped===p.stack+p.bet)){
    target=Math.min(capped,target+full);raiser=i;
    pay(i,target-p.bet);
    continue;
   }
  }
  if(responds(i,price,rolls[i]))pay(i,price);
  else foldedMask|=1<<i;
 }
 if(raiser>=0){
  // Once raised, revisit only the opponents who still owe chips. The search expands one raise per street.
  for(const i of order){
   if(i===raiser||foldedMask&(1<<i))continue;
   const p=opponents[i].player;
   const extra=Math.min(p.stack-costs[i],Math.max(0,target-p.bet-costs[i]));
   if(responds(i,extra,responses[i]))pay(i,extra);
   else foldedMask|=1<<i;
  }
  const extra=Math.min(hero.stack-cost,Math.max(0,target-hero.bet-cost));
  if(extra&&!canHandlePressure(model,extra/(pot+extra),extra))return -cost;
  cost+=extra;pot+=extra;
 }
 if(nextBoard&&hero.stack>cost){
  const survivors=order.filter(i=>!(foldedMask&(1<<i)));
  // An extra public card and one opponent bet give marginal hands a realistic cost of seeing the river.
  if(survivors.length===1){
   const i=survivors[0],op=opponents[i];
   const chips=Math.min(hero.stack-cost,op.player.stack-costs[i]);
   const price=Math.min(chips,snapBet(Math.max(v.bb,pot*.58)));
   if(price>0){
    const hand=nextHands[i+1]??=texture(hands[i].cards,nextBoard);
    const lead=sigmoid((hand.power+hand.draw*.25-.65)*14)*(.47+op.tendency.agg*.28)+.03+op.tendency.bluff*.19;
    if(nextRolls[i]<lead){
     const heroHand=nextHands[0]??=texture(v.hole,nextBoard);
     if(!canHandlePressure(model,price/(pot+price*2),price,heroHand))return -cost;
     cost+=price;pay(i,price);
    }
   }
  }
 }
 const settlement=potsFor(model,{cost,costs},foldedMask);
 const {award,refund}=payout(model,scores,settlement);
 return award+refund-cost;
}

function expertAdjustment(model,action,equity){
 const {v,own,raises,limpers,percentile,playersBehind,position,opponents,effective}=model;
 const l=v.legal,pre=v.street==='preflop',raisesNow=action.type==='raise';
 const wager=raisesNow?action.to-model.hero.bet:l.call;
 let adjustment=0;
 if(pre){
  const [a,b]=v.hole.map(rank).sort((x,y)=>y-x),suited=suit(v.hole[0])===suit(v.hole[1]);
  const playable=percentile+(suited?.025:0)+(suited&&a===14?.037:0)+(suited&&a-b<=1?.03:0);
  const looseness=(v.personality.loose-.35)*.20;
  if(!raises.length){
   const headsUp=v.players.length===2;
   let threshold=headsUp?.24:clamp(.37+playersBehind*.056,.42,.83);
   if(limpers)threshold=Math.max(.53,threshold)+Math.min(limpers,3)*.038;
   threshold-=looseness;
   // Do not limp routinely when we can open. Out of position, weaker hands need a favorable price.
   if(raisesNow)adjustment+=(playable-threshold)*(v.bb*(playable>threshold?2.0:13));
   else if(l.call){
    const smallBlind=v.seat===v.sbSeat;
    const suitable=limpers&&suited&&l.call<=v.bb&&effective>=v.bb*25;
    adjustment-=(suitable?0:v.bb*(smallBlind?.25:.65))+Math.max(0,.48-playable)*v.bb*4;
   }
  }else{
   const threshold=(raises.length===1?.68:.83)+(1-position)*.07-looseness;
   adjustment-=Math.max(0,threshold-playable)*(v.bb*9+wager*.54);
   if(raisesNow){
    const polarBlocker=suited&&a===14&&b<=5&&raises.length===1&&opponents.length<=3;
    adjustment-=Math.max(0,(raises.length===1?.89:.965)-playable-(polarBlocker?.105:0))*(v.bb*17+wager*.45);
   }
  }
 }else if(raisesNow){
  const multiway=Math.min(3,opponents.length-1);
  const goodValue=equity>.57||percentile>.94;
  const cleanup=own.draw*.32+(own.blocker?.045:0);
  if(!goodValue){
   const marginal=v.street==='river'&&equity>.27&&equity<.55;
   const excess=wager-l.call;
   adjustment-=excess*(.06+multiway*.052+(marginal?.12:0)+(raises.length?.065:0)-cleanup);
  }
 }
 // A sampled runout is easier to realize in position, with draws, or at low stack-to-pot ratios.
 if(v.board.length<5&&wager>0&&effective>wager&&opponents.length>1){
  const realization=.045+(1-position)*.075+Math.min(opponents.length-1,5)*.019-own.draw*.22;
  adjustment-=wager*Math.max(0,realization);
 }
 return adjustment;
}

function wideRangeDecision(v,{rng,samples}){
 const model=buildModel(v),scenarios=generateScenarios(model,samples,rng);
 const {equity,actions}=actionEstimates(model,scenarios,candidateActions(v,undefined,false));
 const l=v.legal,pre=v.street==='preflop',late=latePosition(v,v.seat),persona=v.personality,humanRead=humanTableRead(v);
 const sticky=clamp(persona.sticky??0,0,.85);
 const own=texture(v.hole,v.board);
 const potOdds=l.call/(v.pot+l.call||1);
 const raises=v.events.filter(e=>e.kind==='action'&&e.type==='raise'&&e.street===v.street).length;
 const score=action=>{
  if(action.type==='fold')return 0;
  const wager=action.type==='raise'?action.to-model.hero.bet:l.call;
  let ev=action.ev;
  if(pre){
   const threshold=.61-persona.loose*.18-(late?.065:0)+Math.min(raises,3)*.08-(humanRead.loose?.035:0);
   ev-=Math.max(0,threshold-own.power)*(v.bb*12+wager*.9);
  }
  if(v.board.length<5&&wager>0&&model.opponents.some(({player})=>player.stack>wager)){
   const realization=(late?.06:.13)+Math.max(0,model.opponents.length-1)*.025-own.draw*.22;
   ev-=Math.max(0,realization)*wager;
  }
  if(action.type==='call')ev+=v.bb*sticky*.7+l.call*sticky*.18;
  if(action.type==='raise'){
   const pressured=l.call>v.pot*.17||raises>1;
   const value=equity>Math.max(pressured?.67:.52,1/(model.opponents.length+1)+.08);
   ev-=v.bb*sticky*1.2+(value?0:wager*sticky*.2);
   if(value){ev+=v.bb*persona.aggression*.22;if(humanRead.loose)ev+=v.bb*.22;}
   else{
    if(humanRead.loose)ev-=wager*.12;
    if(!own.blocker&&!own.draw)ev-=wager*(.10-persona.bluff*.1+sticky*.1);
    if(pressured)ev-=Math.max(0,wager-l.call)*(.25-own.draw*.45);
   }
  }
  const variation=.035*Math.min(v.bb*2,v.pot);
  return ev+(rng()-.5)*variation;
 };
 const scored=actions.map(action=>({...action,score:score(action)}));
 const best=scored.reduce((a,b)=>b.score>a.score?b:a);
 return {
  ...best,equity,potOdds,samples:scenarios.outcomes.length,rangeBased:true,
  reason:{fold:'范围与投入不匹配',check:'保留摊牌价值',call:'价格适合继续',raise:'比较各下注尺度的预期收益'}[best.type]
 };
}

function hardDecision(v,{rng,samples}){
 const active=v.players.filter(player=>!player.folded).length;
 // A single response branch is informative in small pots with few active hands.
 // Use range EV with a realization discount where additional raises and side actions dominate.
 if(v.players.length>2&&(v.street==='preflop'||active>3))return wideRangeDecision(v,{rng,samples});
 const model=expertContext(buildModel(v));
 const scenarios=generateScenarios(model,samples,rng,true);
 const actions=expertActions(model);
 const trials=scenarios.outcomes.length;
 let equity=0;
 for(const {scores} of scenarios.outcomes){
  if(scores[0]===Math.max(...scores))equity+=1/scores.filter(score=>score===scores[0]).length;
 }
 equity/=trials;
 const sticky=clamp(v.personality.sticky??0,0,.85);
 const humanRead=humanTableRead(v);
 const scored=actions.map(action=>{
  if(action.type==='fold')return {...action,ev:0,score:0};
  const ev=scenarios.outcomes.reduce((sum,outcome)=>sum+expertPayoff(model,action,outcome),0)/trials;
  const variation=model.unbeatablyTied?0:.04*Math.min(v.bb*2,v.pot);
  let score=ev+expertAdjustment(model,action,equity)+(rng()-.5)*variation;
  if(action.type==='call')score+=v.bb*sticky*.8+v.legal.call*sticky*.16;
  if(action.type==='raise')score-=v.bb*sticky*1.2+(equity<.48?v.bb*sticky*.5:0);
  if(humanRead.loose&&action.type==='raise')score+=equity>.6?v.bb*.25:-v.bb*.2;
  return {...action,ev,score};
 });
 const best=scored.reduce((a,b)=>b.score>a.score?b:a);
 return {
  ...best,equity,potOdds:v.legal.call/(v.pot+v.legal.call||1),samples:trials,rangeBased:true,
  reason:{fold:'价格与对手继续范围不匹配',check:'估计过牌与后续下注的收益',call:'在价格与后续压力之间权衡',raise:'比较不同下注尺度及对手的弃牌、跟注和再加注'}[best.type]
 };
}

function randomStream(){
 const values=new Uint32Array(256);
 let cursor=values.length;
 return ()=>{
  if(cursor===values.length){crypto.getRandomValues(values);cursor=0;}
  return values[cursor++]/4294967296;
 };
}

export function decide(v,{rng=randomStream(),samples,memory={}}={}){
 if(!v.legal)throw Error('Missing legal actions');
 if(v.aiLevel==='easy')return easyDecision(v,{rng,samples:samples??55});
 if(v.aiLevel==='hard')return hardDecision(v,{rng,samples:samples??340});
 return standardDecision(v,{rng,samples:samples??150,memory});
}
