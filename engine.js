import { evaluate, shuffledDeck, secureRandom } from './evaluator.js';
import {pickNames} from './names.js';
import {newPersonality} from './personality.js';
import {BET_UNIT,ceilBet,isBet} from './bet.js';
export const STREETS=['preflop','flop','turn','river'];
export const STREET_NAMES={preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌'};
export const MIN_SEATS=2,DEFAULT_SEATS=6,MAX_SEATS=9;
// 借款规则：每次借 2,000，累计欠款最多 10,000（5 次），还清后可再借。
export const LOAN_AMOUNT=2000;
export const MAX_DEBT=10000;
export const BORROW_THRESHOLD=1000;
export const TURN_LIMIT_MS=30000;
export const FORCE_REPAY_AT=3500;
export const AI_LEVELS=Object.freeze(['easy','normal','hard']);
export const DEFAULT_AI_LEVEL='normal';
export const PERSONAS=[
 {name:'你',en:'YOU',style:'观察 · 思考 · 决策',color:'#d8bb7b'},
 {name:'林澈',en:'THE ANALYST',style:'紧凶 · 沉着的分析师',color:'#8bb8ab',loose:.27,aggression:.66,bluff:.15,trap:.15,adapt:.8,bio:'耐心筛选起手牌，喜欢用位置施压。会留意你的弃牌频率，也会用强牌设下埋伏。'},
 {name:'Mika',en:'THE SPARK',style:'松凶 · 不安分的进攻者',color:'#dc9c87',loose:.47,aggression:.86,bluff:.34,trap:.06,adapt:.65,bio:'宽范围入池，频繁争夺底池。喜欢半诈唬与持续下注，但也会根据阻断牌选择河牌诈唬。'},
 {name:'顾岩',en:'THE ROCK',style:'紧稳 · 耐心的守望者',color:'#9ca6c6',loose:.2,aggression:.48,bluff:.08,trap:.24,adapt:.45,bio:'起手范围谨慎，重视摊牌价值。很少轻率投入大底池，偶尔用慢打诱导对手继续下注。'},
 {name:'Leo',en:'THE FOX',style:'均衡 · 善变的战术家',color:'#d2b583',loose:.34,aggression:.72,bluff:.24,trap:.25,adapt:.95,bio:'关注下注尺度、位置和你的历史行为。混合价值下注与诈唬，对过度激进的对手会增加抓诈。'},
 {name:'阿岚',en:'THE EXPLORER',style:'松活 · 好奇的读牌者',color:'#b1a2bd',loose:.41,aggression:.56,bluff:.2,trap:.18,adapt:.75,bio:'愿意用更多同花连张看翻牌，重视听牌潜力。遇到频繁诈唬的玩家，倾向用中等强度牌抓诈。'},
 {color:'#7faea9'},
 {color:'#cda38f'},
 {color:'#9fa77b'}
];
export class Game {
 constructor({stack=2000,sb=10,bb=20,random=secureRandom,excludeNames=[],seatCount=DEFAULT_SEATS,aiLevel=DEFAULT_AI_LEVEL}={}) {
  if(!Number.isInteger(seatCount)||seatCount<MIN_SEATS||seatCount>MAX_SEATS)throw RangeError(`人数请选择 ${MIN_SEATS}–${MAX_SEATS} 人`);
  if(!AI_LEVELS.includes(aiLevel))throw RangeError('请选择 AI 强度');
  this.seatCount=seatCount;this.aiLevel=aiLevel;
  const seats=PERSONAS.slice(0,seatCount);
  // 保证牌桌上至少有一位“跟注站/铁头”，人多时偶尔来两位，方便练习针对松被动对手。
  const stationSeats=new Set(),aiCount=seatCount-1;
  if(aiCount>=2)stationSeats.add(1+Math.floor(random()*aiCount));
  else if(aiCount===1&&random()<.5)stationSeats.add(1);
  if(aiCount>=4&&random()<.35){
   const free=[];for(let i=1;i<seatCount;i++)if(!stationSeats.has(i))free.push(i);
   if(free.length)stationSeats.add(free[Math.floor(random()*free.length)]);
  }
  this.personalities=seats.map((_,id)=>newPersonality(id,random,stationSeats.has(id)?'station':null));this.sessionId=Math.floor(random()*4294967296);this.completedHands=0;this.net=0;
  this.sb=sb;this.bb=bb;this.buyin=stack;this.betUnit=BET_UNIT;this.random=random;this.button=-1;this.hand=0;this.phase='idle';this.board=[];this.events=[];this.history=[];this.pot=0;this.actor=null;
  const names=pickNames(random,excludeNames,seatCount);
  this.players=seats.map((_,id)=>({id,isHuman:id===0,name:id?names[id]:"你",stack,debt:0,pendingLoan:0,net:0,loans:[],hole:[],folded:false,bet:0,total:0,lastAction:'',stats:{hands:0,vpip:0,pfr:0,raises:0,calls:0,folds:0,faced:0,foldToBet:0,showdowns:0,shownBluffs:0}}));
 }
 nextSeat(from,predicate) {const count=this.players.length;for(let n=1;n<=count;n++){const i=(from+n)%count;if(predicate(this.players[i]))return i;}return null;}
 active(){return this.players.filter(p=>!p.folded);}
 contenders(){return this.players.filter(p=>!p.folded&&p.stack>0);}
 startHand(){
  if(!['idle','complete'].includes(this.phase))throw Error('Hand in progress');
  this.players.forEach(p=>{p.stack+=p.pendingLoan||0;p.pendingLoan=0;});
  // Chip race any legacy 5-chip residue into 10-chip units before the hand.
  let odd=0;this.players.forEach(p=>{const residue=p.stack%BET_UNIT;if(residue){odd+=residue;p.stack-=residue;}});
  const count=this.players.length;
  for(let i=0;odd>=BET_UNIT;i++){this.players[(this.button+1+i)%count].stack+=BET_UNIT;odd-=BET_UNIT;}
  if(odd>0)this.players[0].stack+=odd;
  if(this.players.filter(p=>p.stack>0).length<2)throw Error('Need two funded players');
  this.hand++;this.board=[];this.deck=shuffledDeck(this.random);this.pot=0;this.currentBet=this.bb;this.minRaise=this.bb;this.events=[];this.result=null;this.street='preflop';this.phase='playing';
  this.button=this.nextSeat(this.button,p=>p.stack>0);
  this.players.forEach(p=>{p.folded=p.stack===0;p.bet=0;p.total=0;p.hole=[];p.lastAction='';p.actedAt=null;p.vpip=false;p.pfr=false;p.startStack=p.stack;if(p.stack>0)p.stats.hands++;});
  const sbSeat=this.active().length===2?this.button:this.nextSeat(this.button,p=>!p.folded);
  const bbSeat=this.nextSeat(sbSeat,p=>!p.folded);this.sbSeat=sbSeat;this.bbSeat=bbSeat;
  for(let r=0;r<2;r++){let i=this.button;for(let k=0;k<this.active().length;k++){i=this.nextSeat(i,p=>!p.folded);this.players[i].hole.push(this.deck.pop());}}
  this.post(sbSeat,this.sb,'小盲');this.post(bbSeat,this.bb,'大盲');
  this.actor=this.nextSeat(bbSeat,p=>!p.folded&&p.stack>0);this.resolveProgress(bbSeat);return this;
 }
 post(id,amount,label){const p=this.players[id],paid=Math.min(p.stack,amount);p.stack-=paid;p.bet+=paid;p.total+=paid;this.pot+=paid;p.lastAction=label;this.events.push({kind:'blind',seat:id,amount:paid,street:this.street,label:'投入'+label});}
 legal(id=this.actor){
  const p=this.players[id];if(this.phase!=='playing'||id!==this.actor||!p)return null;
  const call=Math.min(p.stack,Math.max(0,this.currentBet-p.bet));
  const reopen=p.actedAt===null||this.currentBet-p.actedAt>=this.minRaise;
  const allInTotal=p.bet+p.stack;
  const minFullRaise=ceilBet(Math.max(this.currentBet+this.minRaise,this.currentBet+1));
  // Regular raises use whole units, but the maximum raise is always the exact
  // all-in total. A short all-in may therefore end in an odd chip residue.
  const max=allInTotal;
  const canRaise=reopen&&p.stack>call&&max>this.currentBet&&this.contenders().some(q=>q.id!==id);
  return {call,canCheck:call===0,canRaise,min:canRaise?(max>=minFullRaise?minFullRaise:max):max,max,currentBet:this.currentBet,unit:BET_UNIT,maxIsAllIn:true};
 }
 act(id,type,to=0){
  const l=this.legal(id);if(!l)throw Error('Not your turn');const p=this.players[id];const before=this.currentBet;let paid=0,fullRaise=false;
  if(!['fold','check','call','raise'].includes(type))throw Error('Invalid action');
  if(type==='check'&&!l.canCheck)throw Error('Cannot check');
  if(type==='raise'){
   if(!l.canRaise)throw Error('本轮不能加注');
   // The exact all-in amount is always legal, even if it is not a multiple of
   // the betting unit; ordinary raises must stay on the 10-chip grid.
   if(to!==p.bet+p.stack&&!isBet(to))throw Error(`下注必须是 ${BET_UNIT} 的倍数（全下除外）`);
   if(to<l.min||to>l.max||to<=this.currentBet)throw Error('加注金额不在允许范围内');
  }
  if(l.call>0)p.stats.faced++;
  if(type==='fold'){p.folded=true;p.stats.folds++;if(l.call)p.stats.foldToBet++;p.lastAction='弃牌';}
  if(type==='check')p.lastAction='过牌';
  if(type==='call'||type==='raise'){
   paid=type==='call'?l.call:to-p.bet;p.stack-=paid;p.bet+=paid;p.total+=paid;this.pot+=paid;
   if(this.street==='preflop'&&paid&&!p.vpip){p.vpip=true;p.stats.vpip++;}
   if(type==='raise'){
    const delta=p.bet-this.currentBet;fullRaise=delta>=this.minRaise;if(fullRaise)this.minRaise=delta;
    this.currentBet=p.bet;p.stats.raises++;if(this.street==='preflop'&&!p.pfr){p.pfr=true;p.stats.pfr++;}
    p.lastAction=(before===0?'下注 ':'加注至 ')+p.bet;
   }else{p.stats.calls++;p.lastAction=paid?'跟注 '+paid:'过牌';}
   if(p.stack===0)p.lastAction='ALL IN · '+p.bet;
  }
  p.actedAt=this.currentBet;
  const event={kind:'action',seat:id,type,amount:paid,to:p.bet,pot:this.pot,street:this.street,allin:p.stack===0,fullRaise,board:[...this.board],facing:Math.max(0,before-(p.bet-paid))};
  this.events.push(event);this.resolveProgress(id);return event;
 }
 resolveProgress(from){
  if(this.active().length===1){this.finish();return;}
  const able=this.contenders();
  const need=able.filter(p=>p.bet<this.currentBet||p.actedAt===null);
  // A sole player with chips can only match an outstanding wager, never bet into an empty side pot.
  if(able.length<=1&&(!able.length||able[0].bet>=this.currentBet)) {this.actor=null;this.phase='dealing';return;}
  if(need.length){this.actor=this.nextSeat(from,p=>need.includes(p));return;}
  this.actor=null;if(this.street==='river')this.finish();else this.phase='dealing';
 }
 advanceStreet(){
  if(this.phase!=='dealing')return;
  if(this.street==='river'){this.finish();return;}
  this.deck.pop();const n=this.street==='preflop'?3:1;for(let i=0;i<n;i++)this.board.push(this.deck.pop());
  this.street=STREETS[STREETS.indexOf(this.street)+1];this.currentBet=0;this.minRaise=this.bb;
  this.players.forEach(p=>{p.bet=0;p.actedAt=null;if(!p.folded&&p.stack>0)p.lastAction='';});
  this.events.push({kind:'street',street:this.street,board:[...this.board]});this.phase='playing';
  this.actor=this.nextSeat(this.button,p=>!p.folded&&p.stack>0);this.resolveProgress(this.button);
 }
 splitAward(amount,winners){
  // Whole 10-chip units only. A remainder is paid as extra units from button-left.
  const units=Math.floor(amount/BET_UNIT),share=Math.floor(units/winners.length),extra=units-share*winners.length;
  return new Map(winners.map((id,i)=>[id,(share+(i<extra?1:0))*BET_UNIT]));
 }
 forceRepay(){
  let total=0;
  for(const p of this.players){
   if(p.stack<=FORCE_REPAY_AT||p.debt<=0)continue;
   const amount=Math.min(p.debt,p.stack-FORCE_REPAY_AT);
   if(amount<=0)continue;
   p.stack-=amount;p.debt-=amount;
   p.loans.unshift({type:'repay',amount,hand:this.hand,auto:true,time:Date.now()});
   p.loans=p.loans.slice(0,50);
   total+=amount;
  }
  return total;
 }
 finish(){
  const alive=this.active(),showdown=alive.length>1;
  if(showdown&&this.board.length!==5)throw Error('Incomplete board');
  const levels=[...new Set(this.players.map(p=>p.total).filter(Boolean))].sort((a,b)=>a-b);let prev=0;
  const count=this.players.length,awards=Array(count).fill(0),pots=[];
  const fromButtonLeft=id=>(id-this.button+count-1)%count;
  for(const level of levels){
   const contributors=this.players.filter(p=>p.total>=level),amount=(level-prev)*contributors.length;prev=level;
   if(contributors.length===1){awards[contributors[0].id]+=amount;pots.push({amount,winners:[contributors[0].id],refund:true});continue;}
   const eligible=contributors.filter(p=>!p.folded);
   // A folded contribution level can only occur after an uncontested finish.
   const candidates=eligible.length?eligible:alive;
   const scores=candidates.map(p=>showdown?evaluate([...p.hole,...this.board]).score:0),best=Math.max(...scores);
   const winners=candidates.filter((_,i)=>scores[i]===best).map(p=>p.id).sort((a,b)=>fromButtonLeft(a)-fromButtonLeft(b));
   for(const [id,value] of this.splitAward(amount,winners))awards[id]+=value;pots.push({amount,winners,refund:false});
  }
  const contestAwards=Array(count).fill(0);pots.filter(x=>!x.refund).forEach(pot=>{for(const [id,value] of this.splitAward(pot.amount,pot.winners))contestAwards[id]+=value;});
  this.players.forEach(p=>{p.stack+=awards[p.id];if(showdown&&!p.folded){p.stats.showdowns++;const last=this.events.filter(e=>e.kind==='action'&&e.seat===p.id&&e.street==='river').at(-1);if(last?.type==='raise'&&evaluate([...p.hole,...this.board]).category===0)p.stats.shownBluffs++;}});
  this.result={showdown,awards,contestAwards,pots,winningSeats:contestAwards.flatMap((x,i)=>x>0?[i]:[]),total:this.pot,revealed:showdown?alive.map(p=>({id:p.id,hole:[...p.hole],hand:evaluate([...p.hole,...this.board]).name})):[],heroDelta:this.players[0].stack-this.players[0].startStack};
  this.players.forEach(p=>p.net=(p.net||0)+p.stack-p.startStack);
  this.completedHands++;this.net+=this.result.heroDelta;
  this.phase='complete';this.actor=null;
  this.history.unshift({hand:this.hand,board:[...this.board],heroCards:[...this.players[0].hole],privateHands:this.players.map(p=>[...p.hole]),deltas:this.players.map(p=>p.stack-p.startStack),names:this.players.map(p=>p.name),events:structuredClone(this.events),result:structuredClone(this.result),stacks:this.players.map(p=>p.stack)});this.history=this.history.slice(0,100);
  // 高于 3,500 的部分自动还债（真人/AI 都适用）
  this.forceRepay();
 }
 publicView(id){
  // Deliberate allowlist: never serialize deck, opponent hole cards, burns, or private decisions.
  return {sessionId:this.sessionId,hand:this.hand,seat:id,aiLevel:this.aiLevel,personality:structuredClone(this.personalities[id]),hole:[...this.players[id].hole],board:[...this.board],street:this.street,button:this.button,sbSeat:this.sbSeat,bbSeat:this.bbSeat,sb:this.sb,bb:this.bb,betUnit:this.betUnit,pot:this.pot,currentBet:this.currentBet,minRaise:this.minRaise,legal:this.legal(id),players:this.players.map(p=>({id:p.id,name:p.name,stack:p.stack,bet:p.bet,total:p.total,folded:p.folded,stats:{...p.stats}})),events:structuredClone(this.events)};
 }
 borrow(id){
  const p=this.players[id];if(!p)throw Error('玩家不存在');
  if(p.stack>=BORROW_THRESHOLD)throw Error(`只有筹码低于 ${BORROW_THRESHOLD.toLocaleString('en-US')} 时才能借款`);
  if(p.pendingLoan)throw Error('已有一笔借款将在下手到账，到账后才能再借');
  const remaining=Math.max(0,MAX_DEBT-p.debt);
  if(!remaining)throw Error(`借款已达上限（最多 ${MAX_DEBT.toLocaleString('en-US')}）`);
  const amount=Math.min(LOAN_AMOUNT,remaining);
  const pending=!['idle','complete'].includes(this.phase);
  p.debt+=amount;if(pending)p.pendingLoan+=amount;else p.stack+=amount;
  p.loans.unshift({type:'borrow',amount,hand:this.hand,pending,time:Date.now()});p.loans=p.loans.slice(0,50);
  return pending;
 }
 borrowable(id=0){const p=this.players[id];if(!p||p.pendingLoan||p.stack>=BORROW_THRESHOLD)return 0;return Math.max(0,MAX_DEBT-p.debt);}
 canBorrow(id=0){const p=this.players[id];return !!p&&!p.pendingLoan&&p.stack<BORROW_THRESHOLD&&p.debt<MAX_DEBT;}
 repayable(id){
  const p=this.players[id];if(!p)return 0;
  const inHand=this.phase==='playing'||this.phase==='dealing';
  // While still in the hand, keep enough chips to match the current bet.
  const reserved=inHand&&!p.folded?Math.min(p.stack,Math.max(0,this.currentBet-p.bet)):0;
  return Math.max(0,Math.min(p.stack-reserved,p.debt));
 }
 repay(id){
  const p=this.players[id];if(!p)throw Error('玩家不存在');const amount=this.repayable(id);
  if(!amount)return 0;
  const inHand=this.phase==='playing'||this.phase==='dealing';
  p.stack-=amount;p.debt-=amount;
  // Repayment is not a poker loss. Keep the hand delta excluding the repaid chips.
  if(inHand&&Number.isFinite(p.startStack))p.startStack-=amount;
  p.loans.unshift({type:'repay',amount,hand:this.hand,time:Date.now()});p.loans=p.loans.slice(0,50);return amount;
 }
 refillBusted(humanSeats=[0]){if(!['complete','idle'].includes(this.phase))return;this.players.forEach(p=>{if(!humanSeats.includes(p.id)&&p.stack===0&&!p.pendingLoan&&this.borrowable(p.id)>0)this.borrow(p.id);});}

}
