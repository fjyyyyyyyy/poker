import {Game,PERSONAS,STREET_NAMES,MIN_SEATS,MAX_SEATS,DEFAULT_SEATS,DEFAULT_AI_LEVEL,MAX_DEBT,LOAN_AMOUNT,BORROW_THRESHOLD,TURN_LIMIT_MS,FORCE_REPAY_AT} from './engine.js';
import {BET_UNIT,snapBet} from './bet.js';
import {EMOTES,EMOTE_COOLDOWN_MS} from './emotes.js';
import {SUITS,RANKS,suit,cardText} from './evaluator.js';
const $=s=>document.querySelector(s),fmt=n=>Math.round(n).toLocaleString('en-US');
const levelLabels={easy:'入门',normal:'标准',hard:'高手'};
const prefs={sound:true,volume:.45,speed:1,autoNext:false,assist:false,seatCount:DEFAULT_SEATS,aiLevel:DEFAULT_AI_LEVEL,turnSeconds:30,allInMusic:'kpl'};
const ALL_IN_TRACKS={default:{src:'allin.mp3',label:'原版全下曲'},kpl:{src:'allin-kpl.m4a',label:'我的音乐 · 巅峰对决片段'}};
const TURN_VALUES=[15,30,45,60,120,300];
function turnLabel(ms){const s=Math.max(1,Math.round(ms/1000));return s>=60?`${Math.round(s/60)} 分钟`:`${s} 秒`;}
function currentTurnMs(){return online?(online.turnMs||TURN_LIMIT_MS):(Number(prefs.turnSeconds||30)*1000);}
const SESSION_KEY='river-room-session';
function readSession(){
 try{
  const raw=localStorage.getItem(SESSION_KEY)||sessionStorage.getItem(SESSION_KEY);
  const saved=JSON.parse(raw||'null');
  if(saved?.code&&saved?.token)return saved;
 }catch{}
 return null;
}
function writeSession(saved){
 try{
  const raw=JSON.stringify(saved);
  localStorage.setItem(SESSION_KEY,raw);
  sessionStorage.setItem(SESSION_KEY,raw);
 }catch{}
}
function clearSession(){
 try{localStorage.removeItem(SESSION_KEY);}catch{}
 try{sessionStorage.removeItem(SESSION_KEY);}catch{}
}
try{Object.assign(prefs,JSON.parse(localStorage.getItem('river-prefs')||'{}'));}catch{}
let online=null,pollTimer=null,onlineBusy=false;
let game=new Game(),generation=0,busy=false,sideTab='live',raiseTo=40,previousActor=null,previousHand=0,previousStreet=null,toastTimer,audioContext,reviewViews=[];
let launchMode='single',atTable=false,connecting=false;
const workers=new Map();
const pending=new Map();
let requestId=0,advisorKey='',advisorContext='',advisorTimer,selectRaiseAmount;
let actionRenderKey='';
const mobileLayout=matchMedia('(max-width: 650px)');
const hiddenSidebar=matchMedia('(max-width: 1050px)');
const markupCache=new WeakMap();

function setText(node,value){if(node.textContent!==value)node.textContent=value;}
function setMarkup(node,markup){
 if(markupCache.get(node)===markup)return false;
 node.innerHTML=markup;markupCache.set(node,markup);return true;
}

