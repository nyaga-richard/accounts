import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { createPostedTransaction } from '../src/services/transactionService.js';
import { approveBankReconciliation, confirmBankMatch, getBankMatchCandidates, getBankReconciliationDetail, prepareBankReconciliation } from '../src/services/bankReconciliationService.js';
const enabled=Boolean(process.env.TEST_DATABASE_URL||process.env.DATABASE_URL);
describe.skipIf(!enabled)('PostgreSQL manual bank reconciliation integration',()=>{
  let userId:number,bankId:number,depositType:number,paymentType:number,statementId:number,recId:number;let depositPostingId:number,paymentPostingId:number;const tag=`BR${Date.now()}`;
  beforeAll(async()=>{
    const user=await db('users').where({status:'ACTIVE'}).first();if(!user)throw new Error('TEST_DATABASE_URL must point at a migrated and seeded test database');userId=Number(user.user_id);
    const [bank]=await db('accounts').insert({account_no:`${tag}-BANK`,account_name:`${tag} Bank`,account_type:'ASSET',account_nature:'DEBIT',currency:'KES',reconciliation_enabled:true}).returning('*');bankId=Number(bank.account_id);
    const [income]=await db('accounts').insert({account_no:`${tag}-INC`,account_name:`${tag} income`,account_type:'REVENUE',account_nature:'CREDIT'}).returning('*');
    const [expense]=await db('accounts').insert({account_no:`${tag}-EXP`,account_name:`${tag} expense`,account_type:'EXPENSE',account_nature:'DEBIT'}).returning('*');
    const [deposit]=await db('transaction_types').insert({code:`${tag}-DEP`,name:`${tag} deposit`,current_balance_effect:0,net_balance_effect:0,created_by:userId}).returning('*');depositType=Number(deposit.transaction_type_id);
    const [payment]=await db('transaction_types').insert({code:`${tag}-PAY`,name:`${tag} payment`,current_balance_effect:0,net_balance_effect:0,created_by:userId}).returning('*');paymentType=Number(payment.transaction_type_id);
    await db('transaction_type_rules').insert([
      {transaction_type_id:depositType,rule_name:'Bank receipt',debit_account_id:bankId,credit_account_id:Number(income.account_id),account_selection_mode:'FIXED',amount_source:'TRANSACTION',party_account_side:'NONE',is_required:true,status:'ACTIVE'},
      {transaction_type_id:paymentType,rule_name:'Bank payment',debit_account_id:Number(expense.account_id),credit_account_id:bankId,account_selection_mode:'FIXED',amount_source:'TRANSACTION',party_account_side:'NONE',is_required:true,status:'ACTIVE'},
    ]);
    const incoming=await createPostedTransaction(db,{transaction_date:'2026-10-10',transaction_type_id:depositType,amount:'100.00',entered_by:userId,reference:`${tag}-DEP`});
    const outgoing=await createPostedTransaction(db,{transaction_date:'2026-10-11',transaction_type_id:paymentType,amount:'40.00',entered_by:userId,reference:`${tag}-PAY`});
    depositPostingId=Number((await db('transaction_postings').where({transaction_id:incoming.transaction_id,account_id:bankId}).first()).posting_id);
    paymentPostingId=Number((await db('transaction_postings').where({transaction_id:outgoing.transaction_id,account_id:bankId}).first()).posting_id);
    const [statement]=await db('bank_statements').insert({account_id:bankId,period_from:'2026-10-01',period_to:'2026-10-31',opening_balance:'0',closing_balance:'60',original_filename:`${tag}.xlsx`,file_hash:`${tag}-hash`,imported_by:userId,row_count:2,status:'IMPORTED'}).returning('*');statementId=Number(statement.statement_id);
    await db('bank_statement_entries').insert([
      {statement_id:statementId,import_row_number:1,posting_date:'2026-10-10',value_date:'2026-10-10',original_remarks:'Credit from partner',debit:'0',credit:'100',running_balance:'100',bank_reference_number:'DUPLICATED-REF',processing_status:'UNMATCHED'},
      {statement_id:statementId,import_row_number:2,posting_date:'2026-10-11',value_date:'2026-10-11',original_remarks:'Payment to vendor',debit:'40',credit:'0',running_balance:'60',bank_reference_number:'DUPLICATED-REF',processing_status:'UNMATCHED'},
    ]);
  },30000);
  afterAll(async()=>{await db.destroy()});
  it('suggests but never auto-matches references, supports both directions, and approves only a zero-difference statement',async()=>{
    const prepared=await prepareBankReconciliation(db,statementId,userId);recId=Number(prepared.reconciliation.reconciliation_id);expect(prepared.resumed).toBe(false);
    const entries=await db('bank_statement_entries').where({statement_id:statementId}).orderBy('import_row_number');
    const candidatesIn=await getBankMatchCandidates(db,recId,Number(entries[0].entry_id));expect(candidatesIn.candidates.some(c=>Number(c.posting_id)===depositPostingId&&c.exact_amount_available)).toBe(true);expect(candidatesIn.note).toMatch(/Suggestions only/);
    await expect(confirmBankMatch(db,recId,Number(entries[0].entry_id),[{posting_id:depositPostingId,allocated_amount:'99.99'}],undefined,userId)).rejects.toThrow(/must equal the bank entry exactly/);
    const inMatch=await confirmBankMatch(db,recId,Number(entries[0].entry_id),[{posting_id:depositPostingId,allocated_amount:'100'}],'Manually verified deposit',userId);expect(inMatch.match_status).toBe('CONFIRMED');
    const candidatesOut=await getBankMatchCandidates(db,recId,Number(entries[1].entry_id));expect(candidatesOut.candidates.some(c=>Number(c.posting_id)===paymentPostingId&&c.exact_amount_available)).toBe(true);
    await confirmBankMatch(db,recId,Number(entries[1].entry_id),[{posting_id:paymentPostingId,allocated_amount:'40.0000'}],'Manually verified payment',userId);
    const detail=await getBankReconciliationDetail(db,recId);expect(detail.entries.every(entry=>entry.processing_status==='MATCHED')).toBe(true);expect(detail.allocations).toHaveLength(2);
    const approved=await approveBankReconciliation(db,recId,userId);expect(approved.status).toBe('APPROVED');expect(String(approved.ledger_closing_balance)).toBe('60.0000');expect(String(approved.closing_difference)).toBe('0.0000');
    await expect(db('bank_reconciliation_matches').where({match_id:inMatch.match_id}).update({remarks:'tampered'})).rejects.toThrow(/immutable/);await expect(db('bank_reconciliations').where({reconciliation_id:recId}).delete()).rejects.toThrow(/Approved bank reconciliations are immutable/);
  });
});
