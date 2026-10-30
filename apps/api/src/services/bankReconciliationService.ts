import type { Knex } from 'knex';
const fail = (message: string, status = 422) => Object.assign(new Error(message), { status, expose: true });
type Allocation = { posting_id: number; allocated_amount: string };
function units(value: unknown, label = 'Amount'): bigint {
  const text = String(value ?? '0'); const m = /^(-?)(0|[1-9]\d{0,14})(?:\.(\d{1,4}))?$/.exec(text);
  if (!m) throw fail(`${label} must be a decimal amount with up to four places`);
  const n = BigInt(m[2]) * 10000n + BigInt((m[3] || '').padEnd(4, '0') || '0'); return m[1] ? -n : n;
}
function money(n: bigint): string { const x=n<0n?-n:n;return `${n<0n?'-':''}${x/10000n}.${String(x%10000n).padStart(4,'0')}`; }
function cleanDate(value: unknown): string { return String(value).slice(0,10); }

export async function prepareBankReconciliation(db: Knex, statementId: number, userId: number) {
  return db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(7224103901)');
    const statement = await trx('bank_statements as s').join('accounts as a','a.account_id','s.account_id').where('s.statement_id',statementId).select('s.*','a.status as account_status','a.reconciliation_enabled','a.account_no').first();
    if (!statement) throw fail('Bank statement not found',404);
    if (statement.account_status!=='ACTIVE'||!statement.reconciliation_enabled) throw fail('Bank account must be active and reconciliation enabled',422);
    if (!statement.period_to||statement.closing_balance===null) throw fail('Statement requires a period end date and closing balance',422);
    const existing=await trx('bank_reconciliations').where({statement_id:statementId}).first();
    if(existing){if(existing.status==='PREPARED')return {reconciliation:existing,resumed:true};throw fail('This statement already has a finalized bank reconciliation',409);}
    const [created]=await trx('bank_reconciliations').insert({account_id:statement.account_id,statement_id:statementId,period_from:statement.period_from,period_to:statement.period_to,bank_closing_balance:statement.closing_balance,status:'PREPARED',prepared_by:userId,prepared_at:trx.fn.now()}).returning('*');
    await trx('audit_logs').insert({user_id:userId,action:'BANK_RECONCILIATION_PREPARED',table_name:'bank_reconciliations',record_id:String(created.reconciliation_id),new_values:{statement_id:statementId,account_id:statement.account_id,period_from:statement.period_from,period_to:statement.period_to,bank_closing_balance:String(statement.closing_balance)}});
    return {reconciliation:created,resumed:false};
  });
}

export async function listBankReconciliations(db: Knex) {
  return db('bank_reconciliations as r').leftJoin('accounts as a','a.account_id','r.account_id').leftJoin('bank_statements as s','s.statement_id','r.statement_id')
    .select('r.*','a.account_no','a.account_name','s.original_filename','s.row_count')
    .select(db.raw('(SELECT COUNT(*) FROM bank_statement_entries e WHERE e.statement_id=r.statement_id) AS statement_entry_count'))
    .select(db.raw("(SELECT COUNT(*) FROM bank_statement_entries e WHERE e.statement_id=r.statement_id AND e.processing_status='MATCHED') AS matched_entry_count"))
    .orderBy('r.created_at','desc').limit(200);
}

