import ExcelJS from 'exceljs';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import type {Knex} from 'knex';
import {extractRemarkFields} from './remarkExtraction.js';

export type BankRow={import_row_number:number;posting_date:string;value_date:string|null;original_remarks:string;debit:string;credit:string;running_balance:string|null;bank_reference_number:string|null};
export type ParseResult={rows:BankRow[];errors:{row:number;field:string;message:string}[];blank_rows:number[];headers:string[];file_hash:string};
const fail=(message:string,status=422)=>Object.assign(new Error(message),{status,expose:true});
function dateValue(value:unknown):string|null{
 if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);
 if(typeof value==='number'&&Number.isFinite(value)){const d=new Date(Date.UTC(1899,11,30)+Math.round(value)*86400000);return d.toISOString().slice(0,10);}
 if(typeof value==='string'){const s=value.trim();const m=s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);if(m){const day=Number(m[1]),month=Number(m[2]),year=Number(m[3]);const d=new Date(Date.UTC(year,month-1,day));if(d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day)return d.toISOString().slice(0,10);return null;}const d=new Date(s);if(!Number.isNaN(d.getTime()))return d.toISOString().slice(0,10);}
 return null;
}
function cellText(cell:ExcelJS.Cell):string{if(cell.value===null||cell.value===undefined)return '';if(typeof cell.value==='object'&&'text' in cell.value)return String((cell.value as {text:unknown}).text??'');return cell.text||String(cell.value);}
function amountValue(value:unknown,allowNegative:boolean):string|null{
 if(value===null||value===undefined||value==='')return '0.0000';const s=typeof value==='number'?String(value):String(value).trim().replaceAll(',','');if(!/^-?\d{1,15}(\.\d{1,4})?$/.test(s)||(!allowNegative&&s.startsWith('-')))return null;
 const neg=s.startsWith('-');const [whole,frac='']=s.replace('-','').split('.');const units=BigInt(whole)*10000n+BigInt(frac.padEnd(4,'0'));if(neg&&units===0n)return '0.0000';return `${neg?'-':''}${units/10000n}.${String(units%10000n).padStart(4,'0')}`;
}
export async function parseBankWorkbook(buffer:Buffer):Promise<ParseResult>{
 const file_hash=createHash('sha256').update(buffer).digest('hex');const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer as any);const sheet=workbook.worksheets[0];if(!sheet)throw fail('Workbook contains no worksheet');
 const first=sheet.getRow(1);const headers=Array.from({length:7},(_,i)=>cellText(first.getCell(i+1)));const normalized=headers.map(v=>v.trim().toLowerCase());const hasHeader=normalized[0]?.includes('posting date')&&normalized[2]?.includes('remark')&&normalized[6]?.includes('ref');const start=hasHeader?2:1;
 const rows:BankRow[]=[],errors:ParseResult['errors']=[],blank_rows:number[]=[];
 for(let rn=start;rn<=sheet.rowCount;rn++){
  const cells=Array.from({length:7},(_,i)=>sheet.getRow(rn).getCell(i+1));if(cells.every(c=>c.value===null||c.value===undefined||c.value==='')){blank_rows.push(rn);continue;}
  const posting=dateValue(cells[0]?.value),value=dateValue(cells[1]?.value),remarks=cellText(cells[2]!),debit=amountValue(cells[3]?.value,false),credit=amountValue(cells[4]?.value,false),balance=amountValue(cells[5]?.value,true),ref=cellText(cells[6]!);
  if(!posting)errors.push({row:rn,field:'Posting Date',message:'Missing or invalid date'});if(cells[1]?.value!==null&&cells[1]?.value!==undefined&&!value)errors.push({row:rn,field:'Value Date',message:'Invalid date'});if(debit===null)errors.push({row:rn,field:'Debit',message:'Invalid amount or negative bank debit'});if(credit===null)errors.push({row:rn,field:'Credit',message:'Invalid amount or negative bank credit'});if(balance===null)errors.push({row:rn,field:'Running Balance',message:'Invalid amount'});if(debit!==null&&credit!==null&&((debit!=='0.0000'&&credit!=='0.0000')||(debit==='0.0000'&&credit==='0.0000')))errors.push({row:rn,field:'Debit/Credit',message:'Each statement row must have exactly one positive debit or credit'});
  rows.push({import_row_number:rn,posting_date:posting??'',value_date:value,original_remarks:remarks,debit:debit??'0.0000',credit:credit??'0.0000',running_balance:balance,bank_reference_number:ref===''?null:ref});
 }
 if(rows.length>25000)errors.push({row:0,field:'Worksheet',message:'Statements are limited to 25,000 transaction rows per import'});if(!rows.length)errors.push({row:0,field:'Worksheet',message:'No transaction rows found'});
 return {rows,errors,blank_rows,headers,file_hash};
}
export async function findPotentialDuplicates(db:Knex,accountId:number,rows:BankRow[]){const duplicates:{import_row_number:number;existing_entry_ids:string[]}[]=[];for(const row of rows){const query=db('bank_statement_entries as e').join('bank_statements as s','s.statement_id','e.statement_id').where('s.account_id',accountId).where('e.posting_date',row.posting_date).where('e.debit',row.debit).where('e.credit',row.credit).where('e.original_remarks',row.original_remarks);if(row.bank_reference_number===null)query.whereNull('e.bank_reference_number');else query.where('e.bank_reference_number',row.bank_reference_number);const found=await query.select('e.entry_id').limit(10);if(found.length)duplicates.push({import_row_number:row.import_row_number,existing_entry_ids:found.map(r=>String(r.entry_id))});}return duplicates;}
export async function importBankWorkbook(db:Knex,buffer:Buffer,filename:string,accountId:number,userId:number,confirmDuplicates=false,duplicateReason?:string,storageRoot=path.resolve(process.cwd(),'data')){
 const parsed=await parseBankWorkbook(buffer);if(parsed.errors.length)throw Object.assign(fail('Import contains invalid rows; correct them before importing'),{details:parsed.errors});
 if(await db('bank_statements').where({file_hash:parsed.file_hash}).first())throw fail('This exact statement file has already been imported',409);
 const account=await db('accounts').where({account_id:accountId,status:'ACTIVE'}).first();if(!account)throw fail('Selected bank account is missing or inactive');
 const possible=await findPotentialDuplicates(db,accountId,parsed.rows);if(possible.length&&(!confirmDuplicates||!duplicateReason||duplicateReason.trim().length<5))throw Object.assign(fail('Potential repeated bank rows found. Review them and provide explicit confirmation plus a reason to continue.',409),{duplicates:possible});
 const dates=parsed.rows.map(r=>r.posting_date).sort();const periodFrom=dates[0]!,periodTo=dates[dates.length-1]!;const closing=parsed.rows[parsed.rows.length-1]?.running_balance??null;const storedPath=path.join(storageRoot,'bank-statements',`${parsed.file_hash}.xlsx`);await mkdir(path.dirname(storedPath),{recursive:true});let createdFile=false;try{await writeFile(storedPath,buffer,{flag:'wx'});createdFile=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=await readFile(storedPath);if(createHash('sha256').update(existing).digest('hex')!==parsed.file_hash)throw fail('Stored file hash path contains different content',500);}
 try{
  const statement=await db.transaction(async trx=>{const [s]=await trx('bank_statements').insert({account_id:accountId,period_from:periodFrom,period_to:periodTo,opening_balance:null,closing_balance:closing,original_filename:path.basename(filename).slice(0,255),file_hash:parsed.file_hash,imported_by:userId,row_count:parsed.rows.length,status:'IMPORTED'}).returning('*');const rules=await trx('bank_remark_extraction_rules').where({enabled:true}).orderBy('priority');const categories=(await trx('bank_transaction_categories').where({status:'ACTIVE'}).select('category_name')).map(c=>String(c.category_name));for(let i=0;i<parsed.rows.length;i+=500){const inserted=await trx('bank_statement_entries').insert(parsed.rows.slice(i,i+500).map(row=>({...row,statement_id:s.statement_id,processing_status:'UNMATCHED'}))).returning(['entry_id','original_remarks','bank_reference_number']);const extractions=inserted.flatMap(entry=>extractRemarkFields(entry.original_remarks,entry.bank_reference_number,rules,categories).map(field=>({...field,entry_id:entry.entry_id,matched_entity_type:null,matched_entity_id:null,extraction_method:field.extraction_method,review_status:'PENDING'})));if(extractions.length)await trx('bank_remark_extractions').insert(extractions);}await trx('audit_logs').insert({user_id:userId,action:'BANK_STATEMENT_IMPORTED',table_name:'bank_statements',record_id:String(s.statement_id),new_values:{statement_id:s.statement_id,file_hash:parsed.file_hash,row_count:parsed.rows.length,account_id:accountId},...(possible.length?{old_values:{potential_duplicates:possible,confirmation_reason:duplicateReason}}:{})});return s;});
  return {statement,file_path:storedPath,duplicate_warnings:possible};
 }catch(error){if(createdFile)await unlink(storedPath).catch(()=>{});throw error;}
}
