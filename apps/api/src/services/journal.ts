export type Rule = { rule_id:number; debit_account_id:number|null; credit_account_id:number|null; account_selection_mode:string; amount_source:string; rule_name:string; party_account_side?:'DEBIT'|'CREDIT'|'NONE' };
export type JournalLine = {account_id:number; debit_amount:string; credit_amount:string; narration:string; party_entity_line:boolean};

function decimalUnits(raw:string|number):bigint {
  const value=String(raw).trim();
  if(!/^-?\d+(\.\d{1,4})?$/.test(value)) throw Object.assign(new Error('Amount must be a decimal with at most four fractional digits'),{status:422,expose:true});
  const negative=value.startsWith('-');
  const [whole,frac='']=value.replace('-','').split('.');
  const units=BigInt(whole)*10000n+BigInt(frac.padEnd(4,'0'));
  return negative?-units:units;
}
function formatUnits(value:bigint){const neg=value<0n?'−':'';const n=value<0n?-value:value;return `${neg}${n/10000n}.${String(n%10000n).padStart(4,'0')}`;}

/** Resolve exactly one explicitly configured double-entry rule. Refuses implicit accounting guesses. */
export function resolveJournal(ruleRows:Rule[],amount:string|number,selectedAccountId?:number|null):JournalLine[]{
  const rules=ruleRows.filter(r=>r.rule_id>0);
  if(rules.length!==1) throw Object.assign(new Error(rules.length===0?'No active posting rule is configured for this transaction type':'This transaction type has multiple active posting rules; configure a single complete debit/credit pair before posting'),{status:422,expose:true});
  const rule=rules[0]!;
  if(rule.amount_source!=='TRANSACTION') throw Object.assign(new Error(`Unsupported amount source "${rule.amount_source}" in rule ${rule.rule_name}`),{status:422,expose:true});
  let debit=rule.debit_account_id,credit=rule.credit_account_id;
  if(rule.account_selection_mode==='FIXED'){
    if(!debit||!credit) throw Object.assign(new Error(`Posting rule "${rule.rule_name}" needs fixed debit and credit accounts`),{status:422,expose:true});
  } else if(rule.account_selection_mode==='USER_SELECTED'){
    if(!selectedAccountId) throw Object.assign(new Error(`Select an account for posting rule "${rule.rule_name}"`),{status:422,expose:true});
    if(!debit) debit=selectedAccountId;
    else if(!credit) credit=selectedAccountId;
    else throw Object.assign(new Error(`Rule "${rule.rule_name}" has both accounts fixed; use FIXED mode`),{status:422,expose:true});
  } else throw Object.assign(new Error(`Unknown account selection mode in rule "${rule.rule_name}"`),{status:422,expose:true});
  if(!debit||!credit||debit===credit) throw Object.assign(new Error(`Posting rule "${rule.rule_name}" must resolve to two different accounts`),{status:422,expose:true});
  const units=decimalUnits(amount);
  if(units===0n) throw Object.assign(new Error('Transaction amount must not be zero'),{status:422,expose:true});
  const abs=formatUnits(units<0n?-units:units),reverse=units<0n,side=rule.party_account_side??'NONE';
  if(!['DEBIT','CREDIT','NONE'].includes(side))throw Object.assign(new Error(`Invalid party account side in rule ${rule.rule_name}`),{status:422,expose:true});
  const partyAccount=side==='DEBIT'?debit:side==='CREDIT'?credit:null;
  const lines=reverse?[
    {account_id:debit, debit_amount:'0.0000',credit_amount:abs,narration:rule.rule_name},
    {account_id:credit,debit_amount:abs,credit_amount:'0.0000',narration:rule.rule_name},
  ]:[
    {account_id:debit,debit_amount:abs,credit_amount:'0.0000',narration:rule.rule_name},
    {account_id:credit,debit_amount:'0.0000',credit_amount:abs,narration:rule.rule_name},
  ];
  return lines.map(line=>({...line,party_entity_line:partyAccount===line.account_id}));
}
