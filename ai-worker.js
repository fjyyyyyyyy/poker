import {advise,decide,estimateEquity} from './ai.js';

const actionMemory=new Map();
const advisorMemory={};
let actionSession;

self.onmessage=({data})=>{
 try{
  let result;
  if(data.mode==='advisor')result=advise(data.view,{raiseTo:data.raiseTo,memory:advisorMemory});
  else if(data.mode==='equity')result={equity:estimateEquity(data.view,{samples:350})};
  else{
   const {sessionId,seat}=data.view;
   if(sessionId!==actionSession){actionMemory.clear();actionSession=sessionId;}
   if(!actionMemory.has(seat))actionMemory.set(seat,{});
   result=decide(data.view,{samples:data.samples,memory:actionMemory.get(seat)});
  }
  self.postMessage({id:data.id,result});
 }catch(error){
  self.postMessage({id:data.id,error:error.message});
 }
};
