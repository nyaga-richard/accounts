import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { db } from '../db.js';
import { requirePermission } from '../middleware/authz.js';
import { findPotentialDuplicates, importBankWorkbook, parseBankWorkbook } from '../services/bankImportService.js';
export const bankStatementsApi=Router();
type AuthenticatedRequest=Request&{appUser:NonNullable<Request['appUser']>};
const wrap=(handler:(req:AuthenticatedRequest,res:Response)=>Promise<unknown>):RequestHandler=>(req,res,next)=>{void Promise.resolve(handler(req as AuthenticatedRequest,res)).catch(next)};
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024},fileFilter:(_req,file,cb)=>cb(null,/\.xlsx$/i.test(file.originalname))});
const invalid=(message:string,status=422)=>Object.assign(new Error(message),{status,expose:true});
bankStatementsApi.post('/bank-statements/preview',requirePermission('bank_import.prepare'),upload.single('statement'),wrap(async(req,res)=>{
  if(!req.file)throw invalid('Upload an .xlsx statement file using field name "statement"',400);const accountId=Number(req.body.account_id);if(!Number.isInteger(accountId)||accountId<=0)throw invalid('A valid bank account is required',400);
  const account=await db('accounts').where({account_id:accountId,status:'ACTIVE'}).first();if(!account)throw invalid('Selected account is missing or inactive');const parsed=await parseBankWorkbook(req.file.buffer);const duplicates=parsed.errors.length?[]:await findPotentialDuplicates(db,accountId,parsed.rows);
  res.json({file_name:req.file.originalname,file_hash:parsed.file_hash,columns:['Posting Date','Value Date','Remarks','Debit','Credit','Running Balance','Ref Number'],row_count:parsed.rows.length,blank_rows:parsed.blank_rows,errors:parsed.errors,possible_duplicates:duplicates,rows:parsed.rows.slice(0,100)});
}));
bankStatementsApi.post('/bank-statements/import',requirePermission('bank_import.prepare'),upload.single('statement'),wrap(async(req,res)=>{
  if(!req.file)throw invalid('Upload an .xlsx statement file using field name "statement"',400);const accountId=Number(req.body.account_id);if(!Number.isInteger(accountId)||accountId<=0)throw invalid('A valid bank account is required',400);
  const confirmed=req.body.confirm_duplicates==='true';const result=await importBankWorkbook(db,req.file.buffer,req.file.originalname,accountId,req.appUser.userId,confirmed,req.body.duplicate_reason,process.env.STORAGE_DIR||undefined);res.status(201).json(result);
}));
bankStatementsApi.get('/bank-statements',requirePermission('bank_import.read'),wrap(async(_req,res)=>{
  const rows=await db('bank_statements as s').join('accounts as a','a.account_id','s.account_id').select('s.*','a.account_no','a.account_name').orderBy('s.imported_at','desc').limit(200);res.json(rows);
}));
bankStatementsApi.get('/bank-statements/:id/entries',requirePermission('bank_import.read'),wrap(async(req,res)=>{
  const id=Number(req.params.id),statement=await db('bank_statements').where({statement_id:id}).first();if(!statement)throw invalid('Statement not found',404);const rows=await db('bank_statement_entries').where({statement_id:id}).orderBy('import_row_number');res.json({statement,entries:rows});
}));
bankStatementsApi.get('/bank-remark-review',requirePermission('bank_import.review'),wrap(async(req,res)=>{
  const status=String(req.query.status||'PENDING'),limit=Math.min(Math.max(Number(req.query.limit)||100,1),500);const rows=await db('bank_remark_extractions as x').join('bank_statement_entries as e','e.entry_id','x.entry_id').join('bank_statements as s','s.statement_id','e.statement_id').select('x.*','e.original_remarks','e.posting_date','e.debit','e.credit','e.bank_reference_number','s.original_filename','s.account_id').where('x.review_status',status).orderBy('e.posting_date').orderBy('e.import_row_number').limit(limit);res.json(rows);
}));
bankStatementsApi.patch('/bank-remark-extractions/:id',requirePermission('bank_import.review'),wrap(async(req,res)=>{
  const schema=z.object({extracted_value:z.string().max(1000),matched_entity_type:z.enum(['SUPPLIER','CUSTOMER','OTHER_PARTY']).nullable().optional(),matched_entity_id:z.coerce.number().int().positive().nullable().optional(),review_status:z.enum(['CONFIRMED','REJECTED']),reason:z.string().trim().min(3).max(500)});const body=schema.parse(req.body);if((body.matched_entity_type&&!body.matched_entity_id)||(!body.matched_entity_type&&body.matched_entity_id))throw invalid('Entity type and entity id must be supplied together');
  const updated=await db.transaction(async trx=>{const old=await trx('bank_remark_extractions').where({extraction_id:req.params.id}).first();if(!old)throw invalid('Extraction record not found',404);
    if(body.matched_entity_type&&body.matched_entity_id){const table=body.matched_entity_type==='SUPPLIER'?'suppliers':body.matched_entity_type==='CUSTOMER'?'customers':'other_parties',key=body.matched_entity_type==='SUPPLIER'?'supplier_id':body.matched_entity_type==='CUSTOMER'?'customer_id':'party_id';if(!await trx(table).where({[key]:body.matched_entity_id,status:'ACTIVE'}).first())throw invalid('Selected entity is missing or inactive');}
    const patch={extracted_value:body.extracted_value,matched_entity_type:body.matched_entity_type??null,matched_entity_id:body.matched_entity_id??null,review_status:body.review_status,reviewed_by:req.appUser.userId,reviewed_at:trx.fn.now()};const [row]=await trx('bank_remark_extractions').where({extraction_id:req.params.id}).update(patch).returning('*');await trx('bank_remark_review_logs').insert({entry_id:old.entry_id,field_name:old.field_name,previous_value:old.extracted_value,corrected_value:body.extracted_value,reviewed_by:req.appUser.userId,reason:body.reason});await trx('audit_logs').insert({user_id:req.appUser.userId,action:'BANK_REMARK_CORRECTED',table_name:'bank_remark_extractions',record_id:String(req.params.id),old_values:old,new_values:row});return row;
  });res.json(updated);
}));
const extractionField=z.enum(['transaction_category','supplier_name','customer_name','person_name','cheque_number','batch_number','source_account_number','destination_account_number','paybill_reference','payment_identifier','rtgs_reference','other_identifier']);
bankStatementsApi.get('/bank-remark-rules',requirePermission('bank_import.configure'),wrap(async(_req,res)=>res.json(await db('bank_remark_extraction_rules').orderBy('priority'))));
bankStatementsApi.post('/bank-remark-rules',requirePermission('bank_import.configure'),wrap(async(req,res)=>{
  const data=z.object({bank_identifier:z.string().max(100).default('DEFAULT'),rule_name:z.string().trim().min(1).max(200),pattern:z.string().min(1).max(300),extraction_field:extractionField,priority:z.number().int().default(100),enabled:z.boolean().default(true)}).parse(req.body);
  try{new RegExp(data.pattern,'i')}catch{throw invalid('Pattern is not a valid regular expression');}
  const [row]=await db('bank_remark_extraction_rules').insert({...data,created_by:req.appUser.userId}).returning('*');await db('audit_logs').insert({user_id:req.appUser.userId,action:'BANK_REMARK_RULE_CREATED',table_name:'bank_remark_extraction_rules',record_id:String(row.rule_id),new_values:row});res.status(201).json(row);
}));
bankStatementsApi.get('/bank-categories',requirePermission('bank_import.read'),wrap(async(_req,res)=>res.json(await db('bank_transaction_categories').orderBy('category_name'))));
bankStatementsApi.post('/bank-categories',requirePermission('bank_import.configure'),wrap(async(req,res)=>{
  const data=z.object({category_name:z.string().trim().min(1).max(160),description:z.string().max(1000).optional(),status:z.enum(['ACTIVE','INACTIVE']).default('ACTIVE')}).parse(req.body);const [row]=await db('bank_transaction_categories').insert(data).returning('*');await db('audit_logs').insert({user_id:req.appUser.userId,action:'BANK_CATEGORY_CREATED',table_name:'bank_transaction_categories',record_id:String(row.category_id),new_values:row});res.status(201).json(row);
}));
