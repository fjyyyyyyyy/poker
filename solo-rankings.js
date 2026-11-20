import {RANK_WINDOW_MS} from './rankings.js';

const sessionRecords=new Map();
let storeReady;
function database(){
 return storeReady??=new Promise((resolve,reject)=>{
  const request=indexedDB.open('river-room-rankings',1);
  request.onupgradeneeded=()=>{
   request.result.createObjectStore('hands',{keyPath:'id'}).createIndex('at','at');
  };
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
  request.onblocked=()=>reject(Error('手牌记录暂不可用'));
 });
}

export async function rememberSoloRecord(record){
 sessionRecords.set(record.id,record);
 try {
  const db=await database();
  const transaction=db.transaction('hands','readwrite'),hands=transaction.objectStore('hands');
  hands.put(record);
  const expired=hands.index('at').openCursor(IDBKeyRange.upperBound(Date.now()-RANK_WINDOW_MS,true));
  expired.onsuccess=()=>{
   const row=expired.result;
   if(row){row.delete();row.continue();}
  };
  transaction.oncomplete=()=>sessionRecords.delete(record.id);
 } catch { /* 当前标签页仍保留这手牌 */ }
}

export async function readSoloRecords(){
 const cutoff=Date.now()-RANK_WINDOW_MS,records=new Map(sessionRecords);
 try {
  const db=await database();
  const persisted=await new Promise((resolve,reject)=>{
   const request=db.transaction('hands').objectStore('hands').index('at').getAll(IDBKeyRange.lowerBound(cutoff));
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error);
  });
  for(const record of persisted)records.set(record.id,record);
 } catch { /* 使用当前标签页中的记录 */ }
 return [...records.values()].filter(record=>record.at>=cutoff);
}
