import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { db } from '../db.js';
import { requirePermission } from '../middleware/authz.js';
import { approveOpeningBalanceBatch, createOpeningBalanceBatch, getOpeningBalanceBatch, listOpeningBalanceBatches, rejectOpeningBalanceBatch } from '../services/openingBalanceService.js';
import { createSupplierOpeningImportBatch, parseSupplierOpeningFile } from '../services/supplierOpeningImportService.js';

export const openingBalancesApi = Router();
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status, expose: true });
const wrap = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => { void handler(req, res).catch(next); };
function currentUserId(req: Request): number {
  if (!req.appUser) throw fail('Authentication required', 401);
  return req.appUser.userId;
}
const amount = z.string().regex(/^-?(0|[1-9]\d{0,14})(?:\.\d{1,4})?$/);
const accountLine = z.object({ entity_id: z.coerce.number().int().positive(), debit_amount: amount.default('0'), credit_amount: amount.default('0') });
const subledgerLine = z.object({ entity_id: z.coerce.number().int().positive(), amount });
const batchSchema = z.object({
  effective_date: z.string().date(), description: z.string().trim().min(3).max(500),
  accounts: z.array(accountLine).max(1000).default([]), suppliers: z.array(subledgerLine).max(5000).default([]),
  customers: z.array(subledgerLine).max(5000).default([]), cashiers: z.array(subledgerLine).max(5000).default([]),
});
const supplierFile=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024},fileFilter:(_req,file,cb)=>cb(null,/\.(xlsx|csv)$/i.test(file.originalname))});
const supplierFileUpload:RequestHandler=(req,res,next)=>supplierFile.single('file')(req,res,error=>{
  if(!error){next();return;}
  if(error instanceof multer.MulterError){const tooLarge=error.code==='LIMIT_FILE_SIZE';next(Object.assign(new Error(tooLarge?'Supplier file exceeds the 10 MB limit':error.message),{status:tooLarge?413:400,expose:true}));return;}
  next(error);
});

openingBalancesApi.post('/opening-balance-batches/import-preview',requirePermission('opening_balances.prepare'),supplierFileUpload,wrap(async(req,res)=>{
  if(!req.file)throw fail('Upload an .xlsx or .csv supplier file using field name "file"',400);
  const parsed=await parseSupplierOpeningFile(req.file.buffer,req.file.originalname);
  res.json({file_name:req.file.originalname,total_rows:parsed.total_rows,valid_rows:parsed.rows.length,blank_rows:parsed.blank_rows,headers:parsed.headers,errors:parsed.errors,rows:parsed.rows.slice(0,200)});
}));
openingBalancesApi.post('/opening-balance-batches/import',requirePermission('opening_balances.prepare'),supplierFileUpload,wrap(async(req,res)=>{
  if(!req.file)throw fail('Upload an .xlsx or .csv supplier file using field name "file"',400);
  if(!req.appUser?.permissions.has('*')&&!req.appUser?.permissions.has('suppliers.write'))throw fail('Permission denied: suppliers.write',403);
  if(!req.appUser?.permissions.has('*')&&!req.appUser?.permissions.has('transaction_types.write'))throw fail('Permission denied: transaction_types.write',403);
  const parsed=await parseSupplierOpeningFile(req.file.buffer,req.file.originalname);
  if(parsed.errors.length)throw Object.assign(fail('Correct all file validation errors before importing',422),{details:parsed.errors});
  let accounts:unknown;try{accounts=JSON.parse(String(req.body.accounts||'[]'));}catch{throw fail('Account opening lines must be valid JSON',400);}
  const input=z.object({effective_date:z.string().date(),description:z.string().trim().min(3).max(500),accounts:z.array(accountLine).max(1000).default([])}).parse({effective_date:req.body.effective_date,description:req.body.description,accounts});
  const result=await createSupplierOpeningImportBatch(db,parsed.rows,input,currentUserId(req));
  res.status(201).json(result);
}));

openingBalancesApi.get('/opening-balance-batches', requirePermission('opening_balances.read'), wrap(async (_req, res) => res.json(await listOpeningBalanceBatches(db))));
openingBalancesApi.get('/opening-balance-batches/:id', requirePermission('opening_balances.read'), wrap(async (req, res) => res.json(await getOpeningBalanceBatch(db, Number(req.params.id)))));
openingBalancesApi.post('/opening-balance-batches', requirePermission('opening_balances.prepare'), wrap(async (req, res) => {
  const input = batchSchema.parse(req.body);
  const batch = await createOpeningBalanceBatch(db, input, currentUserId(req));
  res.status(201).json(batch);
}));
openingBalancesApi.post('/opening-balance-batches/:id/approve', requirePermission('opening_balances.approve'), wrap(async (req, res) => res.json(await approveOpeningBalanceBatch(db, Number(req.params.id), currentUserId(req)))));
openingBalancesApi.post('/opening-balance-batches/:id/reject', requirePermission('opening_balances.approve'), wrap(async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(5).max(1000) }).parse(req.body);
  res.json(await rejectOpeningBalanceBatch(db, Number(req.params.id), body.reason, currentUserId(req)));
}));
