import { Router, type Request, type RequestHandler, type Response } from 'express';
import { db } from '../db.js';
import { requirePermission } from '../middleware/authz.js';
export const coreApi=Router();
type AuthenticatedRequest=Request&{appUser:NonNullable<Request['appUser']>};
const wrap=(fn:(req:AuthenticatedRequest,res:Response)=>Promise<unknown>):RequestHandler=>(req,res,next)=>{void Promise.resolve(fn(req as AuthenticatedRequest,res)).catch(next)};
coreApi.get('/me',wrap(async(req,res)=>res.json({userId:req.appUser.userId,name:req.appUser.name,email:req.appUser.email,permissions:[...req.appUser.permissions]})));
coreApi.get('/dashboard',requirePermission('dashboard.read'),wrap(async(_req,res)=>{
  const [suppliers,customers,accounts,transactions,cheques,unmatched,balances]=await Promise.all([
    db('suppliers').where({status:'ACTIVE'}).count('* as n').first(),db('customers').where({status:'ACTIVE'}).count('* as n').first(),db('accounts').where({status:'ACTIVE'}).count('* as n').first(),db('transactions').where({status:'POSTED'}).count('* as n').first(),db('cheques').whereIn('cheque_status',['ISSUED','DEPOSITED','PREPARED']).count('* as n').first(),db('bank_statement_entries').where('processing_status','UNMATCHED').count('* as n').first(),db('transactions').where({status:'POSTED'}).select(db.raw('coalesce(sum(amount * current_balance_effect_applied),0)::numeric as current_balance'),db.raw('coalesce(sum(amount * net_balance_effect_applied),0)::numeric as net_balance')).first()
  ]);
  res.json({suppliers:Number(suppliers?.n||0),customers:Number(customers?.n||0),accounts:Number(accounts?.n||0),transactions:Number(transactions?.n||0),outstandingCheques:Number(cheques?.n||0),unmatchedBankEntries:Number(unmatched?.n||0),currentBalance:String(balances?.current_balance||'0'),netBalance:String(balances?.net_balance||'0')});
}));
coreApi.get('/suppliers',requirePermission('suppliers.read'),wrap(async(req,res)=>{const q=String(req.query.q||'').trim();res.json(await db('suppliers').where({status:'ACTIVE'}).andWhere(b=>b.whereILike('supplier_name',`%${q}%`).orWhereILike('supplier_code',`%${q}%`).orWhereILike('phone',`%${q}%`).orWhereILike('tax_pin',`%${q}%`)).orderBy('supplier_name').limit(100))}));
