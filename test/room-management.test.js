import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

async function startServer(directory) {
 const child=spawn(process.execPath,[fileURLToPath(new URL('../server.mjs',import.meta.url))],{
  env:{...process.env,HOST:'127.0.0.1',PORT:'0',RIVER_DATA_DIR:directory},
  stdio:['ignore','pipe','pipe']
 });
 const base=await new Promise((resolve,reject)=>{
  let log='';
  const timer=setTimeout(()=>{child.kill();reject(Error('Server did not start: '+log));},6000);
  child.stdout.on('data',chunk=>{
   log+=chunk;
   const match=log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
   if(match){clearTimeout(timer);resolve(match[0]);}
  });
  child.stderr.on('data',chunk=>{log+=chunk;});
  child.once('exit',()=>{clearTimeout(timer);reject(Error(log));});
 });
 return {base,async stop(){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const stopped=once(child,'exit');child.kill('SIGTERM');await stopped;
 }};
}

async function request(base,path,body,token) {
 const response=await fetch(base+path,{
  method:body?'POST':'GET',
  headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},
  body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)
 });
 return {status:response.status,...await response.json()};
}

test('only the host can update seats, and changes preserve the in-progress hand',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'river-http-'));
 let app;
 try{
  app=await startServer(directory);
  const root='/api/rooms';
  const host=await request(app.base,root,{name:'房主',seatCount:4,aiLevel:'hard'});
  assert.equal(host.status,200);
  const path=root+'/'+host.state.code;
  const guest=await request(app.base,path+'/join',{name:'原玩家',seat:1,requestId:randomUUID()});
  assert.equal(guest.status,200);
  const op=(name,extra={},token=host.token)=>request(app.base,path,{op:name,requestId:randomUUID(),...extra},token);
  const state=token=>request(app.base,path,null,token).then(data=>data.state);

  assert.equal((await op('kick',{absoluteSeat:2},guest.token)).status,403);
  let table=(await op('kick',{absoluteSeat:2})).state;
  assert.equal(table.players[2].vacant,true);
  assert.equal(table.players[2].stack,0);
  table=(await op('replaceBot',{absoluteSeat:2})).state;
  assert.equal(table.players[2].vacant,false);
  assert.equal(table.players[2].stack,2000);
  const removed=await request(app.base,path+'/join',{name:'被移出的玩家',seat:2});
  table=(await op('kick',{absoluteSeat:2})).state;
  assert.equal(table.players[2].vacant,true);
  assert.equal((await request(app.base,path,null,removed.token)).status,403);
  const replaced=await request(app.base,path+'/join',{name:'被替换的玩家',seat:2});
  table=(await op('replaceBot',{absoluteSeat:2})).state;
  assert.equal(table.players[2].human,false);
  assert.equal(table.players[2].stack,2000);
  assert.equal((await request(app.base,path,null,replaced.token)).status,403);
  table=(await op('swapSeats',{a:0,b:3})).state;
  assert.equal(table.host,true);
  assert.equal(table.players[0].absoluteSeat,3);
  await op('kick',{absoluteSeat:0});
  await op('kick',{absoluteSeat:2});
  const started=(await op('start')).state;
  const oldHostCards=started.players[0].hole;
  const first=await state(guest.token);
  assert.ok(first.actionOptions.canRaise);
  await op('action',{type:'raise',to:first.actionOptions.max,turnKey:first.turnKey},guest.token);
  const responding=await state(host.token);
  const dealing=(await op('action',{type:'call',turnKey:responding.turnKey})).state;
  assert.equal(dealing.phase,'dealing');
  assert.equal(dealing.pot,4000);

  const arranged=(await op('swapSeats',{a:3,b:0})).state;
  assert.deepEqual(arranged.pendingSwaps,[[3,0]]);
  assert.equal(arranged.players[0].absoluteSeat,3);
  const invite=(await op('seatInvite',{absoluteSeat:1})).invite;
  assert.equal((await request(app.base,path+'/lobby?invite='+invite.token)).invitedSeat,1);
  assert.equal((await request(app.base,path+'/join',{seat:1,reclaim:true,name:'外人'})).status,403);
  const admission={name:'新玩家',invite:invite.token,requestId:randomUUID()};
  const replacement=await request(app.base,path+'/join',admission);
  assert.equal(replacement.status,200);
  assert.equal(replacement.state.waiting,true);
  assert.deepEqual(replacement.state.players[0].hole,[]);
  assert.equal(replacement.state.actionOptions,null);
  assert.equal(replacement.state.pot,4000);
  assert.equal((await request(app.base,path,null,guest.token)).status,403);
  assert.equal((await request(app.base,path+'/join',admission)).token,replacement.token);
  assert.equal((await request(app.base,path+'/join',{...admission,requestId:randomUUID()})).status,403);

  for(let i=0;i<70;i++){
   table=await state(host.token);
   if(table.phase==='complete')break;
   await delay(40);
  }
  assert.equal(table.phase,'complete');
  assert.equal(table.board.length,5);
  assert.deepEqual(table.history[0].heroCards,oldHostCards);
  assert.deepEqual((await state(replacement.token)).history[0].heroCards,[]);
  const ranks=await request(app.base,'/api/leaderboard');
  assert.equal(ranks.pots[0].pot,4000);
  assert.equal(ranks.hands[0].id,ranks.pots[0].id);
  const detailPath='/api/leaderboard/'+ranks.pots[0].id;
  const detail=(await request(app.base,detailPath)).record;
  assert.ok(detail.players.some(player=>player.name==='原玩家'&&player.human));
  assert.ok(detail.events.some(event=>event.type==='raise'));
  assert.equal('privateHands' in detail,false);

  if(table.players[0].stack===0)await op('borrow');
  const second=(await op('start')).state;
  assert.equal(second.hand,2);
  assert.equal(second.players[0].absoluteSeat,0);
  assert.equal(second.players.find(player=>player.absoluteSeat===3).vacant,true);
  assert.deepEqual(second.history[0].heroCards,oldHostCards);
  assert.equal((await state(replacement.token)).waiting,false);
  assert.equal((await state(replacement.token)).players[0].name,'新玩家');

  await app.stop();
  app=await startServer(directory);
  const saved=await request(app.base,detailPath);
  assert.deepEqual(saved.record,detail);
 }finally{
  if(app)await app.stop();
  await rm(directory,{recursive:true,force:true});
 }
});
