import test from 'node:test';
import assert from 'node:assert/strict';
import {advise,decide} from '../ai.js';
import {Game} from '../engine.js';
import {learnResponses,observeHumanAction,responseSpot} from '../opponent-profile.js';
import {seededRandom} from '../personality.js';

function riverView() {
 const game=new Game({seatCount:2,aiLevel:'hard',random:seededRandom(1)});
 game.startHand();
 while(game.street!=='river'||game.phase==='dealing'){
  if(game.phase==='dealing')game.advanceStreet();
  else game.act(game.actor,game.legal().canCheck?'check':'call');
 }
 return game.publicView(game.actor);
}

test('identical river cards play more aggressively against a frequent folder than a caller',()=>{
 const training=['fold','call'].map(action=>{
  const view=riverView();
  const human=view.players.find(player=>player.id!==view.seat);
  for(let i=0;i<35;i++)observeHumanAction(human,'river',action,100,200,true);
  return view;
 });
 const [tight,sticky]=training.map(view=>decide(view,{rng:seededRandom(88)}));
 assert.equal(tight.type,'raise');
 assert.equal(sticky.type,'check');
 const firstRaise=view=>advise(view).actions.find(action=>action.type==='raise').foldProbability;
 assert.ok(firstRaise(training[0])>firstRaise(training[1])+.20);
});

test('reads shrink sparse samples and respond to recent, comparable bet sizes',()=>{
 const human={isHuman:true},spot=responseSpot('river',.5);
 observeHumanAction(human,'river','fold',100,200,true);
 assert.ok(learnResponses(human)[spot].fold<.08);
 for(let i=0;i<40;i++)observeHumanAction(human,'river','fold',100,200,true);
 const folded=learnResponses(human)[spot].fold;
 assert.ok(folded>.35);
 for(let i=0;i<92;i++)observeHumanAction(human,'river','call',100,200,true);
 assert.ok(learnResponses(human)[spot].fold<0);
 for(let i=0;i<32;i++)observeHumanAction(human,'flop','raise',0,200,true);
 assert.ok(learnResponses(human)[responseSpot('flop',0)].raise>.4);
});

test('AI sees public decisions, independent of unshown cards and automatic human timeout actions',()=>{
 const game=new Game({seatCount:3,random:seededRandom(5)});
 game.startHand();
 assert.equal(game.actor,0);
 game.act(0,'call');
 const next=game.actor,first=game.publicView(next);
 assert.equal(first.players[0].isHuman,true);
 assert.ok(first.players[0].observations);
 game.players[0].hole=[1,2];
 game.deck.reverse();
 assert.deepEqual(game.publicView(next),first);
 assert.ok(first.players.every(player=>!('hole' in player)));
 const timeout=new Game({seatCount:2});
 timeout.startHand();
 timeout.act(0,'fold',0,{automatic:true});
 assert.equal(timeout.players[0].observations,undefined);
});
