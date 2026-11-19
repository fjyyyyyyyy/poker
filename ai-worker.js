import {advise,decide,estimateEquity} from './ai.js';

const actionMemory={};
const advisorMemory={};

self.onmessage=({data})=>{
 try{
  let result;
  if(data.mode==='advisor')result=advise(data.view,{raiseTo:data.raiseTo,memory:advisorMemory});
  else if(data.mode==='equity')result={equity:estimateEquity(data.view,{samples:350})};
  else result=decide(data.view,{samples:data.samples,memory:actionMemory});
  self.postMessage({id:data.id,result});
 }catch(error){
  self.postMessage({id:data.id,error:error.message});
 }
};
