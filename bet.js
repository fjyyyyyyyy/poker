// All voluntary bets and raises are expressed in whole chips of this unit.
// Forced amounts (a short all-in call or a short blind) can still be smaller.
export const BET_UNIT=10;
export const ceilBet=n=>Math.ceil(n/BET_UNIT)*BET_UNIT;
export const floorBet=n=>Math.floor(n/BET_UNIT)*BET_UNIT;
export const snapBet=n=>Math.round(n/BET_UNIT)*BET_UNIT;
export const isBet=n=>Number.isInteger(n)&&n%BET_UNIT===0;
