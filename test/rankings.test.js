import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RankingStore} from '../ranking-store.mjs';
import {RANK_WINDOW_MS,rankSummary,rankingRecord,recentRankings} from '../rankings.js';

function settled(at){
 const board=[8,9,10,29,43];
 return {hand:4,at,board,privateHands:[[11,12],[13,15],[16,17]],events:[{kind:'blind',seat:0,amount:10}],
  participants:[
   {seat:0,name:'甲',human:true,folded:false},
   {seat:1,name:'乙',human:true,folded:false},
   {seat:2,name:'丙',human:false,folded:true}
  ],
  result:{
   revealed:[{id:0,hole:[11,12]},{id:1,hole:[13,15]}],contestAwards:[500,0,0],
   pots:[{amount:500,winners:[0],refund:false},{amount:2200,winners:[1],refund:true}]
  }};
}

test('public hand detail records the actual chip pool and only shown cards',()=>{
 const record=rankingRecord(settled(Date.now()),randomUUID(),'online');
 assert.equal(record.pot,500);
 assert.equal(rankSummary(record).handName,'同花顺');
 assert.deepEqual(record.players[2].hole,[]);
 assert.equal(record.players[1].award,0);
 assert.equal('privateHands' in record,false);
 assert.equal(record.pots.length,1);
});

test('ranking selects distinct hands in each metric within a rolling 30 day window',()=>{
 const now=Date.now();
 const latest=rankSummary(rankingRecord(settled(now),randomUUID(),'online'));
 const edge={...latest,id:randomUUID(),at:now-RANK_WINDOW_MS,pot:2000,score:1};
 const expired={...edge,id:randomUUID(),at:edge.at-1,pot:9999};
 const folded={...latest,id:randomUUID(),pot:800,score:null};
 const ranks=recentRankings([latest,latest,edge,expired,folded],now);
 assert.deepEqual(ranks.pots.map(row=>row.id),[edge.id,folded.id,latest.id]);
 assert.deepEqual(ranks.hands.map(row=>row.id),[latest.id,edge.id]);
});

test('ranked hand detail survives a restart and duplicate saves are idempotent',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'river-ranks-'));
 try {
  const store=new RankingStore(directory);
  const record=rankingRecord(settled(Date.now()),randomUUID(),'online');
  store.add(record);store.add(record);
  await store.flush();
  const restarted=new RankingStore(directory);
  await restarted.load(join(directory,'legacy.json'));
  assert.deepEqual(restarted.list().pots.map(row=>row.id),[record.id]);
  assert.deepEqual(await restarted.get(record.id),JSON.parse(JSON.stringify(record)));
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('legacy win and hand entries for the same hand appear once',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'river-legacy-ranks-'));
 try{
  const filename=join(directory,'legacy.json'),hand=settled(Date.now());
  const detail={board:hand.board,players:hand.participants.map(player=>({
   name:player.name,seat:player.seat+1,folded:player.folded,isHuman:player.human,
   hole:hand.result.revealed.find(item=>item.id===player.seat)?.hole||[]
  })),winners:[{seat:1,amount:500}]};
  await writeFile(filename,JSON.stringify([
   {id:'win:100:4:0',at:hand.at,detail},{id:'hand:100:4',at:hand.at,detail}
  ]));
  const store=new RankingStore(join(directory,'new'));
  await store.load(filename);
  assert.equal(store.list().pots.length,1);
  assert.equal(store.list().hands[0].handName,'同花顺');
 }finally{await rm(directory,{recursive:true,force:true});}
});
