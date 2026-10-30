/** Exact operational reconciliation formulas. Amounts remain decimal strings at persistence boundaries. */
export function weeklyBalances(bank:number,chqA:number,chqB:number,chqC:number,supplierBal:number){return {current:bank+chqB-chqA,net:bank+chqB-chqC-supplierBal};}
export function effect(amount:number,multiplier:-1|0|1):number{return amount*multiplier;}
