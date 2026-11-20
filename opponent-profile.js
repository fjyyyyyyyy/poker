const streets=['preflop','flop','turn','river'];
const foldPrior=[0,.25,.40,.56];
const raisePrior=[.27,.13,.12,.10];

export function responseSpot(street,price) {
 const size=price<=0?0:price<=.30?1:price<=.70?2:3;
 return Math.max(0,streets.indexOf(street))*4+size;
}

export function observeHumanAction(player,street,type,call,pot,canRaise) {
 if(!player.isHuman||(call===0&&!canRaise))return;
 const observations=player.observations??=Array(16).fill(null);
 for(const counts of observations){
  if(counts)for(let i=0;i<counts.length;i++)counts[i]*=.985;
 }
 const spot=responseSpot(street,call/Math.max(1,pot));
 const counts=observations[spot]??=[0,0,0,0];
 counts[type==='fold'?0:type==='raise'?2:1]++;
 if(canRaise)counts[3]++;
}

export function learnResponses(player) {
 if(!player.isHuman||!player.observations)return null;
 return player.observations.map((_,spot)=>{
  const street=Math.floor(spot/4),size=spot%4;
  let folds=0,actions=0,raises=0,raiseChances=0;
  for(let i=0;i<16;i++){
   const counts=player.observations[i];
   if(!counts||(i%4===0)!==(size===0))continue;
   const sameStreet=Math.floor(i/4)===street,sameSize=i%4===size;
   const postflop=Math.floor(i/4)>0&&street>0;
   const weight=i===spot?1:sameStreet?.23:sameSize&&postflop?.26:0;
   folds+=counts[0]*weight;
   actions+=(counts[0]+counts[1]+counts[2])*weight;
   raises+=counts[2]*weight;
   raiseChances+=counts[3]*weight;
  }
  return {fold:size?(folds-foldPrior[size]*actions)/(actions+8):0,
   raise:(raises-raisePrior[size]*raiseChances)/(raiseChances+8)};
 });
}