export async function getBankReconciliationDetail(db: Knex, id: number) {
  const reconciliation=await db('bank_reconciliations as r').leftJoin('accounts as a','a.account_id','r.account_id').leftJoin('bank_statements as s','s.statement_id','r.statement_id').where('r.reconciliation_id',id).select('r.*','a.account_no','a.account_name','s.original_filename','s.row_count','s.opening_balance as statement_opening_balance').first();
  if(!reconciliation)throw fail('Bank reconciliation not found',404);
  const entries=await db('bank_statement_entries as e').where({statement_id:reconciliation.statement_id}).select('e.*').orderBy('e.posting_date').orderBy('e.import_row_number');
  const matches=await db('bank_reconciliation_matches as m').leftJoin('users as u','u.user_id','m.confirmed_by').where('m.reconciliation_id',id).select('m.*','u.name as confirmed_by_name').orderBy('m.match_id');
  const matchIds=matches.map(m=>Number(m.match_id));
  const allocations=matchIds.length?await db('bank_reconciliation_match_items as i').join('transaction_postings as p','p.posting_id','i.posting_id').join('transactions as t','t.transaction_id','p.transaction_id').join('accounts as a','a.account_id','p.account_id').leftJoin('transaction_types as tt','tt.transaction_type_id','t.transaction_type_id').whereIn('i.match_id',matchIds).select('i.*','p.account_id','a.account_no','p.debit_amount','p.credit_amount','t.transaction_no','t.transaction_date','t.reference as transaction_reference','t.description as transaction_description','tt.name as transaction_type_name').orderBy('i.match_id').orderBy('i.item_id'):[];
  let preview: {ledger_closing_balance:string;closing_difference:string}|null=null;
  if(reconciliation.status==='PREPARED'){
    const opening=await db('account_opening_balances').where({account_id:reconciliation.account_id,status:'APPROVED'}).where('effective_date','<=',reconciliation.period_to).select(db.raw('COALESCE(SUM(debit_amount-credit_amount),0)::numeric AS amount')).first();
    const movements=await db('transaction_postings as p').join('transactions as t','t.transaction_id','p.transaction_id').where('p.account_id',reconciliation.account_id).where('t.status','POSTED').where('t.transaction_date','<=',reconciliation.period_to).select(db.raw('COALESCE(SUM(p.debit_amount-p.credit_amount),0)::numeric AS amount')).first();
    const ledger=units(opening?.amount||'0')+units(movements?.amount||'0');preview={ledger_closing_balance:money(ledger),closing_difference:money(units(reconciliation.bank_closing_balance)-ledger)};
  }else if(reconciliation.ledger_closing_balance!==null){preview={ledger_closing_balance:String(reconciliation.ledger_closing_balance),closing_difference:String(reconciliation.closing_difference)};}
  return {reconciliation,entries,matches,allocations,preview};
}

export async function getBankMatchCandidates(db:Knex,reconciliationId:number,entryId:number,q=''){
  const reconciliation=await db('bank_reconciliations').where({reconciliation_id:reconciliationId,status:'PREPARED'}).first();if(!reconciliation)throw fail('A prepared bank reconciliation is required',409);
  const entry=await db('bank_statement_entries').where({entry_id:entryId,statement_id:reconciliation.statement_id}).first();if(!entry)throw fail('Statement entry not found in this reconciliation',404);if(entry.processing_status==='MATCHED')throw fail('Statement entry is already matched',409);
  const incoming=units(entry.credit)>0n;if((units(entry.debit)>0n)===incoming||units(entry.debit)===0n&&units(entry.credit)===0n)throw fail('Statement entry must contain one positive debit or credit amount');
  const candidateQuery=db('transaction_postings as p').join('transactions as t','t.transaction_id','p.transaction_id').leftJoin('transaction_types as tt','tt.transaction_type_id','t.transaction_type_id').where('p.account_id',reconciliation.account_id).where('t.status','POSTED').where('t.transaction_date','<=',reconciliation.period_to);
  if(incoming)candidateQuery.whereRaw('p.debit_amount > p.credit_amount');else candidateQuery.whereRaw('p.credit_amount > p.debit_amount');
  if(q.trim())candidateQuery.andWhere(b=>b.whereILike('t.reference',`%${q.trim()}%`).orWhereILike('t.description',`%${q.trim()}%`).orWhereRaw('CAST(t.transaction_no AS TEXT) ILIKE ?',[`%${q.trim()}%`]));
  const candidates=await candidateQuery.select('p.posting_id','p.transaction_id','p.account_id','p.debit_amount','p.credit_amount','t.transaction_no','t.transaction_date','t.reference','t.description','tt.name as transaction_type').orderBy('t.transaction_date','desc').orderBy('t.transaction_no','desc').limit(500);
  const postingIds=candidates.map(p=>Number(p.posting_id));const used=postingIds.length?await db('bank_reconciliation_match_items as i').join('bank_reconciliation_matches as m','m.match_id','i.match_id').whereIn('i.posting_id',postingIds).where('m.match_status','CONFIRMED').groupBy('i.posting_id').select('i.posting_id').sum({allocated:'i.allocated_amount'}):[];
  const usedRows=used as Array<{posting_id:number|string;allocated:string}>;const usedById=new Map<number,bigint>(usedRows.map(row=>[Number(row.posting_id),units(row.allocated)]));const entryAmount=units(incoming?entry.credit:entry.debit);const bankRef=String(entry.bank_reference_number||'').trim().toLowerCase();
  const rows=candidates.map(p=>{const gross=incoming?units(p.debit_amount)-units(p.credit_amount):units(p.credit_amount)-units(p.debit_amount);const available=gross-(usedById.get(Number(p.posting_id))||0n);const referenceMatch=!!bankRef&&String(p.reference||'').trim().toLowerCase()===bankRef;return {...p,available_amount:money(available),exact_amount_available:available===entryAmount,reference_match:referenceMatch};}).filter(p=>units(p.available_amount)>0n).sort((a,b)=>Number(b.exact_amount_available)-Number(a.exact_amount_available)||Number(b.reference_match)-Number(a.reference_match)||Math.abs(new Date(cleanDate(a.transaction_date)).getTime()-new Date(cleanDate(entry.posting_date)).getTime())-Math.abs(new Date(cleanDate(b.transaction_date)).getTime()-new Date(cleanDate(entry.posting_date)).getTime()));
  return {entry,candidates:rows.slice(0,200),candidate_count:rows.length,note:'Suggestions only. Reference and amount similarities are not unique identifiers; a user must review and select exact allocations.'};
}