function stopWorker(key){
 const worker=workers.get(key);
 if(!worker)return;
 worker.terminate();workers.delete(key);
 for(const [id,p] of pending)if(p.worker===worker){pending.delete(id);p.reject(Error('AI 计算中断'));}
}
function compute(view,mode='action',to){
 return new Promise((resolve,reject)=>{
  const key=mode==='action'?view.seat:mode;
  let worker=workers.get(key);
  if(!worker){
   worker=new Worker('./ai-worker.js',{type:'module'});
   worker.onmessage=({data})=>{
    const request=pending.get(data.id);
    if(!request)return;
    pending.delete(data.id);
    if(data.error)request.reject(Error(data.error));else request.resolve(data.result);
   };
   worker.onerror=()=>{if(workers.get(key)===worker)stopWorker(key);};
   workers.set(key,worker);
  }
  const id=++requestId;
  pending.set(id,{resolve,reject,worker});
  try{worker.postMessage({id,view,mode,raiseTo:to});}
  catch(error){pending.delete(id);reject(error);}
 });
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function savePrefs(){try{localStorage.setItem('river-prefs',JSON.stringify(prefs));}catch{}}
function toast(text){$('#toast').textContent=text;$('#toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),3200);}
function initAudio(){const Audio=window.AudioContext||window.webkitAudioContext;if(Audio){audioContext??=new Audio();if(audioContext.state==='suspended')audioContext.resume().catch(()=>{});}updateSound();}
function sound(type){
 if(!prefs.sound||!audioContext)return;const ctx=audioContext,now=ctx.currentTime,vol=prefs.volume*.3;
 if(type==='allin'){allInStinger(ctx,now,Math.min(.9,prefs.volume*1.1));return;}
 if(type==='showdown'){showdownStinger(ctx,now,Math.min(.8,prefs.volume));return;}
 if(type==='winner'){winnerStinger(ctx,now,Math.min(.9,prefs.volume));return;}
 if(type==='sdflip'){
  const length=Math.floor(ctx.sampleRate*.04),buffer=ctx.createBuffer(1,length,ctx.sampleRate),data=buffer.getChannelData(0);
  for(let i=0;i<length;i++)data[i]=(Math.random()*2-1)*Math.exp(-i/(length*.15));
  const src=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),g=ctx.createGain();
  src.buffer=buffer;filter.type='bandpass';filter.frequency.value=1700+Math.random()*800;filter.Q.value=1.8;
  g.gain.value=vol*.7;src.connect(filter);filter.connect(g);g.connect(ctx.destination);src.start(now);
  const o=ctx.createOscillator(),og=ctx.createGain();o.type='triangle';o.frequency.setValueAtTime(1100,now);o.frequency.exponentialRampToValueAtTime(320,now+.06);
  og.gain.setValueAtTime(vol*.22,now);og.gain.exponentialRampToValueAtTime(.001,now+.08);o.connect(og);og.connect(ctx.destination);o.start(now);o.stop(now+.09);
  return;
 }
 if(type==='win'||type==='turn'){
  const notes=type==='win'?[523.25,659.25,783.99]:[659.25,880];notes.forEach((f,i)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.type='sine';o.frequency.value=f;g.gain.setValueAtTime(0,now+i*.1);g.gain.linearRampToValueAtTime(vol*.35,now+i*.1+.01);g.gain.exponentialRampToValueAtTime(.001,now+i*.1+.5);o.connect(g);g.connect(ctx.destination);o.start(now+i*.1);o.stop(now+i*.1+.52);});return;
 }
 const times=type==='chips'?4:type==='deal'?2:1;
 for(let k=0;k<times;k++){
  const at=now+k*(type==='chips'?.045:.06),length=type==='deal'?.12:.055,buffer=ctx.createBuffer(1,ctx.sampleRate*length,ctx.sampleRate),a=buffer.getChannelData(0);
  for(let i=0;i<a.length;i++)a[i]=(Math.random()*2-1)*Math.exp(-i/(a.length*.2));
  const source=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),gain=ctx.createGain();source.buffer=buffer;filter.type='bandpass';filter.frequency.value=type==='deal'?2900:1500+k*500;filter.Q.value=type==='deal'?.5:2.5;gain.gain.value=vol*(type==='chips'?.8:.45);source.connect(filter);filter.connect(gain);gain.connect(ctx.destination);source.start(at);
  if(type==='chips'){const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=1850+k*410;o.type='triangle';g.gain.setValueAtTime(vol*.12,at);g.gain.exponentialRampToValueAtTime(.001,at+.07);o.connect(g);g.connect(ctx.destination);o.start(at);o.stop(at+.08);}
 }
}
function allInStinger(ctx,now,level){
 if(level<=0)return;
 // 原创 ~2 秒的 BP 风格全下音效：低频冲击 + 铜管式和弦 + 噪声撞击，不包含任何版权旋律。
 const master=ctx.createGain();
 master.gain.setValueAtTime(.0001,now);
 master.gain.exponentialRampToValueAtTime(Math.max(.02,level),now+.05);
 master.gain.setValueAtTime(Math.max(.02,level),now+1.35);
 master.gain.exponentialRampToValueAtTime(.0001,now+2.15);
 master.connect(ctx.destination);
 const sub=ctx.createOscillator(),subGain=ctx.createGain();
 sub.type='sine';sub.frequency.setValueAtTime(128,now);sub.frequency.exponentialRampToValueAtTime(40,now+.72);
 subGain.gain.setValueAtTime(.85,now);subGain.gain.exponentialRampToValueAtTime(.0001,now+1.15);
 sub.connect(subGain).connect(master);sub.start(now);sub.stop(now+1.2);
 const length=Math.floor(ctx.sampleRate*.55),buffer=ctx.createBuffer(1,length,ctx.sampleRate),data=buffer.getChannelData(0);
 for(let i=0;i<length;i++){const t=i/length;data[i]=(Math.random()*2-1)*Math.pow(1-t,3);}
 const noise=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),noiseGain=ctx.createGain();
 noise.buffer=buffer;filter.type='lowpass';filter.frequency.setValueAtTime(2800,now);filter.frequency.exponentialRampToValueAtTime(260,now+.5);
 noiseGain.gain.setValueAtTime(.5,now);noiseGain.gain.exponentialRampToValueAtTime(.0001,now+.55);
 noise.connect(filter).connect(noiseGain).connect(master);noise.start(now);
 [146.83,174.61,220,293.66,349.23].forEach((frequency,index)=>{
  const osc=ctx.createOscillator(),low=ctx.createBiquadFilter(),gain=ctx.createGain();
  osc.type='sawtooth';osc.frequency.value=frequency;osc.detune.value=(index-2)*6;
  low.type='lowpass';low.frequency.setValueAtTime(520,now);low.frequency.linearRampToValueAtTime(3000,now+.3);low.frequency.exponentialRampToValueAtTime(680,now+1.9);
  gain.gain.setValueAtTime(.0001,now);gain.gain.linearRampToValueAtTime(.055,now+.12+index*.02);gain.gain.setValueAtTime(.055,now+1.2);gain.gain.exponentialRampToValueAtTime(.0001,now+2.05);
  osc.connect(low).connect(gain).connect(master);osc.start(now);osc.stop(now+2.1);
 });
 const shimmer=ctx.createOscillator(),shimmerGain=ctx.createGain();
 shimmer.type='triangle';shimmer.frequency.setValueAtTime(1760,now);shimmer.frequency.exponentialRampToValueAtTime(820,now+.9);
 shimmerGain.gain.setValueAtTime(.045,now);shimmerGain.gain.exponentialRampToValueAtTime(.0001,now+.95);
 shimmer.connect(shimmerGain).connect(master);shimmer.start(now);shimmer.stop(now+1);
}
function detectAllIn(){
 if(suppressAllInFx){suppressAllInFx=false;allInHand=game.hand;allInSeen=game.events.length;return;}
 if(game.hand!==allInHand){allInHand=game.hand;allInSeen=0;}
 const events=game.events;
 if(allInSeen>events.length)allInSeen=events.length;
 let latest=null;
 for(let i=allInSeen;i<events.length;i++){const event=events[i];if(event.kind==='action'&&event.allin)latest=event;}
 allInSeen=events.length;
 if(latest)triggerAllIn(latest);
}
let localEmoteAt=0,seatEmoteTimers=[];
function emoteCooldownRemaining(){return online?Math.max(0,(online.emoteCooldownAt||0)-Date.now()):Math.max(0,localEmoteAt-Date.now());}
function showEmote(seatId,emote){
 const seat=$('#seats')?.children[seatId];if(!seat)return;
 const bubble=seat.querySelector('.seat-emote');if(!bubble)return;
 bubble.innerHTML=`<span class="seat-emote-emoji">${emote.emoji}</span><span class="seat-emote-text">${emote.text}</span>`;
 const scene=$('#tableScene'),seatRect=seat.getBoundingClientRect(),sceneRect=scene?.getBoundingClientRect();
 bubble.classList.toggle('below',!!sceneRect&&seatRect.top-52<sceneRect.top+6);
 bubble.hidden=false;
 bubble.classList.remove('show');void bubble.offsetWidth;bubble.classList.add('show');
 clearTimeout(seatEmoteTimers[seatId]);
 seatEmoteTimers[seatId]=setTimeout(()=>{bubble.hidden=true;bubble.classList.remove('show');},3200);
}
function renderEmotePanel(){
 const grid=$('#emoteGrid');if(!grid)return;
 const balance=game.players[0]?.stack||0,cd=emoteCooldownRemaining();
 setText($('#emoteBalance'),`余额 ${fmt(balance)}`);
 const cdEl=$('#emoteCooldown');if(cdEl)cdEl.textContent=cd>0?`冷却 ${Math.ceil(cd/1000)}s`:'可用';
 grid.innerHTML=EMOTES.map(e=>`<button type="button" class="emote-item" data-emote="${e.id}" ${cd>0||balance<e.cost?'disabled':''}><span class="emote-emoji">${e.emoji}</span><span class="emote-text">${e.text}</span><span class="emote-cost">${e.cost} 筹码</span></button>`).join('');
 grid.querySelectorAll('.emote-item').forEach(button=>{button.onclick=()=>sendEmote(button.dataset.emote);});
}
async function sendEmote(id){
 const emote=EMOTES.find(item=>item.id===id);if(!emote)return;
 const cd=emoteCooldownRemaining();if(cd>0)return toast(`表情冷却中，还需 ${Math.ceil(cd/1000)} 秒`);
 const balance=game.players[0]?.stack||0;if(balance<emote.cost)return toast(`筹码不足，这个表情要 ${emote.cost} 筹码`);
 if(online){
  if(online.spectator||online.away)return;
  try{await roomOp('emote',{emote:id});const panel=$('#emotePanel');if(panel)panel.hidden=true;renderEmotePanel();}catch(error){toast(error.message);}
 }else{
  game.players[0].stack-=emote.cost;
  localEmoteAt=Date.now()+EMOTE_COOLDOWN_MS;
  game.events.push({kind:'emote',seat:0,id:emote.id,emoji:emote.emoji,text:emote.text,cost:emote.cost,hand:game.hand,time:Date.now()});
  const panel=$('#emotePanel');if(panel)panel.hidden=true;
  render();showEmote(0,emote);sound('tap');
 }
}
let showdownKey='',showdownTimer,showdownWinTimer,showdownSoundTimers=[],showdownOpen=false,showdownAllInTail=false,showdownDoneResolve=null;
const ALL_IN_VOLUME=.42,SHOWDOWN_BED_VOLUME=.10,SHOWDOWN_TAIL_VOLUME=.26;
function detectShowdown(){
 const revealed=game.result?.revealed||[];
 if(revealed.length<2)return;
 const key=`${game.sessionId}:${game.hand}`;
 if(key===showdownKey)return;
 showdownKey=key;
 showShowdown(revealed);
}
function waitShowdownDone(){
 if(!showdownOpen)return Promise.resolve();
 return new Promise(resolve=>{showdownDoneResolve=resolve;});
}
function hideShowdown(){
 const fx=$('#showdownFx');if(!fx)return;
 clearTimeout(showdownTimer);clearTimeout(showdownWinTimer);
 showdownSoundTimers.forEach(clearTimeout);showdownSoundTimers=[];
 fx.classList.remove('show','sd-win');
 const sparks=$('#sdSparks');if(sparks)sparks.innerHTML='';
 if(showdownOpen){
  showdownOpen=false;
  if(showdownDoneResolve){showdownDoneResolve();showdownDoneResolve=null;}
  if(showdownAllInTail&&customPlayer&&prefs.sound){
   showdownAllInTail=false;
   customStartedAt=Date.now();
   try{customPlayer.volume=Math.max(0,Math.min(1,prefs.volume*SHOWDOWN_TAIL_VOLUME));if(customPlayer.paused)customPlayer.play().catch(()=>{});}catch{}
   setTimeout(()=>stopCustomAllIn(),2000);
   // BGM 继续保持压低，等全下音乐尾音淡出后再由 stopCustomAllIn 恢复
  }else{
   showdownAllInTail=false;bgmDucked=false;resumeBgm();
  }
 }
}
function spawnShowdownSparks(){
 const holder=$('#sdSparks');if(!holder)return;holder.innerHTML='';
 for(let i=0;i<24;i++){
  const spark=document.createElement('i');
  spark.style.setProperty('--angle',`${i*15+Math.random()*12}deg`);
  spark.style.setProperty('--dist',`${100+Math.random()*190}px`);
  spark.style.animationDelay=`${Math.random()*.12}s`;
  holder.append(spark);
 }
}
function showShowdown(revealed){
 const fx=$('#showdownFx');if(!fx)return;
 hideShowdown();showdownOpen=true;bgmDucked=true;clearTimeout(bgmResumeTimer);pauseBgm();
 if(customPlayer&&prefs.sound){
  try{customPlayer.volume=Math.max(0,Math.min(1,prefs.volume*SHOWDOWN_BED_VOLUME));if(customPlayer.paused)customPlayer.play().catch(()=>{});}catch{}
  clearTimeout(customStopTimer);showdownAllInTail=true;
 }
 const winners=new Set(game.result.winningSeats||[]);
 let cardSeq=0;
 const panels=revealed.map((item,index)=>{
  const player=game.players[item.id],win=winners.has(item.id),hole=item.hole||[],first=cardSeq;
  const cards=hole.map(c=>`<div class="sd-card" style="--d:${cardSeq++}">${card(c)}</div>`).join('');
  const last=first+hole.length-1;
  return `<div class="sd-panel ${win?'winner':''}" style="--i:${index};--w:${last};--t:${cardSeq-1}">
   <div class="sd-avatar">${avatar(item.id)}</div>
   <div class="sd-name">${player?.name||'玩家'}</div>
   <div class="sd-hand" style="--r:${last}">${win?'<span class="sd-crown">♛</span>':''}${item.hand||'—'}</div>
   <div class="sd-cards">${cards}</div>
   <div class="sd-award" style="--r:${last}">${win?`+${fmt(game.result.contestAwards[item.id]||0)}`:''}</div>
  </div>`;
 });
 setMarkup($('#showdownPanels'),revealed.length===2?`${panels[0]}<div class="sd-vs">VS</div>${panels[1]}`:panels.join(''));
 [...document.querySelectorAll('#showdownPanels .sd-panel')].forEach(panel=>panel.style.setProperty('--t',String(cardSeq-1)));
 setMarkup($('#showdownBoard'),game.board.map((c,i)=>`<div class="sd-card" style="--d:${i}">${card(c)}</div>`).join(''));
 const winnerItems=revealed.filter(item=>winners.has(item.id));
 const names=winnerItems.map(item=>game.players[item.id]?.name||'玩家').join('、');
 const hand=winnerItems[0]?.hand||'最好牌型';
 const totalAward=winnerItems.reduce((sum,item)=>sum+(game.result.contestAwards[item.id]||0),0);
 const resultEl=$('#showdownResult');
 setMarkup(resultEl,`<span class="sd-result-label">${winnerItems.length>1?'WINNERS':'WINNER'}</span><strong>${names}</strong><span class="sd-result-sub">以 ${hand} 拿下 +${fmt(totalAward)}</span>`);
 const winAt=1.35+(cardSeq-1)*.26,resultAt=winAt+.65;
 resultEl.style.setProperty('--sd-delay',`${resultAt.toFixed(2)}s`);
 fx.classList.remove('show','sd-win');void fx.offsetWidth;fx.classList.add('show');
 sound('showdown');
 showdownSoundTimers=[];
 for(let i=0;i<5;i++)showdownSoundTimers.push(setTimeout(()=>sound('sdflip'),50+i*100));
 for(let i=0;i<cardSeq;i++)showdownSoundTimers.push(setTimeout(()=>sound('sdflip'),950+i*260));
 showdownWinTimer=setTimeout(()=>{
  if(!fx.classList.contains('show'))return;
  fx.classList.add('sd-win');spawnShowdownSparks();sound('winner');
 },winAt*1000);
 const hold=Math.max(10000,(winAt+5)*1000);
 showdownTimer=setTimeout(hideShowdown,hold);
}
function audioDb(){
 audioDbPromise??=new Promise((resolve,reject)=>{
  const request=indexedDB.open('river-room-audio',1);
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('audio'))request.result.createObjectStore('audio');};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
 return audioDbPromise;
}
async function readCustomAllIn(){
 try{
  const db=await audioDb();
  const record=await new Promise((resolve,reject)=>{const tx=db.transaction('audio','readonly'),request=tx.objectStore('audio').get('allin');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  if(record?.blob)customAllIn={url:URL.createObjectURL(record.blob),name:record.name||'自定义音频'};
 }catch{customAllIn=null;}
}
async function writeCustomAllIn(file){
 stopCustomAllIn();
 const db=await audioDb();
 await new Promise((resolve,reject)=>{const tx=db.transaction('audio','readwrite');tx.objectStore('audio').put({blob:file,name:file.name},'allin');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});
 if(customAllIn?.url)URL.revokeObjectURL(customAllIn.url);
 customAllIn={url:URL.createObjectURL(file),name:file.name};
}
async function clearCustomAllIn(){
 stopCustomAllIn();
 try{const db=await audioDb();await new Promise((resolve,reject)=>{const tx=db.transaction('audio','readwrite');tx.objectStore('audio').delete('allin');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});}catch{}
 if(customAllIn?.url)URL.revokeObjectURL(customAllIn.url);
 customAllIn=null;
 if(customPlayer){try{customPlayer.pause();}catch{}customPlayer=null;}
}
function stopCustomAllIn(){
 if(!customPlayer)return;
 clearTimeout(customStopTimer);
 const audio=customPlayer;
 customPlayer=null;
 const wait=Math.max(0,2200-(Date.now()-customStartedAt));
 customStopTimer=setTimeout(()=>{
  const step=Math.max(.02,audio.volume/12);
  const fade=setInterval(()=>{audio.volume=Math.max(0,audio.volume-step);if(audio.volume<=0){clearInterval(fade);try{audio.pause();}catch{}}},60);
  setTimeout(()=>{try{audio.pause();}catch{}},1200);
 },wait);
 clearTimeout(bgmResumeTimer);
 bgmResumeTimer=setTimeout(()=>{if(!showdownOpen){bgmDucked=false;resumeBgm();}},wait+1400);
}
let bgmDucked=false,bgmResumeTimer;
function startBgm(){
 const bgm=$('#bgm');if(!bgm||!prefs.sound||bgmDucked)return;
 bgm.volume=Math.max(0,Math.min(.5,prefs.volume*.18));
 if(bgm.paused)bgm.play().catch(()=>{});
}
function pauseBgm(){const bgm=$('#bgm');if(bgm&&!bgm.paused)bgm.pause();}
function resumeBgm(){const bgm=$('#bgm');if(!bgm||!prefs.sound||!atTable)return;if(bgm.paused)bgm.play().catch(()=>{});}
function updateBgmVolume(){const bgm=$('#bgm');if(bgm)bgm.volume=Math.max(0,Math.min(.5,prefs.volume*.18));}
function primeAllInAudio(){
 if(allInTrackPrimed)return;
 const track=$('#allInTrack');if(!track)return;
 allInTrackPrimed=true;
 try{track.load();}catch{}
}
function selectedAllInMode(){
 if(prefs.allInMusic==='custom')return customAllIn?'custom':'kpl';
 return ALL_IN_TRACKS[prefs.allInMusic]?prefs.allInMusic:'kpl';
}
function applyAllInTrackSource(){
 const track=$('#allInTrack');if(!track)return;
 const mode=prefs.allInMusic==='default'?'default':'kpl';
 const source=ALL_IN_TRACKS[mode].src;
 if(!track.getAttribute('src')?.endsWith(source)){track.setAttribute('src',source);try{track.load();}catch{}}
}
function updateAllInTrackLabel(){
 const label=$('#allInTrackName');
 if(label)setText(label,prefs.allInMusic==='custom'?(customAllIn?.name||'请选择自定义文件'):ALL_IN_TRACKS[selectedAllInMode()].label);
}
function triggerAllIn(event){
 const player=game.players[event.seat];if(!player)return;
 const overlay=$('#allInFx');if(!overlay)return;
 setText($('#allInName'),player.name||'玩家');
 setText($('#allInAmount'),`${fmt(player.total||event.to||event.amount)} 筹码`);
 overlay.classList.remove('show');void overlay.offsetWidth;overlay.classList.add('show');
 const scene=$('#tableScene');scene.classList.remove('all-in-impact');void scene.offsetWidth;scene.classList.add('all-in-impact');
 clearTimeout(allInTimer);
 allInTimer=setTimeout(()=>overlay.classList.remove('show'),2050);
 setTimeout(()=>scene.classList.remove('all-in-impact'),720);
 initAudio();
 applyAllInTrackSource();
 const builtinTrack=$('#allInTrack');
 const useCustom=selectedAllInMode()==='custom'&&!!customAllIn;
 if(prefs.sound){bgmDucked=true;clearTimeout(bgmResumeTimer);pauseBgm();}
 if(prefs.sound&&(useCustom||builtinTrack)){
  try{
   if(customPlayer){try{customPlayer.pause();}catch{}}
   clearTimeout(customStopTimer);
   const audio=useCustom?new Audio(customAllIn.url):builtinTrack;
   customPlayer=audio;customStartedAt=Date.now();musicHand=game.hand;
   audio.volume=Math.max(0,Math.min(1,prefs.volume*ALL_IN_VOLUME));
   try{audio.currentTime=0;}catch{}
   audio.loop=true;
   audio.play().catch(()=>{if(customPlayer===audio)customPlayer=null;sound('allin');bgmDucked=false;resumeBgm();});
  }catch{sound('allin');}
 }else sound('allin');
}
function updateSound(){if(!prefs.sound){stopCustomAllIn();pauseBgm();}else if(atTable){startBgm();}$('#soundToggle').innerHTML=`${prefs.sound?'♫':'♪'}<span>${prefs.sound?'音效开':'音效关'}</span>`;$('#soundToggle').setAttribute('aria-label',prefs.sound?'关闭音效':'开启音效');}
function avatar(id){
 const bg=['#d9d0a9','#819d8d','#b78e77','#8a97a6','#b5a181','#a18d9e','#89a4a7','#a3a976','#bb8c90'][id],skin=['#d7b48b','#c79f7e','#e4bd9b','#d0b19a','#d0a582','#d9b393','#b98c6a','#e2b496','#cda080'][id],shirt=['#3b5445','#344f48','#5a4947','#3d485b','#4c5141','#53465c','#31505d','#535839','#5b3e46'][id];
 const hair=[`M21 30Q18 9 33 10Q49 10 46 31L42 21 25 20Z`,`M20 31L19 22Q18 9 34 10Q49 12 46 31L40 23 23 24Z`,`M19 50Q10 28 21 16Q37 1 47 23L48 48 40 43 43 27 25 25 25 43Z`,`M20 28Q19 10 34 11Q48 12 45 29L42 21 25 21Z`,`M19 30Q16 14 29 11Q48 7 47 30L41 23Q29 27 25 20Z`,`M18 47Q12 28 20 18Q29 4 43 15Q51 25 47 48L40 45 43 28 24 25 25 46Z`,`M20 28Q17 13 25 13Q27 7 35 11Q48 9 47 29L43 25 25 22Z`,`M17 47Q11 26 22 15Q29 8 40 14Q52 19 47 46L43 41 43 23 24 26 24 42Z`,`M20 34Q15 22 20 15Q31 5 44 14Q51 20 46 33L40 22 25 25Z`][id];
 return `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="a${id}" x2="0" y2="1"><stop stop-color="${bg}"/><stop offset="1" stop-color="${shirt}"/></linearGradient></defs><rect width="64" height="64" fill="url(#a${id})"/><circle cx="51" cy="12" r="23" fill="#fff" opacity=".07"/><path d="M7 66Q8 48 26 46H39Q57 48 59 66" fill="${shirt}"/><path d="M27 40v9l6 8 6-8V40" fill="${skin}"/><path d="${hair}" fill="#302f2b"/><ellipse cx="33" cy="31" rx="12" ry="16" fill="${skin}"/><path d="M21 29L21 20Q26 11 37 15L46 23 43 28 38 22Q30 26 23 23Z" fill="#32312b"/><path d="M26 31h3m8 0h3" stroke="#4a3f34" stroke-width="1.4" stroke-linecap="round"/><path d="M32 32l-1 6h3m-4 4q3 2 6-1" stroke="#9e7561" fill="none" stroke-width=".8"/>${id===1||id===3?'<g stroke="#464e44" fill="none" stroke-width="1.2"><rect x="22" y="28" width="10" height="7" rx="2"/><rect x="34" y="28" width="10" height="7" rx="2"/><path d="M32 30h2"/></g>':''}<path d="M25 49l8 8-6 5-9-11m22-2l-7 8 6 5 8-10" fill="#ffffff" opacity=".07"/></svg>`;
}
function winnerStinger(ctx,now,level){
 if(level<=0)return;
 const master=ctx.createGain();master.gain.setValueAtTime(.0001,now);master.gain.exponentialRampToValueAtTime(Math.max(.02,level),now+.03);master.gain.setValueAtTime(Math.max(.02,level),now+.9);master.gain.exponentialRampToValueAtTime(.0001,now+1.7);master.connect(ctx.destination);
 const sub=ctx.createOscillator(),sg=ctx.createGain();sub.type='sine';sub.frequency.setValueAtTime(140,now);sub.frequency.exponentialRampToValueAtTime(36,now+.5);
 sg.gain.setValueAtTime(.9,now);sg.gain.exponentialRampToValueAtTime(.001,now+.72);sub.connect(sg);sg.connect(master);sub.start(now);sub.stop(now+.76);
 const length=Math.floor(ctx.sampleRate*.35),buffer=ctx.createBuffer(1,length,ctx.sampleRate),data=buffer.getChannelData(0);
 for(let i=0;i<length;i++){const t=i/length;data[i]=(Math.random()*2-1)*Math.pow(1-t,4);}
 const noise=ctx.createBufferSource(),ng=ctx.createGain();noise.buffer=buffer;ng.gain.value=.5;noise.connect(ng);ng.connect(master);noise.start(now);
 [523.25,659.25,783.99,1046.5].forEach((f,i)=>{
  const o=ctx.createOscillator(),g=ctx.createGain();o.type=i%2?'triangle':'sawtooth';o.frequency.value=f;
  g.gain.setValueAtTime(0,now+.04);g.gain.linearRampToValueAtTime(.08,now+.07);g.gain.exponentialRampToValueAtTime(.001,now+1.45);
  o.connect(g);g.connect(master);o.start(now+.04);o.stop(now+1.5);
 });
}

function showdownStinger(ctx,now,level){
 if(level<=0)return;
 const master=ctx.createGain();master.gain.value=Math.max(.02,level);master.connect(ctx.destination);
 // 三下鼓点
 for(let i=0;i<3;i++){
  const at=now+i*.16,o=ctx.createOscillator(),g=ctx.createGain();
  o.type='sine';o.frequency.setValueAtTime(128-i*20,at);o.frequency.exponentialRampToValueAtTime(44,at+.19);
  g.gain.setValueAtTime(.55,at);g.gain.exponentialRampToValueAtTime(.001,at+.21);
  o.connect(g);g.connect(master);o.start(at);o.stop(at+.23);
 }
 // 上升噪声
 const length=Math.floor(ctx.sampleRate*.7),buffer=ctx.createBuffer(1,length,ctx.sampleRate),data=buffer.getChannelData(0);
 for(let i=0;i<length;i++){const t=i/length;data[i]=(Math.random()*2-1)*Math.pow(t,2)*.5;}
 const riser=ctx.createBufferSource(),filter=ctx.createBiquadFilter(),riserGain=ctx.createGain();
 riser.buffer=buffer;filter.type='bandpass';filter.frequency.setValueAtTime(300,now);filter.frequency.exponentialRampToValueAtTime(3200,now+.62);filter.Q.value=1.2;
 riserGain.gain.setValueAtTime(.4,now);riserGain.gain.exponentialRampToValueAtTime(.001,now+.7);
 riser.connect(filter);filter.connect(riserGain);riserGain.connect(master);riser.start(now);riser.stop(now+.72);
 // 亮和弦
 [392,523.25,659.25,783.99].forEach((f,i)=>{
  const o=ctx.createOscillator(),g=ctx.createGain();
  o.type=i%2?'triangle':'sawtooth';o.frequency.value=f;
  g.gain.setValueAtTime(0,now+.55);g.gain.linearRampToValueAtTime(.09,now+.58);g.gain.exponentialRampToValueAtTime(.001,now+1.3);
  o.connect(g);g.connect(master);o.start(now+.55);o.stop(now+1.35);
 });
}

function card(c,{back=false,empty=false,dealt=false}={}){
 if(empty)return '<div class="card empty" aria-hidden="true">♠</div>';
 if(back)return '<div class="card back" aria-label="未公开的底牌"></div>';
 return `<div class="card ${suit(c)%2?'red':''} ${dealt?'dealt':''}" aria-label="${cardText(c)}"><span class="card-corner">${RANKS[c%13].replace('T','10')}<small>${SUITS[suit(c)]}</small></span><span class="card-center">${SUITS[suit(c)]}</span></div>`;
}
function chips(amount,small=false){if(!amount)return '';const n=Math.min(small?1:3,Math.ceil(amount/100)),count=Math.min(5,Math.ceil(amount/40));return Array.from({length:n},(_,j)=>`<span class="chip-stack">${Array.from({length:count},(_,i)=>`<i class="chip ${j===1?'blue':j===2?'gold':''}" style="--i:${i}"></i>`).join('')}</span>`).join('');}
function fly(id){
 if(mobileLayout.matches||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const scene=$('#tableScene').getBoundingClientRect(),seat=$(`.seat-${id}`)?.getBoundingClientRect();
 if(!seat||!scene.width||!scene.height)return;
 const el=document.createElement('div');el.className='chip-flight';
 el.style.setProperty('--x',(seat.left+seat.width/2-scene.left)/scene.width*100+'%');
 el.style.setProperty('--y',(seat.top+seat.height/2-scene.top)/scene.height*100+'%');
 el.innerHTML=chips(100,true);$('#chipFlights').append(el);setTimeout(()=>el.remove(),650);
}
function actionClass(p,active,win){if(win)return 'action-win';if(active)return 'action-thinking';if(p.folded)return 'action-fold';if(p.lastAction.startsWith('ALL IN'))return 'action-allin';if(/加注|下注/.test(p.lastAction))return 'action-raise';if(p.lastAction.startsWith('跟注'))return 'action-call';return 'action-check';}
function mountSeat(container,id){
 const seat=document.createElement('div');
 seat.className=`seat seat-${id}`;
 seat.style.setProperty('--avatar-color',PERSONAS[id].color);
 seat.innerHTML=`<div class="avatar-wrap">${avatar(id)}</div><div class="seat-cards"></div><div class="seat-name"><span class="winner-badge" hidden>获胜</span><div class="name-row"><i class="style-dot"></i><span class="player-name"></span><span class="seat-tag"></span></div><div class="seat-stack"><span class="stack-value"></span><small class="seat-debt" hidden></small></div></div><span class="position-marker" role="img" hidden></span><div class="seat-status"></div><div class="bet-stack" hidden></div><div class="seat-emote" hidden></div>`;
 container.append(seat);
 return seat;
}
function renderPosition(marker,id){
 const dealer=id===game.button;
 const blind=id===game.sbSeat?'small-blind':id===game.bbSeat?'big-blind':'';
 const label=blind==='small-blind'?'小盲':blind?'大盲':dealer?'D':'';
 const title=dealer?(blind?`${label} · 庄家`:'庄家'):label;
 const className=`position-marker${blind?` blind ${blind}`:dealer?' dealer':''}`;
 if(marker.className!==className)marker.className=className;
 marker.toggleAttribute('hidden',!label);
 if(marker.title!==title){marker.title=title;marker.setAttribute('aria-label',title);}
 setMarkup(marker,label+(blind&&dealer?'<span class="dealer-dot" aria-hidden="true">D</span>':''));
}
function renderSeats(done){
 const container=$('#seats');
 while(container.children.length>game.players.length)container.lastElementChild.remove();
 const revealed=new Map(done?game.result.revealed.map(player=>[player.id,player]):[]);
 for(const player of game.players){
  const {id,name,stack,debt,bet,folded,lastAction}=player;
  const seat=container.children[id]||mountSeat(container,id);
  const hero=id===0,active=game.actor===id,win=done&&game.result.winningSeats.includes(id);
  const publicHand=revealed.get(id);
  const shown=hero?player.hole:publicHand?.hole;
  seat.classList.toggle('folded',folded);
  seat.classList.toggle('turn',active);
  seat.classList.toggle('winner',win);
  seat.classList.toggle('is-revealed',!hero&&!!shown);
  const avatarWrap=seat.querySelector('.avatar-wrap');if(avatarWrap.title!==name)avatarWrap.title=name;
  setText(seat.querySelector('.player-name'),name);
  const seatTag=seat.querySelector('.seat-tag'),human=!!player.isHuman;
  if(seatTag){const label=human?'真人':'AI';if(seatTag.textContent!==label)seatTag.textContent=label;const tagClass=`seat-tag ${human?'human':'ai'}`;if(seatTag.className!==tagClass)seatTag.className=tagClass;}
  setText(seat.querySelector('.stack-value'),fmt(stack));
  const debtLabel=seat.querySelector('.seat-debt');debtLabel.toggleAttribute('hidden',!debt);
  if(debt)setText(debtLabel,`欠款 ${fmt(debt)}`);
  seat.querySelector('.winner-badge').toggleAttribute('hidden',!win);
  const cards=seat.querySelector('.seat-cards'),cardKey=shown?.join(',')||'';
  if(cards.dataset.hole!==cardKey){
   cards.dataset.hole=cardKey;
   cards.innerHTML=[shown?.[0],shown?.[1]].map(value=>card(value,{back:value==null})).join('');
  }
  renderPosition(seat.querySelector('.position-marker'),id);
  const status=seat.querySelector('.seat-status'),statusClass=`seat-status ${actionClass(player,active,win)}`;
  if(status.className!==statusClass)status.className=statusClass;
  const action=lastAction==='小盲'||lastAction==='大盲'?'':lastAction.replace('ALL IN ·','全下');
  setText(status,win?`赢得 ${fmt(game.result.contestAwards[id])}`:active?(hero?'轮到你':'思考中…'):publicHand?.hand||action);
  const wager=seat.querySelector('.bet-stack');wager.toggleAttribute('hidden',!bet||done);
  if(bet&&!done)setMarkup(wager,`${chips(bet,true)}<span>${fmt(bet)}</span>`);
 }
}
function render(){
 const done=game.phase==='complete',legal=game.legal(),scene=$('#tableScene');
 if(Number(scene.dataset.seats)!==game.players.length)scene.dataset.seats=game.players.length;
 setText($('#potValue'),fmt(game.pot));setMarkup($('#potChips'),chips(game.pot));
 const board=$('#board');for(let i=0;i<5;i++){const value=game.board[i]??'empty';if(board.children[i]?.dataset.value!==String(value)){const node=document.createElement('div');node.dataset.value=value;node.innerHTML=card(value,{empty:value==='empty',dealt:value!=='empty'});if(board.children[i])board.children[i].replaceWith(node);else board.append(node);}}
 setText($('#streetStatus'),game.phase==='idle'?'等待开始':`${done?'本手结束':STREET_NAMES[game.street]} · 第 ${String(game.hand).padStart(3,'0')} 手`);
 renderSeats(done);detectAllIn();
 if(done&&game.result?.showdown)detectShowdown();
 else hideShowdown();
 if(customPlayer&&(done||game.phase==='idle'||game.hand!==musicHand)){
  if(done&&game.result?.showdown&&(game.result.revealed?.length||0)>=2){
   if(prefs.sound){try{customPlayer.volume=Math.max(0,Math.min(1,prefs.volume*SHOWDOWN_BED_VOLUME));if(customPlayer.paused)customPlayer.play().catch(()=>{});}catch{}}
   clearTimeout(customStopTimer);
  }
  else stopCustomAllIn();
 }
 if(game.actor!==previousActor||game.hand!==previousHand||game.street!==previousStreet){
  if(game.actor===0&&legal){raiseTo=legal.min;sound('turn');reviewViews.push(game.publicView(0));if(!online)armLocalTurnTimer();}
  else{clearLocalTurnTimer();if(!online)turnDeadline=0;}
  previousActor=game.actor;previousHand=game.hand;previousStreet=game.street;
 }
 scene.classList.toggle('hand-complete',done);
 scene.classList.toggle('showdown',done&&game.result.showdown);
 const message=$('#tableMessage');message.classList.toggle('is-result',done);
 if(done){
  const winners=game.result.winningSeats,multiple=winners.length>1;
  const title=multiple?'多人获胜':(winners[0]===0?'你赢了':game.players[winners[0]].name+' 获胜');
  const detail=multiple?winners.map(id=>game.players[id].name+' '+fmt(game.result.contestAwards[id])).join(' · '):'赢得 '+fmt(game.result.contestAwards[winners[0]])+' 筹码';
  setMarkup(message,`<svg class="winner-trophy" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v5a5 5 0 0 1-10 0V3ZM7 5H3v2a4 4 0 0 0 5 4m9-6h4v2a4 4 0 0 1-5 4M12 13v5m-4 3h8m-6-3h4v3h-4Z"/></svg><div><strong>${title}</strong><span>${detail}</span></div>`);
 }else setMarkup(message,'');
 const hero=game.players[0],repayAmount=game.repayable(0),repayButton=$('#repayButton');
 setText($('#walletChips'),fmt(hero.stack));setText($('#walletDebt'),fmt(hero.debt||0));
 setText($('#pendingLoan'),hero.pendingLoan?`下手到账 ${fmt(hero.pendingLoan)}`:'');
 repayButton.toggleAttribute('disabled',!repayAmount);
 const repayLabel=repayAmount?`还款 ${fmt(repayAmount)}`:'暂无可还欠款';
 if(repayButton.title!==repayLabel){repayButton.title=repayLabel;repayButton.setAttribute('aria-label',repayLabel);}
 const borrowable=game.borrowable?.(0)??0,canBorrow=game.canBorrow?.(0)??false,borrowButton=$('#borrowButton');
 const borrowingAllowed=canBorrow;
 const pendingLoan=!!hero.pendingLoan;
 const borrowLabel=borrowingAllowed?`借入 ${fmt(Math.min(LOAN_AMOUNT,borrowable))}`:pendingLoan?'借款到账中':hero.stack>=BORROW_THRESHOLD?'筹码 ≥ 1,000':'已达借款上限';
 borrowButton.toggleAttribute('disabled',!borrowingAllowed);
 if(borrowButton.textContent!==borrowLabel)borrowButton.textContent=borrowLabel;
 const borrowTitle=borrowingAllowed?`借款上限 ${fmt(MAX_DEBT)} · 当前还可借 ${fmt(borrowable)}`:pendingLoan?`已借入 ${fmt(hero.pendingLoan)}，下手到账后才能再借`:hero.stack>=BORROW_THRESHOLD?`筹码低于 ${fmt(BORROW_THRESHOLD)} 时才能借款`:`借款已达上限 ${fmt(MAX_DEBT)}，可在「账本」查看`;
 if(borrowButton.title!==borrowTitle){borrowButton.title=borrowTitle;borrowButton.setAttribute('aria-label',borrowTitle);}
 setText($('#modeLabel'),online?roomTitle(online):`${game.players.length} 人桌 · ${levelLabels[game.aiLevel]||'标准'}`);
 const bankroll=$('.bankroll-bar');if(bankroll)bankroll.toggleAttribute('hidden',!!online?.spectator);
 const emoteButton=$('#emoteButton');if(emoteButton){const hideEmote=!!online?.spectator||!!online?.away;emoteButton.hidden=hideEmote;if(hideEmote){const panel=$('#emotePanel');if(panel)panel.hidden=true;}}
 const tableHeading=$('.page-heading h1');if(tableHeading)setText(tableHeading,`${game.players.length} 人德州`);
 $('#speedToggle').toggleAttribute('hidden',!!online);
 $('#advisorToggle').toggleAttribute('hidden',!!online);
 for(const id of ['#multiplayerButton','#multiplayerTopButton'])$(id)?.toggleAttribute('hidden',!online);
 renderActions();renderSide();updateAdvisor();
}
function renderActions(){
 const dock=$('#actionDock');
 if(online?.spectator){
  const status=game.phase==='idle'?'等待开局':game.phase==='dealing'?'发牌中…':game.phase==='complete'?'本手结束':`等待 ${game.players[game.actor]?.name||'牌桌'} 行动`;
  dock.innerHTML=`<div class="waiting-bar spectator-bar"><span class="waiting-symbol" aria-hidden="true">◉</span><div><strong>观战中</strong><p>${status}</p></div></div>`;
  return;
 }
 if(online?.away){
  dock.innerHTML=`<div class="waiting-bar spectator-bar"><span class="waiting-symbol" aria-hidden="true">⏸</span><div><strong>座位暂由 AI 代打</strong><p>${online.awayReason==='timeout'?'30 秒未操作':online.awayReason==='manual'?'你暂时离开了房间':'连接中断'} · 随时可以回来接管</p></div><button class="action-button primary" id="reclaimSeat">重新接管</button></div>`;
  $('#reclaimSeat').onclick=()=>roomOp('reclaim');
  return;
 }
 const l=game.legal(0),hero=game.players[0];
 let state;
 if(l)state=[game.sessionId,game.hand,game.events.length,game.pot,game.currentBet,l];
 else if(game.phase==='idle')state=[online?.code,online?.host,online?.humans,game.players.length,game.aiLevel];
 else if(game.phase==='complete')state=[game.sessionId,game.hand,game.result.heroDelta,!hero.stack,hero.pendingLoan,hero.debt,online?.host];
 else state=[hero.folded,!hero.stack,game.actor,game.players[game.actor]?.name,!!online];
 const key=JSON.stringify([game.phase,state]);
 if(key===actionRenderKey)return;
 actionRenderKey=key;
 selectRaiseAmount=null;
 if(game.phase==='idle'){
  dock.innerHTML=`<div class="waiting-bar"><div><strong>${online?'房间 '+online.code:'准备开局'}</strong><p>${online?roomLine():`${game.players.length-1} 位 AI · ${levelLabels[game.aiLevel]}`}</p></div><button class="action-button primary" id="roomStart" ${online&&!online.host?'disabled':''}>${online&&!online.host?'等待房主':'开始游戏'}</button></div>`;
  $('#roomStart').onclick=startHand;return;
 }
 if(game.phase==='complete'){
  const delta=game.result.heroDelta,busted=hero.stack===0,pending=hero.pendingLoan>0;
  const needsBorrow=busted&&!pending,borrowable=game.borrowable(0),canBorrowNow=game.canBorrow(0),atCap=needsBorrow&&!canBorrowNow;
  const nextLabel=needsBorrow?(atCap?'借款已达上限':`借入 ${fmt(Math.min(LOAN_AMOUNT,borrowable))}`):online&&!online.host?'等待房主':'下一手';
  const title=busted?(pending?`下手到账 ${fmt(hero.pendingLoan)}`:'筹码已用完'):delta>0?'本手盈利':delta===0?'本手持平':'本手亏损';
  dock.innerHTML=`<div class="waiting-bar"><span class="waiting-symbol">${delta>0?'✦':'♠'}</span><div><strong>${title}</strong><p>净输赢 <span class="${delta>=0?'positive':'negative'}">${delta>0?'+':''}${fmt(delta)}</span> · 欠款 ${fmt(hero.debt||0)} / ${fmt(MAX_DEBT)}</p></div><button class="action-button primary" id="nextHand">${nextLabel} <span>→</span></button></div><div class="result-details"><button class="text-button" id="reviewButton">本手复盘</button></div>`;
  $('#nextHand').disabled=atCap||(!!online&&!online.host&&!needsBorrow);
  $('#nextHand').onclick=needsBorrow?()=>borrowChips():startHand;
  $('#reviewButton').onclick=()=>openReview(game.history[0]);return;
 }
 if(!l){dock.innerHTML=`<div class="waiting-bar"><div><strong>${game.phase==='dealing'?'发牌中…':game.players[0].folded?'你已弃牌':game.players[0].stack===0?'你已全下':`等待 ${game.players[game.actor]?.name||'牌桌'} 行动`}</strong></div><div class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></div></div>${!online&&game.players[0].folded?'<div class="result-details"><button class="text-button" id="fastFinish">加速本手</button></div>':''}`;if($('#fastFinish'))$('#fastFinish').onclick=()=>{fastHand=game.hand;toast('本手已加速');};return;}
 const minRaise=l.min,maxRaise=l.max,canRaise=l.canRaise;
 raiseTo=raiseTo===maxRaise?maxRaise:Math.max(minRaise,Math.min(maxRaise,snapBet(raiseTo)));const odds=l.call?Math.round(l.call/(game.pot+l.call)*100):0;
 const maxLabel='全下',raiseLabel=game.currentBet===0?'下注':'加注至';
 dock.innerHTML=`<div class="action-topline"><div class="action-indicator"><i class="live-dot"></i>轮到你 <span class="action-timer" id="turnTimer" hidden></span></div>${l.call?`<span class="action-helper">底池赔率 ${odds}%</span>`:''}</div><div class="action-controls"><button class="action-button fold" data-action="fold">弃牌 <small>F</small></button><button class="action-button" data-action="${l.canCheck?'check':'call'}">${l.canCheck?'过牌':'跟注 '+fmt(l.call)} <small>C</small></button><button class="action-button primary" data-action="raise" ${!canRaise?'disabled':''}><span id="raiseTitle">${canRaise&&raiseTo===maxRaise?maxLabel:raiseLabel}</span> <span id="raiseLabel">${fmt(raiseTo)}</span> <small>R</small></button></div>${canRaise?`<div class="raise-tools"><label for="raiseInput">金额</label><input id="raiseRange" type="range" min="${minRaise}" max="${maxRaise}" step="${BET_UNIT}" value="${raiseTo}" aria-label="加注总额"><input class="raise-input" id="raiseInput" type="number" inputmode="numeric" min="${minRaise}" max="${maxRaise}" step="${BET_UNIT}" value="${raiseTo}" aria-label="输入加注总额"><div class="size-buttons"><button data-size="min">最小</button><button data-size=".5">半池</button><button data-size="1">底池</button><button data-size="all">${maxLabel}</button></div></div>`:''}`;
 dock.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>humanAction(b.dataset.action));
 const setAmount=(x,announce=false,allIn=false)=>{
  const raw=Number(x),exact=allIn||raw===maxRaise;
  const snapped=exact?maxRaise:Math.max(minRaise,Math.min(maxRaise,snapBet(Number.isFinite(raw)&&raw>0?raw:minRaise)));
  if(announce&&Number.isFinite(raw)&&raw>0&&raw!==snapped&&!exact)toast(`金额已调整为 ${fmt(snapped)}`);
  raiseTo=snapped;$('#raiseRange').value=raiseTo;$('#raiseInput').value=raiseTo;$('#raiseLabel').textContent=fmt(raiseTo);
  $('#raiseTitle').textContent=raiseTo===maxRaise?maxLabel:raiseLabel;
  updateAdvisor(220);
 };
 if(canRaise){selectRaiseAmount=setAmount;$('#raiseRange').oninput=e=>setAmount(e.target.value);$('#raiseInput').onchange=e=>setAmount(e.target.value,true);dock.querySelectorAll('[data-size]').forEach(b=>b.onclick=()=>setAmount(b.dataset.size==='all'?maxRaise:b.dataset.size==='min'?minRaise:game.currentBet+(game.pot+l.call)*Number(b.dataset.size),false,b.dataset.size==='all'));}
}
function setAssist(enabled,expand=enabled){
 if(online)return;
 prefs.assist=enabled;$('#startAssist').checked=enabled;savePrefs();
 $('#advisorPanel').open=expand;
 updateAdvisor();
}
function stopAdvisor(){
 clearTimeout(advisorTimer);
 advisorKey='';
 const worker=workers.get('advisor');
 if(worker&&[...pending.values()].some(p=>p.worker===worker))stopWorker('advisor');
}
const percent=p=>`${Math.round(p*100)}%`;
function advisorLabel(action,view){
 if(action.type==='fold')return '弃牌';
 if(action.type==='check')return '过牌';
 if(action.type==='call')return `跟注 ${fmt(view.legal.call)}`;
 const label=action.to===view.legal.max?'全下':view.legal.currentBet?'加注至':'下注';
 return `${label} ${fmt(action.to)}`;
}
function renderAdvice(data,view){
 const label=action=>advisorLabel(action,view);
 setText($('#advisorSummary'),`AI 辅助 · 建议${label(data.recommended)}`);
 const odds=view.legal.call?`<span>底池赔率 <strong>${percent(view.legal.call/(view.pot+view.legal.call))}</strong></span>`:'';
 const rows=data.actions.map(action=>{
  const recommended=action.type===data.recommended.type&&(action.type!=='raise'||action.to===data.recommended.to);
  const ev=Math.round(action.ev);
  const title=action.type==='raise'?`<button class="advisor-size" type="button" data-raise-to="${action.to}" aria-label="选用 ${label(action)}">${label(action)}</button>`:label(action);
  return `<tr ${recommended?'class="recommended"':''}><th scope="row">${title}${recommended?'<span class="advisor-pick">建议</span>':''}</th><td>${percent(action.winProbability)}</td><td>${action.type==='raise'?percent(action.foldProbability):'—'}</td><td class="${ev>0?'positive':ev<0?'negative':''}">${ev>0?'+':''}${fmt(ev)}</td></tr>`;
 }).join('');
 const content=$('#advisorContent');
 setMarkup(content,`<div class="advisor-meta"><span>摊牌权益 <strong>${percent(data.equity)}</strong></span>${odds}</div><div class="advisor-scroll"><table class="advisor-choices"><thead><tr><th scope="col">行动</th><th scope="col">获池</th><th scope="col">对手全弃</th><th scope="col">期望筹码</th></tr></thead><tbody>${rows}</tbody></table></div><p class="advisor-note">${data.note?`<span class="advisor-style">${data.note}</span>`:''}按本轮应对后直接摊牌估算。获池含分池和对手全弃。</p>`);
 content.querySelectorAll('[data-raise-to]').forEach(button=>button.onclick=()=>selectRaiseAmount?.(Number(button.dataset.raiseTo)));
}
function updateAdvisor(debounce=0){
 const panel=$('#advisorPanel'),summary=$('#advisorSummary'),content=$('#advisorContent');
 const enabled=atTable&&prefs.assist&&!online;
 const toggle=$('#advisorToggle'),pressed=String(!!prefs.assist&&!online);
 if(toggle.getAttribute('aria-pressed')!==pressed)toggle.setAttribute('aria-pressed',pressed);
 if(!enabled)panel.open=false;
 panel.toggleAttribute('hidden',!enabled);
 const legal=enabled?game.legal(0):null;
 if(!legal){
  stopAdvisor();advisorContext='';
  setText(summary,'AI 辅助');
  setMarkup(content,'<p class="advisor-status">轮到你时显示建议。</p>');
  content.removeAttribute('aria-busy');
  return;
 }
 const to=legal.canRaise?raiseTo:undefined;
 const context=[generation,game.sessionId,game.hand,game.events.length,game.pot,...game.players.map(p=>p.stack)].join(':');
 const key=`${context}:${to}`;
 if(key===advisorKey)return;
 const updating=context===advisorContext&&!!content.querySelector('.advisor-choices');
 stopAdvisor();advisorKey=key;advisorContext=context;
 setText(summary,updating?'AI 辅助 · 更新中':'AI 辅助 · 分析中');
 if(!updating)setMarkup(content,'<p class="advisor-status">正在分析牌局…</p>');
 content.setAttribute('aria-busy','true');
 const view=game.publicView(0);
 advisorTimer=setTimeout(async()=>{
  try{
   const data=await compute(view,'advisor',to);
   if(key===advisorKey)renderAdvice(data,view);
  }catch{
   if(key!==advisorKey)return;
   setText(summary,'AI 辅助 · 分析失败');
   setMarkup(content,'<button type="button" class="advisor-size" id="retryAdvisor">重新分析</button>');
   $('#retryAdvisor').onclick=()=>{advisorKey='';updateAdvisor();};
  }finally{if(key===advisorKey)content.removeAttribute('aria-busy');}
 },debounce);
}
function describe(e){if(e.kind==='blind')return e.label||'投入盲注';if(e.type==='fold')return '弃牌';if(e.type==='check'||e.type==='call'&&!e.amount)return '过牌';if(e.allin)return '全下';return e.type==='raise'?'加注至 '+fmt(e.to):'跟注';}
function renderSide(){
 if(!atTable||hiddenSidebar.matches)return;
 const side=$('#sideContent'),live=sideTab==='live';
 const markup=live?`<div class="hand-label"><b>第 ${game.hand} 手</b><span>${game.street?STREET_NAMES[game.street]:'准备开始'}</span></div>${game.events.length?`<ol class="activity-list">${game.events.slice(-18).map(e=>e.kind==='street'?`<li class="activity-street">${STREET_NAMES[e.street]} · ${e.board.map(cardText).join(' ')}</li>`:`<li class="activity-item"><span class="activity-avatar">${avatar(e.seat)}</span><div class="activity-text"><strong>${game.players[e.seat].name}</strong><p>${describe(e)}</p></div>${e.amount?`<span class="activity-amount">${fmt(e.amount)}</span>`:''}</li>`).join('')}${game.phase==='complete'?`<li class="activity-street">本手结束 · 底池 ${fmt(game.pot)}</li>`:''}</ol>`:'<div class="empty-activity">开局后，这里显示每个人的操作。</div>'}`:sessionHTML();
 if(markupCache.get(side)===markup)return;
 const follow=live&&side.scrollHeight-side.clientHeight-side.scrollTop<24;
 setMarkup(side,markup);
 if(follow)side.scrollTop=side.scrollHeight;
}
function sessionHTML(){const s=game.players[0].stats,net=game.net,vpip=s.hands?Math.round(s.vpip/s.hands*100):0;return `<div class="stat-grid"><div><small>完成手数</small><strong>${game.completedHands}</strong></div><div><small>累计净变化</small><strong class="${net>=0?'positive':'negative'}">${net>0?'+':''}${fmt(net)}</strong></div><div><small>主动入池 VPIP</small><strong>${vpip}<small style="display:inline">%</small></strong></div><div><small>翻前加注 PFR</small><strong>${s.hands?Math.round(s.pfr/s.hands*100):0}<small style="display:inline">%</small></strong></div></div><button class="small-link" id="panelHistory">手牌记录</button>`;}
let fastHand=-1;
let turnDeadline=0,localTurnTimer=null;
let allInHand=-1,allInSeen=0,suppressAllInFx=false,allInTimer;
let customAllIn=null,customPlayer=null,audioDbPromise,customStartedAt=0,customStopTimer,musicHand=-1,allInTrackPrimed=false;
async function startHand(){
 if(online)return roomOp('start');
 initAudio();if(!['idle','complete'].includes(game.phase))return;generation++;busy=false;reviewViews=[];clearLocalTurnTimer();turnDeadline=0;
 if(game.players[0].stack===0&&!game.players[0].pendingLoan&&game.borrowable(0)>0){const amount=Math.min(LOAN_AMOUNT,game.borrowable(0));game.borrow(0);toast(`已借入 ${fmt(amount)} 筹码`);}
 const busted=game.players.filter(p=>p.stack===0&&p.id!==0&&game.borrowable(p.id)>0);if(busted.length){game.refillBusted();toast(busted.map(p=>p.name).join('、')+` 已借入 ${fmt(LOAN_AMOUNT)} 筹码`);}
 try{game.startHand();}catch(error){toast(error.message);return;}
 sound('deal');render();pump();
}
async function pump(){
 if(online||busy)return;busy=true;const token=generation;
 try{
 while(token===generation&&atTable){
  if(game.phase==='complete'){sound(game.result.heroDelta>0?'win':'deal');render();if(prefs.autoNext&&game.players[0].stack>0){
   if(game.result?.showdown)await waitShowdownDone();else await delay(3500);
   if(token===generation&&atTable&&prefs.autoNext&&!$('#modal').open){busy=false;startHand();return;}
  }break;}
  if(game.phase==='dealing'){await delay(fastHand===game.hand?180:750/prefs.speed);if(token!==generation||!atTable)return;game.advanceStreet();sound('deal');render();continue;}
  if(game.actor===0||game.phase==='idle')break;
  const actor=game.actor,view=game.publicView(actor),personality=view.personality;
  const pace=Math.min(1,DEFAULT_SEATS/game.players.length)*(game.aiLevel==='hard'?.65:1);
  const thinkTime=pace*(650+(personality.patience||.5)*800+Math.random()*650)/prefs.speed;
  const [choice]=await Promise.all([compute(view),delay(fastHand===game.hand?80:thinkTime)]);
  if(token!==generation||!atTable)return;
  const action=game.act(actor,choice.type,choice.to);if(action.amount){fly(actor);if(!action.allin)sound('chips');}else sound('tap');render();
 }
 }catch(err){console.error(err);if(token===generation){toast('AI 计算失败');const retry=document.createElement('button');retry.className='text-button';retry.textContent='重试 AI 行动';retry.onclick=()=>pump();$('#actionDock').append(retry);}}
 finally{if(token===generation)busy=false;}
}
function legalRaise(){
 const l=game.legal(0);if(!l?.canRaise||l.max<=l.currentBet)return null;
 if(raiseTo===l.max)return l.max;
 return Math.max(l.min,Math.min(l.max,snapBet(raiseTo)));
}
function clearLocalTurnTimer(){if(localTurnTimer){clearTimeout(localTurnTimer);localTurnTimer=null;}}
function armLocalTurnTimer(){
 clearLocalTurnTimer();
 const limit=currentTurnMs();
 turnDeadline=Date.now()+limit;
 const hand=game.hand,actor=game.actor;
 localTurnTimer=setTimeout(()=>{
  localTurnTimer=null;
  if(!atTable||online||game.phase!=='playing'||game.actor!==actor||game.hand!==hand)return;
  const l=game.legal(0);if(!l)return;
  toast(l.canCheck?'思考超时，自动过牌':'思考超时，自动弃牌');
  humanAction(l.canCheck?'check':'fold');
 },limit);
}
function humanAction(type){
 if(type==='raise'){
  const to=legalRaise();
  if(to===null)return;
  raiseTo=to;
 }
 if(online){initAudio();return roomOp('action',{type,to:type==='raise'?raiseTo:0,turnKey:online.turnKey});}
 if(game.actor!==0||game.phase!=='playing')return;clearLocalTurnTimer();turnDeadline=0;initAudio();try{const e=game.act(0,type,raiseTo);if(e.amount){fly(0);if(!e.allin)sound('chips');}else sound('tap');render();pump();}catch(e){toast(e.message);}
}
function openModal(title,html){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=html;if(!$('#modal').open)$('#modal').showModal();}
function closeModal(){$('#modal').close();}
function openProfiles(){
 openModal('对手',`<div class="profiles-list">${game.players.slice(1).map((p,i)=>{
  const id=i+1,stats=game.players[id].stats,style=game.completedHands>=5&&!p.isHuman?game.personalities[id]:null;
  const vpip=stats.hands?Math.round(stats.vpip/stats.hands*100):0,pfr=stats.hands?Math.round(stats.pfr/stats.hands*100):0;
  const tags=style?[style.loose>.36?'入池较多':'起手谨慎',style.aggression>.67?'积极进攻':'控制底池',style.trap>.3?'喜欢慢打':style.bluff>.26?'诈唬较多':'谨慎诈唬']:[];
  return `<article class="profile-card"><div class="profile-avatar">${avatar(id)}</div><div class="profile-content"><div class="profile-heading"><h3>${p.name}</h3><span class="profile-tag">${p.isHuman?'同学':style?style.style.split(' · ')[1]:'风格待观察'}</span></div>${style?`<div class="profile-traits">${tags.map(t=>`<span>${t}</span>`).join('')}</div>`:`<p class="profile-pending">${p.isHuman?'真人玩家':'再完成 '+Math.max(0,5-game.completedHands)+' 手即可查看风格'}</p>`}<dl class="profile-stats"><div><dt>已参与</dt><dd>${stats.hands} 手</dd></div><div><dt title="翻牌前主动投入筹码的比例">入池率</dt><dd>${vpip}%</dd></div><div><dt title="翻牌前加注的比例">翻前加注</dt><dd>${pfr}%</dd></div></dl></div></article>`;
 }).join('')}</div>`);
}
function openRules(){
 openModal('游戏规则',`<div class="rule-row"><span>牌桌</span><strong>${MIN_SEATS}–${MAX_SEATS} 人无限注德州扑克</strong></div><div class="rule-row"><span>盲注</span><strong>10 / 20</strong></div><div class="rule-row"><span>初始筹码</span><strong>2,000</strong></div><h3>发牌顺序</h3><p>每人两张底牌。翻牌发 3 张公共牌，转牌和河牌各发 1 张。</p><h3>下注</h3><p>输入本轮投入总额，按 10 筹码递增。全下使用全部剩余筹码。多人全下按边池结算，平局分池。</p><h3>强制还款</h3><p>筹码高于 ${fmt(FORCE_REPAY_AT)} 时，超出 ${fmt(FORCE_REPAY_AT)} 的部分会自动用于偿还欠款，真人玩家和 AI 都适用。</p><h3>借筹码</h3><p>只有筹码低于 ${fmt(BORROW_THRESHOLD)} 时才能借入 ${fmt(LOAN_AMOUNT)}；累计欠款最多 ${fmt(MAX_DEBT)}（${Math.floor(MAX_DEBT/LOAN_AMOUNT)} 次），还清欠款后可以再借。牌局中借入的筹码下手到账；即使到账前输光，下一手开始时会自动补回。</p><h3>思考时间</h3><p>每位玩家每回合 ${turnLabel(currentTurnMs())}（创建房间时可在 15 秒–5 分钟之间选择）；超时自动过牌/弃牌，联机时该座位转由 AI 代打。掉线 30 秒同样由 AI 代打，但会保留登录凭证：回来自动恢复，超时可在行动栏点「重新接管」。</p><h3>入座与观战</h3><p>加入时可自选接替某个 AI 座位（重新买入 2,000），或新开一个房间；每个座位标注“真人”或“AI”。房间面板可「暂时离开」：座位交给 AI 但保留重连凭证，首页会出现“回到房间”，刷新或重新打开页面也会自动恢复；「彻底退出」才会释放座位。观战加入不占座、看不到任何底牌、不能操作牌局。摊牌时会出现双方牌型对比动画，展示约 10 秒，点击任意处可跳过。</p><h3>表情</h3><p>牌桌有 15 个表情（含「😫 闹麻了」「🤡 小丑」「🍬 糖完了」「📱 扫码了」），10–20 筹码一次，8 秒冷却；筹码从自己的座位扣除，所有玩家都能看到气泡。观战或暂时离开时不能发表情。</p><h3>AI 辅助</h3><p>AI 辅助只在单人练习中可用；联机房间为公平起见不提供。</p><h3>牌型</h3><p>同花顺 › 四条 › 葫芦 › 同花 › 顺子 › 三条 › 两对 › 一对 › 高牌。取最强的五张牌。</p><p>快捷键 F 弃牌，C 过牌或跟注，R 下注或加注。</p>`);
}
let leaderboardCache=null;
const lbEscape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function lbDate(at){try{return new Date(at).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}catch{return '';}}
function lbRows(kind){
 const list=kind==='win'?leaderboardCache.wins:leaderboardCache.hands;
 if(!list.length)return '<p class="lb-empty">近期还没有线上完整牌局上榜。</p>';
 return `<div class="lb-list">${list.map((entry,index)=>`<button type="button" class="lb-row" data-lb-kind="${kind}" data-lb-index="${index}"><span class="lb-rank">${String(index+1).padStart(2,'0')}</span><strong>${kind==='win'?'+'+fmt(entry.amount):lbEscape(entry.hand)}</strong><span class="lb-open">详情 ›</span></button>`).join('')}</div>`;
}
function bindLbRows(){document.querySelectorAll('[data-lb-kind]').forEach(button=>button.onclick=()=>openLbDetail(button.dataset.lbKind,Number(button.dataset.lbIndex)));}
function openLeaderboard(tab='win'){
 openModal('排行榜',`<div class="lb-tabs"><button type="button" data-lb-tab="win" ${tab==='win'?'class="selected"':''}>最大赢池</button><button type="button" data-lb-tab="hand" ${tab==='hand'?'class="selected"':''}>最强牌型</button></div><div id="lbList" aria-live="polite">加载中…</div><p class="lb-note">线上房间近 30 天 · 仅统计真人玩家 · 点开可看牌面和详情</p>`);
 const list=$('#lbList');
 const render=()=>{list.innerHTML=lbRows(tab);bindLbRows();};
 document.querySelectorAll('[data-lb-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.lbTab;document.querySelectorAll('[data-lb-tab]').forEach(item=>item.classList.toggle('selected',item===button));render();});
 if(leaderboardCache){render();return;}
 fetch('/api/leaderboard',{signal:AbortSignal.timeout?.(12000)}).then(response=>{if(!response.ok)throw Error('联机服务暂时不可用');return response.json();}).then(data=>{leaderboardCache={wins:data.wins||[],hands:data.hands||[]};render();}).catch(error=>{list.innerHTML=`<p class="lb-empty">${lbEscape(error.message||'排行榜暂时不可用')}</p>`;});
}
function openLbDetail(kind,index){
 const entry=(kind==='win'?leaderboardCache?.wins:leaderboardCache?.hands)?.[index];if(!entry)return;
 const detail=entry.detail||{},hole=detail.hole||entry.hole||[],board=detail.board||entry.board||[],players=detail.players||[],winners=detail.winners||[];
 const cards=values=>values.length?values.map(value=>card(value)).join(''):'<span class="lb-none">未摊牌</span>';
 openModal(kind==='win'?'最大赢池详情':'最强牌型详情',`<div class="lb-detail"><div class="lb-detail-head"><div><small>${kind==='win'?'赢池':'牌型'}</small><strong>${kind==='win'?'+'+fmt(entry.amount):lbEscape(entry.hand)}</strong></div><div><small>${kind==='win'?'获胜者':'牌型持有者'}</small><strong>${lbEscape(entry.winner)}</strong></div></div><div class="lb-cards"><div><small>底牌</small><div class="lb-card-row">${cards(hole)}</div></div><div><small>公共牌</small><div class="lb-card-row">${cards(board)}</div></div></div><div class="lb-facts"><span>底池 <strong>${fmt(detail.pot??entry.amount)}</strong></span><span>牌型 <strong>${lbEscape(detail.hand||entry.hand||'未摊牌')}</strong></span><span>时间 <strong>${lbDate(entry.at)}</strong></span></div>${players.length?`<h3>本手玩家</h3><div class="lb-players">${players.map(player=>`<div><span>${player.seat} 号 · ${lbEscape(player.name)}${player.folded?' · 已弃牌':''}</span><span class="lb-player-cards">${player.hole?.length?player.hole.map(value=>card(value)).join(''):'<em>未摊牌</em>'}</span></div>`).join('')}</div>`:''}${winners.length?`<p class="lb-winner-line">赢池分配：${winners.map(winner=>`${lbEscape(winner.name)} +${fmt(winner.amount)}`).join(' · ')}</p>`:''}<button type="button" class="text-button" id="lbBack">← 返回排行榜</button></div>`);
 $('#lbBack').onclick=()=>openLeaderboard(kind==='win'?'win':'hand');
}
function openSettings(){
 openModal('设置',`<div class="setting-row"><label for="settingSound">音效</label><input type="checkbox" id="settingSound" ${prefs.sound?'checked':''}></div><div class="setting-row"><label for="settingVolume">音量</label><input type="range" id="settingVolume" min="0" max="1" step=".05" value="${prefs.volume}"></div><div class="setting-row"><label for="allInMusicSelect">全下音乐</label><select id="allInMusicSelect"><option value="default" ${prefs.allInMusic==='default'?'selected':''}>原版全下曲</option><option value="kpl" ${prefs.allInMusic==='kpl'?'selected':''}>我的音乐 · 巅峰对决片段</option><option value="custom" ${prefs.allInMusic==='custom'?'selected':''}>自定义文件</option></select></div><div class="setting-row"><span>当前全下音乐<small>仅本机生效</small></span><strong id="allInTrackName">${prefs.allInMusic==='custom'?(customAllIn?.name||'未选择文件'):ALL_IN_TRACKS[prefs.allInMusic==='default'?'default':'kpl'].label}</strong></div><div class="setting-row"><label for="allInAudioInput">自定义音频<small>不会上传，也不随游戏分发</small></label><span class="audio-actions"><button type="button" id="pickAllInAudio" class="text-button">选择文件</button><button type="button" id="clearAllInAudio" class="text-button">清除自定义</button></span></div><input type="file" id="allInAudioInput" accept="audio/*" hidden><div class="setting-row"><span>AI 强度</span><strong>${levelLabels[game.aiLevel]}</strong></div>${online?'':`<div class="setting-row"><label for="settingAssist">AI 辅助</label><input type="checkbox" id="settingAssist" ${prefs.assist?'checked':''}></div>`}${online?'':`<div class="setting-row"><label for="settingSpeed">AI 节奏</label><select id="settingSpeed"><option value="1" ${prefs.speed===1?'selected':''}>标准</option><option value="2.5" ${prefs.speed!==1?'selected':''}>快速</option></select></div><div class="setting-row"><label for="settingAuto">自动下一手</label><input type="checkbox" id="settingAuto" ${prefs.autoNext?'checked':''}></div>`}${online&&!online.host?'':'<button class="action-button modal-action" id="resetTable">重置牌桌</button>'}`);
 $('#settingSound').onchange=e=>{prefs.sound=e.target.checked;initAudio();savePrefs();};
 $('#settingVolume').oninput=e=>{prefs.volume=Number(e.target.value);savePrefs();updateBgmVolume();};
 const audioInput=$('#allInAudioInput');
 const musicSelect=$('#allInMusicSelect');
 musicSelect.onchange=()=>{
  const mode=musicSelect.value;
  if(mode==='custom'&&!customAllIn){audioInput.click();return;}
  prefs.allInMusic=mode;savePrefs();applyAllInTrackSource();updateAllInTrackLabel();
 };
 applyAllInTrackSource();updateAllInTrackLabel();
 $('#pickAllInAudio').onclick=()=>audioInput.click();
 audioInput.onchange=async()=>{
  const file=audioInput.files?.[0];if(!file)return;
  try{await writeCustomAllIn(file);prefs.allInMusic='custom';savePrefs();if(musicSelect)musicSelect.value='custom';setText($('#allInTrackName'),file.name);toast(`全下音乐已设为 ${file.name}`);}
  catch{toast('这个音频无法保存，换一个文件试试');}
  audioInput.value='';
 };
 $('#clearAllInAudio').onclick=async()=>{await clearCustomAllIn();prefs.allInMusic='kpl';savePrefs();if(musicSelect)musicSelect.value='kpl';applyAllInTrackSource();updateAllInTrackLabel();toast('已切换回我的音乐');};
 const settingAssist=$('#settingAssist');if(settingAssist)settingAssist.onchange=e=>setAssist(e.target.checked);
 if(!online){
  $('#settingSpeed').onchange=e=>{prefs.speed=Number(e.target.value);savePrefs();updateSpeed();};
  $('#settingAuto').onchange=e=>{prefs.autoNext=e.target.checked;savePrefs();};
 }
 if($('#resetTable'))$('#resetTable').onclick=()=>{
  openModal('重置牌桌？','<p>筹码恢复至 2,000，清空欠款和本场记录。</p><button id="confirmReset" class="action-button primary modal-action">确认重置</button><button id="cancelReset" class="action-button modal-action">取消</button>');
  $('#confirmReset').onclick=async()=>{
   if(online){if(await roomOp('reset'))closeModal();return;}
   newLocalTable({seatCount:game.players.length,aiLevel:game.aiLevel,excludeNames:game.players.map(p=>p.name)});
   render();closeModal();
  };
  $('#cancelReset').onclick=closeModal;
 };
}
function eventLine(e,names=game.players.map(p=>p.name)){if(e.kind==='emote')return `${names[e.seat]} · ${e.emoji} ${e.text}`;return e.kind==='street'?`<b>${STREET_NAMES[e.street]} · ${e.board.map(cardText).join(' ')}</b>`:`${names[e.seat]} · ${e.kind==='blind'?'盲注':describe(e)}${e.amount?'（投入 '+fmt(e.amount)+'）':''}`;}
function historyHTML(h){return `<div class="history-board"><label>你</label>${h.heroCards.map(c=>card(c)).join('')}<label>公共牌</label>${h.board.map(c=>card(c)).join('')}</div><div class="history-events">${h.events.map(e=>eventLine(e,h.names)).join('<br>')}</div><div class="history-note">${h.result.revealed.length?h.result.revealed.map(r=>`${(h.names?.[r.id]||game.players[r.id].name)}：${r.hole.map(cardText).join(' ')} · ${r.hand}`).join('<br>'):'未发生摊牌，其他玩家的底牌不公开。'}<br>底池 ${fmt(h.result.total)} · ${h.result.pots.filter(p=>!p.refund).length} 个有效底池${h.result.pots.some(p=>p.refund)?' · 未跟注金额已退还':''}</div>`;}
function openHistory(){openModal('手牌记录',game.history.length?`<p class="session-note">最近 ${game.history.length} 手</p>`+game.history.map(h=>`<details class="history-card"><summary><span>第 ${String(h.hand).padStart(3,'0')} 手</span><span class="${h.result.heroDelta>=0?'positive':'negative'}">${h.result.heroDelta>0?'+':''}${fmt(h.result.heroDelta)}</span></summary>${historyHTML(h)}</details>`).join(''):'<p>暂无手牌记录</p>');}
async function openReview(h){
 openModal(`第 ${String(h.hand).padStart(3,'0')} 手 · 复盘`,`${historyHTML(h)}<h3>决策回顾</h3><div id="reviewAnalysis">计算摊牌权益…</div>`);
 const target=$('#reviewAnalysis'),views=[...reviewViews];if(!views.length){target.textContent='暂无决策记录';return;}
 const rows=[];for(const v of views){try{const {equity}=await compute(v,'equity'),odds=v.legal.call/(v.pot+v.legal.call||1);rows.push(`<p><b>${STREET_NAMES[v.street]}</b> · 摊牌权益 ${Math.round(equity*100)}%${v.legal.call?' · 即时底池赔率 '+Math.round(odds*100)+'%':' · 无需跟注'}</p><div class="equity-meter"><div style="width:${equity*100}%"></div></div><p>${v.legal.call?(equity<odds?'估计胜率低于跟注所需，考虑弃牌。':'估计胜率支持跟注，还需考虑后续下注。'):'无需跟注，可选择过牌或主动下注。'}</p>`);}catch{rows.push('<p>本次范围估计暂不可用。</p>');}}if(target.isConnected)target.innerHTML=rows.join('');
}
function updateSpeed(){$('#speedToggle span').textContent=prefs.speed===1?'标准':'快速';}
function setupOptions(){
 return {seatCount:Number($('#seatCount').value),aiLevel:$('#aiLevel').value,turnSeconds:Number($('#turnSeconds')?.value||30)};
}
function rememberSetup(){
 Object.assign(prefs,setupOptions(),{assist:$('#startAssist').checked});
 savePrefs();
}
function setMode(mode){
 launchMode=mode;
 $$('[data-mode]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mode===mode)));
 $('#launchGame').textContent=mode==='single'?'开始游戏':'创建房间';
 $('#joinGame').hidden=mode==='single';
 const assist=$('.setup-assist');if(assist)assist.toggleAttribute('hidden',mode==='multi');
}
function showTable(){
 atTable=true;$('#startScreen').hidden=true;$('#tableScreen').hidden=false;
 primeAllInAudio();
 startBgm();
}
function showStart(){
 atTable=false;$('#tableScreen').hidden=true;$('#startScreen').hidden=false;
 hideShowdown();
 const resume=$('#resumeGame');if(resume)resume.hidden=game.hand===0||!!online;
 const savedSession=readSession(),roomResume=$('#resumeRoom');
 if(roomResume){roomResume.hidden=!savedSession;if(savedSession)roomResume.textContent=`回到房间 ${savedSession.code}`;}
 updateAdvisor();$('#launchGame').focus();
}
function newLocalTable(options){
 generation++;busy=false;fastHand=-1;reviewViews=[];
 previousActor=null;previousHand=0;previousStreet=null;
 clearLocalTurnTimer();turnDeadline=0;
 for(const key of [...workers.keys()])stopWorker(key);
 game=new Game(options);
}
function launchTable(){
 if(connecting)return;
 rememberSetup();
 if(launchMode==='multi'){openMultiplayer('create');return;}
 newLocalTable(setupOptions());
 showTable();setAssist(prefs.assist,prefs.assist&&!mobileLayout.matches);
 startHand();$('#homeButton').focus();
}
function initialize(){
 applyAllInTrackSource();
 const dialog=document.getElementById('modal');
 $('#seatCount').value=Number.isInteger(prefs.seatCount)&&prefs.seatCount>=MIN_SEATS&&prefs.seatCount<=MAX_SEATS?prefs.seatCount:DEFAULT_SEATS;
 $('#turnSeconds').value=TURN_VALUES.includes(Number(prefs.turnSeconds))?String(prefs.turnSeconds):'30';
 $('#aiLevel').value=Object.hasOwn(levelLabels,prefs.aiLevel)?prefs.aiLevel:DEFAULT_AI_LEVEL;
 $('#startAssist').checked=!!prefs.assist;
 $('#startAssist').onchange=rememberSetup;
 $('#seatCount').onchange=rememberSetup;$('#aiLevel').onchange=rememberSetup;$('#turnSeconds').onchange=rememberSetup;
 setMode('single');
 $$('[data-mode]').forEach(button=>button.onclick=()=>setMode(button.dataset.mode));
 $('#launchGame').onclick=launchTable;
 if($('#resumeRoom'))$('#resumeRoom').onclick=()=>{if(!connecting)restoreSavedSession();};
 $('#joinGame').onclick=()=>{if(!connecting){rememberSetup();openMultiplayer('join');}};
 $('#leaderboardButton').onclick=()=>openLeaderboard();
 if($('#resumeGame'))$('#resumeGame').onclick=()=>{if(!connecting){showTable();render();pump();$('#homeButton').focus();}};
 $('#homeButton').onclick=event=>{event.preventDefault();if(online)openMultiplayer();else showStart();};
 $('#advisorToggle').onclick=()=>setAssist(!prefs.assist);
 $('#soundToggle').onclick=()=>{prefs.sound=!prefs.sound;initAudio();savePrefs();if(prefs.sound)sound('chips');};
 $('#speedToggle').onclick=()=>{prefs.speed=prefs.speed===1?2.5:1;savePrefs();updateSpeed();};
 $('#helpButton').onclick=openRules;$('#borrowButton').onclick=borrowChips;$('#repayButton').onclick=repayChips;$('#ledgerButton').onclick=openLedger;
 for(const id of ['#multiplayerButton','#multiplayerTopButton'])if($(id))$(id).onclick=()=>openMultiplayer();
 $('#closeModal').onclick=closeModal;
 dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}});
 $$('[data-nav]').forEach(b=>b.onclick=()=>{const type=b.dataset.nav;if(type==='table'){closeModal();return;}({history:openHistory,players:openProfiles,settings:openSettings})[type]();});
 $$('[data-tab]').forEach(b=>b.onclick=()=>{sideTab=b.dataset.tab;$$('[data-tab]').forEach(x=>x.classList.toggle('selected',x===b));renderSide();});
 hiddenSidebar.addEventListener('change',renderSide);
 document.addEventListener('click',e=>{if(e.target.closest('#panelHistory'))openHistory();});
 document.addEventListener('pointerdown',()=>{if(atTable&&prefs.sound)startBgm();});
 $('#showdownFx')?.addEventListener('click',hideShowdown);
 if($('#emoteButton'))$('#emoteButton').onclick=event=>{event.stopPropagation();const panel=$('#emotePanel');if(!panel)return;panel.hidden=!panel.hidden;$('#emoteButton').setAttribute('aria-expanded',String(!panel.hidden));renderEmotePanel();};
 if($('#emotePanel'))$('#emotePanel').addEventListener('click',event=>event.stopPropagation());
 document.addEventListener('click',()=>{const panel=$('#emotePanel');if(panel&&!panel.hidden)panel.hidden=true;const button=$('#emoteButton');if(button)button.setAttribute('aria-expanded','false');});
document.addEventListener('keydown',e=>{if(!atTable||e.repeat||e.ctrlKey||e.metaKey||e.altKey||dialog.open||['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))return;const key=e.key.toLowerCase(),l=game.legal(0);if(!l)return;if(key==='f')humanAction('fold');if(key==='c')humanAction(l.canCheck?'check':'call');if(key==='r'&&l.canRaise)humanAction('raise');});
 updateSound();updateSpeed();
 restoreRoom();
 readCustomAllIn();
}
function $$(s){return [...document.querySelectorAll(s)];}
setInterval(()=>{
 const el=$('#turnTimer');
 if(!el)return;
 const left=turnDeadline>0?Math.max(0,Math.ceil((turnDeadline-Date.now())/1000)):0;
 el.toggleAttribute('hidden',!left);
 if(left){el.textContent=left>=60?`${Math.floor(left/60)}:${String(left%60).padStart(2,'0')}`:`${left}s`;el.classList.toggle('urgent',left<=10);}
 const emotePanel=$('#emotePanel');if(emotePanel&&!emotePanel.hidden)renderEmotePanel();
},250);

async function borrowChips(){
 initAudio();
 if(!(game.canBorrow?.(0)??false)){
  toast(game.players[0].pendingLoan?'已有一笔借款将在下手到账，到账后才能再借':game.players[0].stack>=BORROW_THRESHOLD?`只有筹码低于 ${fmt(BORROW_THRESHOLD)} 时才能借款`:`借款已达上限（最多 ${fmt(MAX_DEBT)}）`);
  return;
 }
 if(online){await roomOp('borrow');return;}
 const amount=Math.min(LOAN_AMOUNT,game.borrowable(0));
 try{const pending=game.borrow(0);render();sound('chips');toast(`已借入 ${fmt(amount)}${pending?'，下手到账':''}`);}catch(error){toast(error.message);}
}
async function repayChips(){
 initAudio();if(online){await roomOp('repay');return;}
 const amount=game.repay(0);if(amount){render();sound('chips');toast('已还 '+fmt(amount));}else toast('当前没有可还的欠款');
}
function openLedger(){
 const p=game.players[0],repayAmount=game.repayable?.(0)??Math.min(p.stack,p.debt||0),borrowable=game.borrowable?.(0)??0,canBorrow=game.canBorrow?.(0)??false;
 const loanTimes=Math.floor(MAX_DEBT/LOAN_AMOUNT);
 const borrowLabel=canBorrow?`借入 ${fmt(Math.min(LOAN_AMOUNT,borrowable))}`:p.pendingLoan?'借款到账中':(p.stack>=BORROW_THRESHOLD?'筹码 ≥ 1,000':'借款已达上限');
 openModal('筹码与欠款',`<div class="ledger-summary"><div><span>可用筹码</span><strong>${fmt(p.stack)}</strong></div><div><span>累计欠款</span><strong>${fmt(p.debt||0)}</strong></div><div><span>本场净输赢</span><strong class="${game.net>=0?'positive':'negative'}">${game.net>0?'+':''}${fmt(game.net)}</strong></div></div>${p.pendingLoan?`<p class="loan-pending">下手到账：${fmt(p.pendingLoan)}</p>`:''}<div class="ledger-actions"><button id="ledgerBorrow" class="action-button primary" ${canBorrow?'':'disabled'}>${borrowLabel}</button><button id="repayLoan" class="action-button" ${!repayAmount?'disabled':''}>偿还 ${fmt(repayAmount)}</button></div><p class="session-note">筹码低于 ${fmt(BORROW_THRESHOLD)} 才能借款；累计欠款上限 ${fmt(MAX_DEBT)}（${loanTimes} 次），当前还可借 ${fmt(borrowable)}。牌局中借入的筹码下手到账；还款时会保留本轮跟注所需筹码。</p><div class="loan-history">${(p.loans||[]).map(l=>`<div><span>第 ${l.hand} 手 · ${l.type==='borrow'?'借入':l.auto?'自动还款':'偿还'}</span><strong>${fmt(l.amount)}</strong></div>`).join('')||'<p>暂无借还记录</p>'}</div>`);
 $('#ledgerBorrow').onclick=async()=>{await borrowChips();openLedger();};
 $('#repayLoan').onclick=async()=>{await repayChips();openLedger();};
}
function cleanNickname(value){return String(value||'').replace(/[^\p{L}\p{N} _.-]/gu,'').trim().slice(0,12)||'玩家';}
function newRequestId(){if(globalThis.crypto?.randomUUID)return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');}
function stopOnline(keepSession=false){clearTimeout(pollTimer);stopCustomAllIn();clearLocalTurnTimer();turnDeadline=0;online=null;onlineBusy=false;if(!keepSession)clearSession();}
function roomLine(){return `${online.humans} 位玩家 · ${online.seatCount-online.humans} 位 AI${online.spectators?` · ${online.spectators} 观战`:''} · ${levelLabels[online.aiLevel]} · 回合 ${turnLabel(online.turnMs||TURN_LIMIT_MS)}`;}
function roomTitle(room){return `${room.seatCount} 人房 · ${room.code}${room.spectator?' · 观战':''}${room.away?' · AI 代打':''}`;}
function applyRoom(state){
 if(!online||state.version<online.version)return;
 const changed=state.version!==online.version;
 Object.assign(online,{version:state.version,host:state.host,humans:state.humans,humanSeats:state.humanSeats||[],turnKey:state.turnKey,seatCount:state.seatCount??state.players.length,aiLevel:state.aiLevel??'normal',spectator:!!state.spectator,spectators:state.spectators||0,away:!!state.away,awayReason:state.awayReason||'',turnMs:state.turnMs||online.turnMs||TURN_LIMIT_MS});
 online.emoteCooldownAt=Date.now()+Math.max(0,state.emoteCooldown||0);
 const roomMeta=$('#roomMeta');if(roomMeta)setText(roomMeta,roomLine()+(online.host?' · 房主':'')+(online.spectator?' · 观战':'')+(online.away?' · AI 代打':''));
 if(!changed){setText($('#modeLabel'),roomTitle(online));return;}
 const last=game.events.at(-1),newEvent=state.events.at(-1),newHand=state.sessionId!==game.sessionId||state.hand!==game.hand;
 if(newHand){reviewViews=[];previousActor=null;previousStreet=null;previousHand=0;}
 game=Object.assign(Object.create(Game.prototype),state,{aiLevel:online.aiLevel});game.legal=(id=game.actor)=>id===0?state.actionOptions:null;game.publicView=()=>structuredClone(state.reviewView);
 turnDeadline=state.actor===0&&state.phase==='playing'?Date.now()+Math.max(0,state.turnRemaining||0):0;
 let pendingEmote=null;
 if(newEvent&&JSON.stringify(last)!==JSON.stringify(newEvent)&&newEvent.kind==='emote'){pendingEmote=newEvent;sound('tap');}
 if(newHand)sound('deal');
 else if(newEvent&&JSON.stringify(last)!==JSON.stringify(newEvent)){
  if(newEvent.kind==='street')sound('deal');
  else if(newEvent.amount){if(!newEvent.allin)sound('chips');fly(newEvent.seat);}
 }
 render();
 if(pendingEmote){showEmote(pendingEmote.seat,pendingEmote);pendingEmote=null;}if(state.phase==='complete'&&changed)sound(state.result.heroDelta>0?'win':'tap');
}
async function roomRequest(path,body,token=online?.token){
 const response=await fetch('/api/rooms'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(12000)});
 let data;try{data=await response.json();}catch{throw Error('房间服务暂时不可用');}if(!response.ok)throw Object.assign(Error(data.error||'连接失败'),{status:response.status,retry:!!data.retry});return data;
}
function exitRoom(keepSession=false){
 stopOnline(keepSession);
 if(invitedRoom())history.replaceState(null,'',location.pathname+location.search);
 newLocalTable(setupOptions());closeModal();setMode('multi');showStart();
}
async function pollRoom(){
 const session=online;
 if(!session)return;
 try{
  if(!onlineBusy){
   const data=await roomRequest(`/${session.code}?since=${session.version}`);
   if(online===session){
    if(data.unchanged)setText($('#modeLabel'),roomTitle(session));
    else applyRoom(data.state);
   }
  }
 }catch(error){
  if(online!==session)return;
  if(error.status===401||error.status===404){exitRoom();toast(error.message);return;}
  $('#modeLabel').textContent='重连中…';
 }finally{if(online===session)pollTimer=setTimeout(pollRoom,1000);}
}
async function roomOp(op,extra={}){
 const session=online;
 if(!session||onlineBusy)return;
 onlineBusy=true;
 try{
  const data=await roomRequest('/'+session.code,{op,...extra,requestId:newRequestId()});
  if(online!==session)return;
  if(op!=='leave')applyRoom(data.state);
  if(op==='borrow'){const loan=game.players[0].loans?.[0],amount=loan?.type==='borrow'?loan.amount:LOAN_AMOUNT;toast(`已借入 ${fmt(amount)}${game.players[0].pendingLoan?'，下手到账':''}`);}
  if(op==='repay'){const repaid=game.players[0].loans?.[0]?.type==='repay'?game.players[0].loans[0].amount:0;toast(repaid?'已还 '+fmt(repaid):'暂无可还欠款');}
  return data;
 }catch(error){if(online===session)toast(error.message);}
 finally{if(online===session)onlineBusy=false;}
}
function enterRoom(data,code,inviteOrigin){
 generation++;busy=false;clearLocalTurnTimer();turnDeadline=0;
 // 只有进入时已经结束的摊牌才不回放；中途进桌，本手结束时仍要展示比牌。
 showdownKey=data.state.phase==='complete'?`${data.state.sessionId}:${data.state.hand}`:'';
 hideShowdown();
 for(const key of [...workers.keys()])stopWorker(key);
 online={code,token:data.token,version:-1,inviteOrigin:inviteOrigin||location.origin,spectator:!!data.spectator||!!data.state?.spectator,spectators:data.state?.spectators||0,away:!!data.state?.away,awayReason:data.state?.awayReason||'',turnMs:data.state?.turnMs||TURN_LIMIT_MS};
 writeSession({code,token:data.token,inviteOrigin:online.inviteOrigin});
 $('#advisorPanel').open=false;
 suppressAllInFx=true;
 showTable();applyRoom(data.state);closeModal();$('#homeButton').focus();
 clearTimeout(pollTimer);pollTimer=setTimeout(pollRoom,500);
}
async function bestInviteOrigin(){
 const host=location.hostname;
 if(host&&!['127.0.0.1','localhost','::1','[::1]'].includes(host))return location.origin.replace(/\/$/,'');
 try{
  const r=await fetch('/api/server-info',{cache:'no-store',signal:AbortSignal.timeout(3000)});
  if(r.ok){const info=await r.json();if(Array.isArray(info.urls)&&info.urls[0])return String(info.urls[0]).replace(/\/$/,'');}
 }catch{}
 return location.origin.replace(/\/$/,'');
}
function invitedRoom(){
 const incoming=new URLSearchParams(location.hash.slice(1)).get('room')?.toUpperCase()||'';
 return /^[A-Z2-9]{8}$/.test(incoming)?incoming:'';
}
function invitedSeat(){
 const params=new URLSearchParams(location.hash.slice(1));
 const seat=Number(params.get('seat'));
 return Number.isInteger(seat)&&seat>=0?seat:null;
}
async function copyText(value){
 try{await navigator.clipboard.writeText(value);toast('链接已复制');}
 catch{toast('复制失败，请手动选择链接');}
}
function seatInviteLink(seat){
 const origin=(online?.inviteOrigin||location.origin).replace(/\/$/,'');
 return `${origin}/#room=${online.code}&seat=${seat}`;
}
function openMultiplayer(mode='join'){
 if(online){
  const invite=`${(online.inviteOrigin||location.origin).replace(/\/$/,'')}/#room=${online.code}`;
  const humanSeats=new Set(online.humanSeats||[]);
  const hostPanel=online.host&&!online.spectator?`<div class="host-seat-manager"><h3>座位管理</h3>${game.players.map(player=>{
   const human=humanSeats.has(player.id)||player.isHuman;
   if(player.id===0)return `<div class="host-seat-row"><span>${player.id+1} 号 · ${lbEscape(player.name)}</span><span>你 · 房主</span></div>`;
   return `<div class="host-seat-row"><span>${player.id+1} 号 · ${lbEscape(player.name)}</span><span class="host-seat-actions">${human?`<button type="button" class="text-button" data-kick-seat="${player.id}">踢出 → AI</button>`:`<button type="button" class="text-button" data-fill-seat="${player.id}">补/重置 AI</button><button type="button" class="text-button" data-seat-invite="${player.id}">换真人</button>`}</span></div>`;
  }).join('')}<p class="session-note">踢出真人后该座位由 AI 接管；「换真人」会复制该 AI 座位的邀请链接，朋友打开后接替 AI 并以 2,000 买入。「补/重置 AI」把该 AI 恢复为 2,000 筹码。</p></div>`:'';
  openModal('房间',`<div class="room-code">${online.code}</div><p id="roomMeta">${roomLine()}${online.host?' · 房主':''}${online.spectator?' · 观战':''}</p><div class="ledger-actions"><button id="copyInvite" class="action-button primary">复制邀请</button>${online.spectator||online.away?'':`<button id="awayRoom" class="action-button">暂时离开</button>`}<button id="leaveRoom" class="action-button">${online.spectator?'离开观战':'彻底退出'}</button></div><p class="session-note">${online.spectator?'观战不占座，随时可以离开。':online.away?'当前座位由 AI 代打，点行动栏的「重新接管」可拿回；也可以彻底退出。':'暂时离开：座位交给 AI，保留重连凭证，可从首页「回到房间」或重新打开页面继续。</br>彻底退出：座位释放给 AI/其他玩家，凭证清除。'}</p><label class="field-label" for="inviteLink">邀请链接</label><input id="inviteLink" class="room-input" readonly>${hostPanel}`);
  $('#inviteLink').value=invite;
  $('#copyInvite').onclick=async()=>{const input=$('#inviteLink');try{if(!navigator.clipboard?.writeText)throw Error('clipboard unavailable');await navigator.clipboard.writeText(input.value);}catch{input.focus();input.select();input.setSelectionRange?.(0,input.value.length);try{if(!document.execCommand('copy'))throw Error('copy failed');}catch{toast('请按 Ctrl/⌘+C 复制选中的链接');return;}}toast('邀请链接已复制');};
  $('#awayRoom')?.addEventListener('click',async()=>{if(await roomOp('away'))exitRoom(true);});
 $('#leaveRoom').onclick=async()=>{if(await roomOp('leave'))exitRoom();};
  document.querySelectorAll('[data-kick-seat]').forEach(button=>button.onclick=async()=>{
   const seat=Number(button.dataset.kickSeat),target=game.players.find(player=>player.id===seat);
   openModal('踢出玩家？',`<p>把 ${lbEscape(target?.name||'该玩家')} 踢出，座位由 AI 接管。</p><div class="ledger-actions"><button id="confirmKick" class="action-button primary">确认踢出</button><button id="cancelKick" class="action-button">取消</button></div>`);
   $('#cancelKick').onclick=()=>openMultiplayer();
   $('#confirmKick').onclick=async()=>{if(await roomOp('kick',{seat})){toast('已踢出，座位由 AI 接管');openMultiplayer();}};
  });
  document.querySelectorAll('[data-fill-seat]').forEach(button=>button.onclick=async()=>{
   const seat=Number(button.dataset.fillSeat);
   if(await roomOp('fillAI',{seat})){toast('已补入新的 AI');openMultiplayer();}
  });
  document.querySelectorAll('[data-seat-invite]').forEach(button=>button.onclick=()=>copyText(seatInviteLink(Number(button.dataset.seatInvite))));
  return;
 }
 const join=mode==='join',options=setupOptions(),title=join?'加入房间':'创建房间',savedSession=readSession();
 openModal(title,`<form id="roomForm">${join&&savedSession?`<p class="session-note">上次的房间：<strong>${savedSession.code}</strong> <button type="button" class="small-link" id="resumeSavedRoom">重新接管上一局</button></p>`:''}${join?'':`<p class="session-note">${options.seatCount} 人桌 · ${levelLabels[options.aiLevel]} AI · 回合 ${turnLabel(options.turnSeconds*1000)}</p>`}<label class="field-label" for="playerNickname">昵称</label><input id="playerNickname" class="room-input" name="nickname" maxlength="12" autocomplete="nickname" required>${join?`<label class="field-label" for="roomCodeInput">房间码</label><input id="roomCodeInput" class="room-input" name="code" maxlength="8" autocapitalize="characters" spellcheck="false" value="${invitedRoom()}" required><div class="seat-pick" id="seatPick" hidden><div class="seat-pick-head">选择要接替的 AI 座位<small>新人固定重新买入 2,000</small></div><div id="seatPickList" class="seat-pick-list"></div></div><label class="spectate-check"><input type="checkbox" id="joinSpectate"> 只观战，不占座位</label>`:''}<p id="roomError" role="alert"></p><button class="action-button primary modal-action" id="roomSubmit">${title}</button></form>`);
 const form=$('#roomForm');
 $('#resumeSavedRoom')?.addEventListener('click',()=>{closeModal();restoreSavedSession();});
 let joinSeat=invitedSeat();
 const escapeName=value=>String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
 async function loadSeats(){
  if(!join)return;
  const pick=$('#seatPick'),list=$('#seatPickList');
  if(!pick||!list)return;
  const code=$('#roomCodeInput')?.value.trim().toUpperCase()||'';
  if(!/^[A-Z2-9]{8}$/.test(code)){pick.hidden=true;return;}
  try{
   const lobby=await roomRequest('/'+code+'/lobby',null,false);
   if(($('#roomCodeInput')?.value.trim().toUpperCase()||'')!==code)return;
   const seats=lobby.players.filter(player=>player.available);
   const rows=[`<button type="button" class="seat-option ${joinSeat===null?'selected':''}" data-seat="auto">自动安排<small>随机接替一个 AI</small></button>`]
    .concat(seats.map(player=>`<button type="button" class="seat-option ${joinSeat===player.id?'selected':''}" data-seat="${player.id}">${escapeName(player.name)}<small>${fmt(player.stack)} 筹码 · AI</small></button>`))
    .concat([`<button type="button" class="seat-option new-room" data-new-room="1">新开一个房间<small>不加入这桌</small></button>`]);
   list.innerHTML=rows.join('');
   pick.hidden=!!$('#joinSpectate')?.checked;
   list.querySelectorAll('.seat-option').forEach(button=>{
    button.onclick=()=>{
     if(button.dataset.newRoom){openMultiplayer('create');return;}
     joinSeat=button.dataset.seat==='auto'?null:Number(button.dataset.seat);
     list.querySelectorAll('.seat-option').forEach(item=>item.classList.toggle('selected',item===button));
    };
   });
  }catch{
   pick.hidden=true;
  }
 }
 if(join){
  const codeInput=$('#roomCodeInput'),spectateBox=$('#joinSpectate');
  codeInput?.addEventListener('input',()=>{joinSeat=null;loadSeats();});
  if(spectateBox)spectateBox.onchange=()=>{const pick=$('#seatPick');if(pick)pick.hidden=spectateBox.checked;};
  loadSeats();
 }
 form.onsubmit=async event=>{
  event.preventDefault();if(connecting)return;
  const button=$('#roomSubmit'),error=$('#roomError'),name=cleanNickname($('#playerNickname').value);
  const code=join?$('#roomCodeInput').value.trim().toUpperCase():'';
  if(join&&!/^[A-Z2-9]{8}$/.test(code)){error.textContent='请输入 8 位房间码';return;}
  connecting=true;button.disabled=true;error.textContent='';
  try{
   initAudio();
   const spectate=join&&!!$('#joinSpectate')?.checked;
   const body=join?{name,...(spectate?{spectate:true}:{}),...(!spectate&&joinSeat!==null?{seat:joinSeat}:{})}:{name,...options};
   let data,inviteOrigin;
   for(let attempt=0;;attempt++){
    try{
     [data,inviteOrigin]=await Promise.all([roomRequest(join?'/'+code+'/join':'',body,false),join?location.origin:bestInviteOrigin()]);
     break;
    }catch(e){
     if(join&&e.retry&&attempt<40){error.textContent='本手进行中，正在等待加入…';await delay(1500);continue;}
     throw e;
    }
   }
   enterRoom(data,data.state.code,inviteOrigin);
  }catch(e){error.textContent=e.message;}
  finally{connecting=false;button.disabled=false;}
 };
}
async function restoreSavedSession(){
 const saved=readSession();
 if(!saved?.code||!saved?.token){toast('没有可恢复的房间');return;}
 if(connecting)return;
 connecting=true;
 try{
  const data=await roomRequest('/'+saved.code,undefined,saved.token);
  enterRoom({...data,token:saved.token},saved.code,saved.inviteOrigin);
 }catch{
  clearSession();toast('上次的房间已失效，请重新加入');showStart();
 }finally{connecting=false;}
}
async function restoreRoom(){
 const invited=invitedRoom();
 try{
  const saved=readSession();
  if(saved?.code&&saved?.token&&(!invited||invited===saved.code)){
   connecting=true;
   const data=await roomRequest('/'+saved.code,undefined,saved.token);
   enterRoom({...data,token:saved.token},saved.code,saved.inviteOrigin);return;
  }
 }catch{stopOnline();}
 finally{connecting=false;}
 if(invited){stopOnline(true);setMode('multi');openMultiplayer('join');}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
