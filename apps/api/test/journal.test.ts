import {describe,it,expect} from 'vitest';
import {resolveJournal} from '../src/services/journal.js';
const fixed={rule_id:1,debit_account_id:10,credit_account_id:20,account_selection_mode:'FIXED',amount_source:'TRANSACTION',rule_name:'Purchase'};
describe('configured journal generation',()=>{
 it('builds balanced fixed-account journal lines',()=>expect(resolveJournal([fixed],'125.50')).toEqual([{account_id:10,debit_amount:'125.5000',credit_amount:'0.0000',narration:'Purchase',party_entity_line:false},{account_id:20,debit_amount:'0.0000',credit_amount:'125.5000',narration:'Purchase',party_entity_line:false}]));
 it('negative amounts reverse debit and credit sides',()=>expect(resolveJournal([fixed],'-7.25').map(p=>[p.debit_amount,p.credit_amount])).toEqual([['0.0000','7.2500'],['7.2500','0.0000']]));
 it('links a party only to the explicitly designated control-account side even when signed amount reverses',()=>{const result=resolveJournal([{...fixed,party_account_side:'CREDIT'}],'-25');expect(result.map(p=>[p.account_id,p.party_entity_line])).toEqual([[10,false],[20,true]]);});
 it('requires complete rule configuration and rejects ambiguous multi-rule setup',()=>{expect(()=>resolveJournal([],'5')).toThrow(/No active posting rule/);expect(()=>resolveJournal([fixed,{...fixed,rule_id:2}],'5')).toThrow(/multiple active/);});
 it('does not permit an account to debit and credit itself',()=>expect(()=>resolveJournal([{...fixed,credit_account_id:10}],'1')).toThrow(/different accounts/));
 it('requires selected account for USER_SELECTED rule',()=>expect(()=>resolveJournal([{...fixed,account_selection_mode:'USER_SELECTED',credit_account_id:null}],'1')).toThrow(/Select an account/));
 it('rejects unsupported precision and zero amounts',()=>{expect(()=>resolveJournal([fixed],'1.00001')).toThrow(/at most four/);expect(()=>resolveJournal([fixed],'0')).toThrow(/must not be zero/)});
});