export async function confirmBankMatch(db:Knex,reconciliationId:number,entryId:number,allocations:Allocation[],remarks:string|undefined,userId:number){
  if(!allocations.length)throw fail('Select at least one ledger posting');if(new Set(allocations.map(a=>a.posting_id)).size!==allocations.length)throw fail('A ledger posting cannot be listed twice in one match');
  const requested=allocations.map(a=>({posting_id:a.posting_id,units:units(a.allocated_amount,'Allocation')}));if(requested.some(a=>a.units<=0n))throw fail('Allocations must be positive amounts');
  return db.transaction(async trx=>{
    await trx.raw('SELECT pg_advisory_xact_lock(7224103901)');
    const rec=await trx('bank_reconciliations').where({reconciliation_id:reconciliationId,status:'PREPARED'}).forUpdate().first();if(!rec)throw fail('A prepared bank reconciliation is required',409);
    const entry=await trx('bank_statement_entries').where({entry_id:entryId,statement_id:rec.statement_id}).forUpdate().first();if(!entry)throw fail('Statement entry not found in this reconciliation',404);if(entry.processing_status==='MATCHED')throw fail('Statement entry is already matched',409);
    const debit=units(entry.debit),credit=units(entry.credit);if((debit>0n)===(credit>0n))throw fail('Statement entry must contain exactly one positive debit or credit amount');const target=debit>0n?debit:credit;
    const allocatedTotal=requested.reduce((sum,a)=>sum+a.units,0n);if(allocatedTotal!==target)throw fail(`Allocations must equal the bank entry exactly (${money(target)})`);
    const postingIds=requested.map(a=>a.posting_id);const postings=await trx('transaction_postings as p').join('transactions as t','t.transaction_id','p.transaction_id').whereIn('p.posting_id',postingIds).where('p.account_id',rec.account_id).where('t.status','POSTED').where('t.transaction_date','<=',rec.period_to).select('p.posting_id','p.transaction_id','p.debit_amount','p.credit_amount','t.transaction_no','t.transaction_date').forUpdate('p');
    if(postings.length!==requested.length)throw fail('One or more selections are not posted ledger lines for this bank account and statement period');const byId=new Map(postings.map(p=>[Number(p.posting_id),p]));
    const consumed=await trx('bank_reconciliation_match_items as i').join('bank_reconciliation_matches as m','m.match_id','i.match_id').whereIn('i.posting_id',postingIds).where('m.match_status','CONFIRMED').groupBy('i.posting_id').select('i.posting_id').sum({allocated:'i.allocated_amount'});const consumedRows=consumed as Array<{posting_id:number|string;allocated:string}>;const consumedById=new Map<number,bigint>(consumedRows.map(row=>[Number(row.posting_id),units(row.allocated)]));
    for(const allocation of requested){const posting=byId.get(allocation.posting_id)!;const incoming=credit>0n;const gross=incoming?units(posting.debit_amount)-units(posting.credit_amount):units(posting.credit_amount)-units(posting.debit_amount);if(gross<=0n)throw fail('Ledger posting direction does not match the bank statement debit/credit direction');const available=gross-(consumedById.get(allocation.posting_id)||0n);if(allocation.units>available)throw fail(`Allocation exceeds the unallocated posting amount for transaction #${posting.transaction_no}`);}
    const [match]=await trx('bank_reconciliation_matches').insert({reconciliation_id:reconciliationId,match_type:'MANUAL_ALLOCATION',match_status:'PROPOSED',matching_criteria:{method:'manual',bank_reference:entry.bank_reference_number||null,original_remarks:entry.original_remarks,bank_debit:String(entry.debit),bank_credit:String(entry.credit)},remarks:remarks||null}).returning('*');
    await trx('bank_reconciliation_match_items').insert(requested.map(a=>({match_id:match.match_id,entry_id:entryId,transaction_id:byId.get(a.posting_id)!.transaction_id,posting_id:a.posting_id,allocated_amount:money(a.units)})));
    const [confirmed]=await trx('bank_reconciliation_matches').where({match_id:match.match_id,match_status:'PROPOSED'}).update({match_status:'CONFIRMED',confirmed_by:userId,confirmed_at:trx.fn.now()}).returning('*');
    await trx('bank_statement_entries').where({entry_id:entryId,processing_status:'UNMATCHED'}).update({processing_status:'MATCHED'});
    await trx('audit_logs').insert({user_id:userId,action:'BANK_MATCH_CONFIRMED',table_name:'bank_reconciliation_matches',record_id:String(match.match_id),new_values:{reconciliation_id:reconciliationId,entry_id:entryId,allocations:requested.map(a=>({posting_id:a.posting_id,allocated_amount:money(a.units)})),remarks:remarks||null}});
    return confirmed;
  });
}

