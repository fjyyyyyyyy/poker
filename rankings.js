import {evaluate} from './evaluator.js';

export const RANK_LIMIT=20;
export const RANK_WINDOW_MS=30*24*60*60*1000;

export function rankingRecord(hand,id,source) {
 const {result,board}=hand;
 const revealed=new Map(result.revealed.map(entry=>[entry.id,entry.hole]));
 const players=hand.participants.map(participant=>{
  const {seat}=participant,hole=revealed.get(seat)||[];
  const rank=hole.length===2&&board.length===5?evaluate([...hole,...board]):null;
  return {...participant,hole,handName:rank?.name??null,score:rank?.score??null,
   award:result.contestAwards[seat]||0};
 });
 const pots=result.pots.filter(pot=>!pot.refund).map(({amount,winners})=>({amount,winners}));
 const events=hand.events.filter(event=>['action','blind','street'].includes(event.kind)).map(event=>({
  kind:event.kind,seat:event.seat,street:event.street,type:event.type,amount:event.amount,
  to:event.to,board:event.kind==='street'?event.board:undefined,label:event.label,allin:event.allin
 }));
 return {id,source,at:hand.at,number:hand.hand,board,players,pots,events,
  pot:pots.reduce((total,pot)=>total+pot.amount,0)};
}

export function rankSummary(record) {
 const shown=record.players.filter(player=>Number.isFinite(player.score));
 const best=shown.reduce((top,player)=>!top||player.score>top.score?player:top,null);
 return {id:record.id,source:record.source,at:record.at,pot:record.pot,
  score:best?.score??null,handName:best?.handName??null,
  bestPlayers:best?shown.filter(player=>player.score===best.score).map(player=>player.name):[],
  winners:record.players.filter(player=>player.award>0).map(player=>player.name)};
}

export function recentRankings(summaries,now=Date.now()) {
 const recent=new Map();
 for(const item of summaries){
  if(item.at>=now-RANK_WINDOW_MS&&item.at<=now)recent.set(item.id,item);
 }
 const rows=[...recent.values()];
 const top=(field,filter)=>rows.filter(filter).sort((a,b)=>
  b[field]-a[field]||b.at-a.at||a.id.localeCompare(b.id)).slice(0,RANK_LIMIT);
 return {pots:top('pot',row=>row.pot>0),hands:top('score',row=>Number.isFinite(row.score))};
}
