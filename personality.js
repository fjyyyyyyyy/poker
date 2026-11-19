import {secureRandom} from './evaluator.js';
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
export function seededRandom(seed){let t=seed>>>0;return ()=>{t+=0x6D2B79F5;let x=Math.imul(t^t>>>15,1|t);x^=x+Math.imul(x^x>>>7,61|x);return((x^x>>>14)>>>0)/4294967296;};}
export function newPersonality(id,random=secureRandom,archetype=null){
 const seed=Math.floor(random()*4294967296);
 // “跟注站 / 铁头”：宽范围入池、几乎不弃牌、极少加注和诈唬。
 if(archetype==='station'){
  const r=seededRandom(seed);
  const loose=.70+r()*.08,aggression=.14+r()*.08,bluff=.012+r()*.02,trap=.04+r()*.05,adapt=.25+r()*.15;
  const patience=.75+r()*.15,curiosity=.35+r()*.15,courage=.62+r()*.15,temperament=.5+r()*.15,focus=.75+r()*.15;
  const sticky=.72+r()*.12;
  return {id,seed,loose,aggression,bluff,trap,adapt,patience,curiosity,courage,temperament,focus,sticky,archetype:'station',
   style:'松被动 · 跟注站',
   bio:'很少弃牌，几乎什么牌都愿意平跟看摊牌；不喜欢加注和诈唬，是典型的“铁头”跟注站。'};
 }
 const r=seededRandom(seed),loose=.17+r()*.36,aggression=.35+r()*.6,bluff=.05+r()*.32,trap=.05+r()*.38,adapt=.35+r()*.63;
 const patience=r(),curiosity=r(),courage=r(),temperament=r(),focus=.7+r()*.3;
 // 松而被动的玩家天然更容易一路跟注；紧凶玩家则更愿意弃牌或加注。
 const sticky=clamp(loose*(1.05-aggression)*.6+(r()-.5)*.08,0,.62);
 const style=(loose>.36?'松':'紧')+(aggression>.67?'凶':'活')+' · '+(trap>.30?'设局者':bluff>.26?'施压者':patience>.7?'守望者':adapt>.8?'观察者':curiosity>.7?'探索者':'战术家');
 return {id,seed,loose,aggression,bluff,trap,adapt,patience,curiosity,courage,temperament,focus,sticky,style,
  bio:`${loose>.36?'愿意尝试较宽的起手范围':'耐心选择起手牌'}，${aggression>.67?'主动争夺底池':'重视底池控制'}。${trap>.3?'喜欢慢打和过牌加注。':bluff>.26?'会选择合适的阻断牌制造压力。':'谨慎选择诈唬机会。'}${adapt>.75?'善于根据公开历史调整策略。':'倾向坚持自己的打牌节奏。'}`};
}
// Public events influence a private, bounded emotional response. No hole cards are observed.
export function tableMood(persona,publicEvents,seat){
 const pressure=publicEvents.filter(e=>e.kind==='action'&&e.type==='raise'&&e.seat!==seat).length;
 return {caution:clamp(pressure*.025*(1-persona.courage),0,.13),reactance:clamp(pressure*.02*persona.temperament,0,.12)};
}
