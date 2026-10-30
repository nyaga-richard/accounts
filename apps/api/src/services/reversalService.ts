import type {Knex} from 'knex';
const fail=(message:string,status=422)=>Object.assign(new Error(message),{status,expose:true});
export async function reversePostedTransaction(db:Knex,originalId:number,reversalDate:string,reason:string,userId:number){
 return db.transaction(async trx=>{
  await trx.raw('SELECT pg_advisory_xact_lock(7224103901)');
  const original=await trx('transactions').where({transaction_id:originalId}).first();
  if(!original||original.status!=='POSTED')throw fail('Only a posted transaction can be reversed',404);
  if(await trx('transaction_reversals').where({original_transaction_id:originalId}).first())throw fail('This transaction has already been reversed',409);
  const closedPeriod=await trx('accounting_periods').where('status','CLOSED').where('start_date','<=',reversalDate).where('end_date','>=',reversalDate).first();if(closedPeriod)throw fail('Reversal date falls within a closed accounting period',409);
  const closedWeek=await trx('weekly_closings').whereIn('status',['CLOSED','APPROVED']).where('week_start_date','<=',reversalDate).where('week_end_date','>=',reversalDate).first();if(closedWeek)throw fail('Reversal date falls within a closed week',409);
  const openingCutoff=await trx('opening_balance_batches').where({status:'APPROVED'}).where('effective_date','>',reversalDate).first();if(openingCutoff)throw fail('Reversal date predates an approved opening balance cutover',409);
  const unclearedCheque=await trx('cheques').where({transaction_id:originalId}).whereNotIn('cheque_status',['CANCELLED','DISHONOURED','STOPPED','RETURNED']).first();if(unclearedCheque)throw fail('Resolve or cancel the linked cheque before reversing this transaction',409);
  const originalLines=await trx('transaction_postings').where({transaction_id:originalId}).orderBy('posting_id');if(!originalLines.length)throw fail('Original transaction has no accounting postings');
  const reversedAmount=String(original.amount).startsWith('-')?String(original.amount).slice(1):`-${String(original.amount)}`;
  const [reversal]=await trx('transactions').insert({transaction_date:reversalDate,transaction_type_id:original.transaction_type_id,particulars_type:original.particulars_type,particulars_id:original.particulars_id,reference:`REV-${original.transaction_no}`,description:`Reversal of transaction #${original.transaction_no}: ${reason}`,account_id:original.account_id,amount:reversedAmount,current_balance_effect_applied:original.current_balance_effect_applied,net_balance_effect_applied:original.net_balance_effect_applied,entered_by:userId,status:'DRAFT',reversal_of_transaction_id:originalId}).returning(['transaction_id','transaction_no','transaction_date','amount']);
  await trx('transaction_postings').insert(originalLines.map(line=>({transaction_id:reversal.transaction_id,account_id:line.account_id,supplier_id:line.supplier_id,customer_id:line.customer_id,cashier_id:line.cashier_id,party_id:line.party_id,debit_amount:line.credit_amount,credit_amount:line.debit_amount,narration:`Reversal of #${original.transaction_no}`})));
  await trx('transactions').where({transaction_id:reversal.transaction_id}).update({status:'POSTED',posted_by:userId,posted_at:trx.fn.now()});
  await trx('transaction_reversals').insert({original_transaction_id:originalId,reversal_transaction_id:reversal.transaction_id,reason,reversed_by:userId});
  const balances=await trx('transactions').where('status','POSTED').where('transaction_no','<=',reversal.transaction_no).select(trx.raw('coalesce(sum(amount * current_balance_effect_applied),0)::numeric as current_balance'),trx.raw('coalesce(sum(amount * net_balance_effect_applied),0)::numeric as net_balance')).first();
  await trx('transaction_balance_snapshots').insert({transaction_id:reversal.transaction_id,current_balance_after:balances?.current_balance??'0',net_balance_after:balances?.net_balance??'0'});
  await trx('audit_logs').insert({user_id:userId,action:'TRANSACTION_REVERSED',table_name:'transactions',record_id:String(originalId),old_values:{transaction_no:original.transaction_no,status:original.status},new_values:{reversal_transaction_id:reversal.transaction_id,reason}});
  return {...reversal,status:'POSTED',reversal_of_transaction_id:originalId};
 });
}