export async function approveBankReconciliation(db:Knex,reconciliationId:number,userId:number){
  return db.transaction(async trx=>{
    await trx.raw('SELECT pg_advisory_xact_lock(7224103901)');const rec=await trx('bank_reconciliations').where({reconciliation_id:reconciliationId,status:'PREPARED'}).forUpdate().first();if(!rec)throw fail('Only a prepared bank reconciliation can be approved',409);
    const pending=await trx('bank_statement_entries').where({statement_id:rec.statement_id}).whereNot({processing_status:'MATCHED'}).count('* as n').first();if(Number(pending?.n||0)>0)throw fail('Every statement entry must be manually matched before approval',409);
    const accountOpening=await trx('account_opening_balances').where({account_id:rec.account_id,status:'APPROVED'}).where('effective_date','<=',rec.period_to).select(trx.raw('COALESCE(SUM(debit_amount-credit_amount),0)::numeric AS amount')).first();
    const ledger=await trx('transaction_postings as p').join('transactions as t','t.transaction_id','p.transaction_id').where('p.account_id',rec.account_id).where('t.status','POSTED').where('t.transaction_date','<=',rec.period_to).select(trx.raw('COALESCE(SUM(p.debit_amount-p.credit_amount),0)::numeric AS amount')).first();
    const ledgerClosing=units(accountOpening?.amount||'0')+units(ledger?.amount||'0');const bankClosing=units(rec.bank_closing_balance);const difference=bankClosing-ledgerClosing;if(difference!==0n)throw fail(`Cannot approve: statement-to-ledger closing difference is ${money(difference)}`,409);
    const [approved]=await trx('bank_reconciliations').where({reconciliation_id:reconciliationId,status:'PREPARED'}).update({status:'APPROVED',ledger_closing_balance:money(ledgerClosing),closing_difference:money(difference),approved_by:userId,approved_at:trx.fn.now()}).returning('*');
    await trx('audit_logs').insert({user_id:userId,action:'BANK_RECONCILIATION_APPROVED',table_name:'bank_reconciliations',record_id:String(reconciliationId),old_values:{status:rec.status},new_values:{status:approved.status,bank_closing_balance:String(rec.bank_closing_balance),ledger_closing_balance:money(ledgerClosing),closing_difference:money(difference)}});return approved;
  });
}
