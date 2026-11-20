import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evaluate} from './evaluator.js';
import {RANK_WINDOW_MS,rankSummary,recentRankings} from './rankings.js';

const day=at=>new Date(at).toISOString().slice(0,10);
const isId=/^[0-9a-f-]{32,36}$/;

async function legacyHands(filename,cutoff) {
 let entries;
 try {entries=JSON.parse(await readFile(filename,'utf8'));} catch {return [];}
 if(!Array.isArray(entries))return [];
 const records=new Map();
 for(const entry of entries){
  if(!entry||typeof entry.id!=='string'||!Number.isFinite(entry.at)||entry.at<cutoff)continue;
  const match=entry.id.match(/^(?:win|hand):([0-9]+):([0-9]+)(?::[0-9]+)?$/);
  const detail=entry.detail,board=detail?.board;
  if(!match||!Array.isArray(board)||!Array.isArray(detail.players))continue;
  const id=createHash('sha256').update(match[1]+':'+match[2]).digest('hex').slice(0,32);
  if(records.has(id))continue;
  const players=detail.players.map(player=>{
   const hole=!player.folded&&player.hole?.length===2?player.hole:[];
   let rank=null;
   if(hole.length&&board.length===5){try{rank=evaluate([...hole,...board]);}catch{}}
   return {seat:player.seat-1,name:player.name,human:player.isHuman,folded:player.folded,
    stack:player.stack,hole:rank?hole:[],handName:rank?.name??null,score:rank?.score??null,
    award:detail.winners?.find(winner=>winner.seat===player.seat)?.amount||0};
  });
  records.set(id,{id,source:'online',at:entry.at,number:Number(match[2]),board,players,pots:[],events:[],
   pot:players.reduce((sum,player)=>sum+player.award,0)});
 }
 return [...records.values()];
}

export class RankingStore {
 entries=new Map();
 constructor(directory) {this.directory=directory;}

 async load(legacyFile) {
  const cutoff=Date.now()-RANK_WINDOW_MS;
  for(const record of await legacyHands(legacyFile,cutoff)){
   this.entries.set(record.id,{summary:rankSummary(record),legacy:record});
  }
  let days;
  try {days=await readdir(this.directory);} catch(error){
   if(error.code==='ENOENT')return;
   throw error;
  }
  for(const date of days.filter(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&value>=day(cutoff))){
   const directory=join(this.directory,date),files=await readdir(directory);
   for(let start=0;start<files.length;start+=32){
    await Promise.all(files.slice(start,start+32).map(async file=>{
     const id=file.endsWith('.json')?file.slice(0,-5):'';
     if(!isId.test(id))return;
     const path=join(directory,file);
     try {
      const record=JSON.parse(await readFile(path,'utf8'));
      if(record.id===id&&record.at>=cutoff)this.entries.set(id,{summary:rankSummary(record),path});
     } catch(error){console.warn('[river] 跳过无法读取的排行榜记录',file,error.code||error.name);}
    }));
   }
  }
 }

 add(record) {
  if(this.entries.has(record.id))return;
  const directory=join(this.directory,day(record.at));
  const entry={summary:rankSummary(record),directory,path:join(directory,record.id+'.json'),pending:record};
  this.entries.set(record.id,entry);
  this.write(entry);
 }

 write(entry) {
  if(!entry.pending||entry.writing)return entry.writing;
  const staged=entry.path+'.tmp';
  entry.writing=mkdir(entry.directory,{recursive:true})
   .then(()=>writeFile(staged,JSON.stringify(entry.pending),{mode:0o600}))
   .then(()=>rename(staged,entry.path))
   .then(()=>{entry.pending=null;})
   .catch(error=>console.warn('[river] 排行榜暂未保存',error.code||error.name))
   .finally(()=>{entry.writing=null;});
  return entry.writing;
 }

 list() {
  return recentRankings([...this.entries.values()].map(entry=>entry.summary));
 }

 async get(id) {
  const entry=this.entries.get(id);
  if(!entry||entry.summary.at<Date.now()-RANK_WINDOW_MS)return null;
  return entry.pending||entry.legacy||JSON.parse(await readFile(entry.path,'utf8'));
 }

 flush() {
  return Promise.all([...this.entries.values()].map(entry=>this.write(entry)));
 }

 cleanup(now) {
  for(const [id,entry] of this.entries){
   if(!entry.pending&&entry.summary.at<now-RANK_WINDOW_MS)this.entries.delete(id);
   else if(entry.pending)this.write(entry);
  }
 }
}
