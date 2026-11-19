// Card id: suit * 13 + rank - 2. No dependency on the game or deck.
export const SUITS = ['♠', '♥', '♣', '♦'];
export const RANKS = '23456789TJQKA';
export const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];
export const rank = c => c % 13 + 2;
export const suit = c => Math.floor(c / 13);
export const cardText = c => RANKS[c % 13].replace('T', '10') + SUITS[suit(c)];
function straight(rs) {
  const set = new Set(rs); if (set.has(14)) set.add(1);
  let run = 0;
  for (let r = 14; r >= 1; r--) { run = set.has(r) ? run + 1 : 0; if (run === 5) return r + 4; }
  return 0;
}
export function evaluate(cards) {
  if (cards.length < 5 || cards.length > 7 || new Set(cards).size !== cards.length) throw Error('Expected 5–7 distinct cards');
  const rs = cards.map(rank).sort((a,b)=>b-a), counts = new Map();
  rs.forEach(r=>counts.set(r,(counts.get(r)||0)+1));
  const groups = [...counts].sort((a,b)=>b[1]-a[1] || b[0]-a[0]);
  const flush = [0,1,2,3].map(s=>cards.filter(c=>suit(c)===s).map(rank).sort((a,b)=>b-a)).find(a=>a.length>=5);
  let category, kickers;
  const sf = flush && straight(flush), st = straight(rs);
  if (sf) { category=8; kickers=[sf]; }
  else if (groups[0][1]===4) { category=7; kickers=[groups[0][0],rs.find(r=>r!==groups[0][0])]; }
  else if (groups[0][1]===3 && groups[1][1]>=2) { category=6; kickers=[groups[0][0],groups[1][0]]; }
  else if (flush) { category=5; kickers=flush.slice(0,5); }
  else if (st) { category=4; kickers=[st]; }
  else if (groups[0][1]===3) { category=3; kickers=[groups[0][0],...rs.filter(r=>r!==groups[0][0]).slice(0,2)]; }
  else if (groups[0][1]===2 && groups[1][1]===2) { const pairs=groups.filter(x=>x[1]===2).map(x=>x[0]).sort((a,b)=>b-a).slice(0,2); category=2;kickers=[...pairs,rs.find(r=>!pairs.includes(r))]; }
  else if (groups[0][1]===2) { category=1;kickers=[groups[0][0],...rs.filter(r=>r!==groups[0][0]).slice(0,3)]; }
  else { category=0;kickers=rs.slice(0,5); }
  let score=category;for(let i=0;i<5;i++)score=score*15+(kickers[i]||0);
  return {score,category,kickers,name:HAND_NAMES[category]};
}
export function shuffledDeck(random = secureRandom) {
  const a=Array.from({length:52},(_,i)=>i);
  for(let i=51;i>0;i--){const j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;
}
export function secureRandom() { const a=new Uint32Array(1);crypto.getRandomValues(a);return a[0]/4294967296; }
