import type { Knex } from 'knex';
import {resolveJournal} from './journal.js';

export type NewTransaction = {
  transaction_date:string; transaction_type_id:number; particulars_type?:'SUPPLIER'|'CUSTOMER'|'CASHIER'|'OTHER_PARTY'|null;
  particulars_id?:number|null; reference?:string|null; description?:string|null; account_id?:number|null;
  amount:string|number; entered_by:number;
  cheque?:{cheque_number:string;cheque_date:string;direction:'ISSUED'|'RECEIVED';payee_payer?:string;account_id?:number;bank_reference?:string;remarks?:string};
};
const fail=(message:string,status=422)=>Object.assign(new Error(message),{status,expose:true});

/** Atomic transaction registration, rule-based journal generation and immutable sequence-order balance snapshot. */
export async function createPostedTransaction(db:Knex,input:NewTransaction) {
  return db.transaction(async trx => {
    // Serialize posting critical sections so snapshots follow allocated transaction-number order.
    await trx.raw('SELECT pg_advisory_xact_lock(7224103901)');
    const type=await trx('transaction_types').where({transaction_type_id:input.transaction_type_id,status:'ACTIVE'}).first();
    if(!type) throw fail('Transaction type is missing or inactive');
    if(type.requires_reference&&!input.reference?.trim()) throw fail('A reference is required for this transaction type');
    if(type.requires_cheque&&!input.cheque) throw fail('Cheque details are required for this transaction type');
    if(input.cheque&&!type.permits_cheque) throw fail('This transaction type does not permit cheque details');
    if(type.requires_approval) throw fail('This transaction type requires an approval workflow that is not enabled yet',409);
    const amount=String(input.amount);
    if(!/^-?\d{1,15}(\.\d{1,4})?$/.test(amount)) throw fail('Amount must fit NUMERIC(19,4), be non-zero and have at most four decimal places');
    const particular=input.particulars_type;
    if(type.affects_supplier&&particular!=='SUPPLIER') throw fail('Select a supplier for this transaction type');
    if(type.affects_customer&&particular!=='CUSTOMER') throw fail('Select a customer for this transaction type');
    if(type.affects_cashier&&particular!=='CASHIER') throw fail('Select a cashier for this transaction type');
    if(particular==='SUPPLIER'&&!type.affects_supplier)throw fail('This transaction type is not configured to post to supplier ledgers');
    if(particular==='CUSTOMER'&&!type.affects_customer)throw fail('This transaction type is not configured to post to customer ledgers');
    if(particular==='CASHIER'&&!type.affects_cashier)throw fail('This transaction type is not configured to post to cashier records');
    if(particular&&!input.particulars_id) throw fail('A particulars record must be selected');
    if(particular&&input.particulars_id){
      const table=({SUPPLIER:'suppliers',CUSTOMER:'customers',CASHIER:'cashiers',OTHER_PARTY:'other_parties'} as const)[particular];
      const key=({SUPPLIER:'supplier_id',CUSTOMER:'customer_id',CASHIER:'cashier_id',OTHER_PARTY:'party_id'} as const)[particular];
      const entity=await trx(table).where({[key]:input.particulars_id,status:'ACTIVE'}).first();
      if(!entity) throw fail(`${particular.replace('_',' ').toLowerCase()} is missing or inactive`);
    }
    const closedPeriod=await trx('accounting_periods').where('status','CLOSED').where('start_date','<=',input.transaction_date).where('end_date','>=',input.transaction_date).first();
    if(closedPeriod) throw fail('Transaction date falls within a closed accounting period',409);
    const closedWeek=await trx('weekly_closings').whereIn('status',['CLOSED','APPROVED']).where('week_start_date','<=',input.transaction_date).where('week_end_date','>=',input.transaction_date).first();
    if(closedWeek) throw fail('Transaction date falls within a closed week; an authorized user must reopen it first',409);
    const openingCutoff=await trx('opening_balance_batches').where({status:'APPROVED'}).where('effective_date','>',input.transaction_date).first();
    if(openingCutoff) throw fail('Transaction date predates an approved opening balance cutover',409);

    if(input.account_id){const selected=await trx('accounts').where({account_id:input.account_id,status:'ACTIVE'}).first();if(!selected)throw fail('Selected account is missing or inactive');}
    const rules=await trx('transaction_type_rules').where({transaction_type_id:input.transaction_type_id,status:'ACTIVE',is_required:true}).orderBy('priority');
    const journal=resolveJournal(rules.map(r=>({rule_id:Number(r.rule_id),debit_account_id:r.debit_account_id===null?null:Number(r.debit_account_id),credit_account_id:r.credit_account_id===null?null:Number(r.credit_account_id),account_selection_mode:r.account_selection_mode,amount_source:r.amount_source,rule_name:r.rule_name,party_account_side:r.party_account_side})),amount,input.account_id);
    const hasDebit=journal.some(p=>p.debit_amount!=='0.0000'),hasCredit=journal.some(p=>p.credit_amount!=='0.0000');
    if(!hasDebit||!hasCredit) throw fail('Configured journal did not resolve to a balanced debit and credit');
    if(particular&&!journal.some(p=>p.party_entity_line))throw fail('Posting rule must identify which debit or credit line carries the selected party');
    const postingAccountIds=[...new Set(journal.map(p=>p.account_id))];
    const activeAccounts=await trx('accounts').whereIn('account_id',postingAccountIds).where({status:'ACTIVE'}).pluck('account_id');
    if(activeAccounts.length!==postingAccountIds.length)throw fail('One or more configured posting accounts are missing or inactive');
    const entityLink={supplier_id:particular==='SUPPLIER'?input.particulars_id:null,customer_id:particular==='CUSTOMER'?input.particulars_id:null,cashier_id:particular==='CASHIER'?input.particulars_id:null,party_id:particular==='OTHER_PARTY'?input.particulars_id:null};
    const [row]=await trx('transactions').insert({transaction_date:input.transaction_date,transaction_type_id:input.transaction_type_id,particulars_type:particular??null,particulars_id:input.particulars_id??null,reference:input.reference??null,description:input.description??null,account_id:input.account_id??null,amount,current_balance_effect_applied:type.current_balance_effect,net_balance_effect_applied:type.net_balance_effect,entered_by:input.entered_by,status:'DRAFT'}).returning(['transaction_id','transaction_no','transaction_date','amount','current_balance_effect_applied','net_balance_effect_applied']);
    await trx('transaction_postings').insert(journal.map(({party_entity_line,...p})=>({...p,...(party_entity_line?entityLink:{supplier_id:null,customer_id:null,cashier_id:null,party_id:null}),transaction_id:row.transaction_id})));
    if(input.cheque){
      const chequeAmount=amount.startsWith('-')?amount.slice(1):amount;
      const cheque= input.cheque;
      if(cheque.account_id){const exists=await trx('accounts').where({account_id:cheque.account_id,status:'ACTIVE'}).first();if(!exists)throw fail('Cheque account is missing or inactive');}
      await trx('cheques').insert({transaction_id:row.transaction_id,cheque_number:cheque.cheque_number,cheque_date:cheque.cheque_date,payee_payer:cheque.payee_payer??null,account_id:cheque.account_id??input.account_id??null,direction:cheque.direction,amount:chequeAmount,cheque_status:'PREPARED',bank_reference:cheque.bank_reference??null,remarks:cheque.remarks??null,created_by:input.entered_by});
    }
    await trx('transactions').where({transaction_id:row.transaction_id}).update({status:'POSTED',posted_by:input.entered_by,posted_at:trx.fn.now()});
    const balances=await trx('transactions').where('status','POSTED').where('transaction_no','<=',row.transaction_no).select(trx.raw('coalesce(sum(amount * current_balance_effect_applied),0)::numeric as current_balance'),trx.raw('coalesce(sum(amount * net_balance_effect_applied),0)::numeric as net_balance')).first();
    await trx('transaction_balance_snapshots').insert({transaction_id:row.transaction_id,current_balance_after:balances?.current_balance??'0',net_balance_after:balances?.net_balance??'0'});
    await trx('audit_logs').insert({user_id:input.entered_by,action:'TRANSACTION_POSTED',table_name:'transactions',record_id:String(row.transaction_id),new_values:{...row,status:'POSTED'}});
    return {...row,status:'POSTED'};
  });
}
