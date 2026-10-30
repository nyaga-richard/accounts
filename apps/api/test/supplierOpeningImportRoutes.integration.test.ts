import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
vi.mock('../src/auth.js',()=>({auth:{api:{getSession:vi.fn()}}}));
const [{openingBalancesApi},{db}]=await Promise.all([import('../src/routes/openingBalances.js'),import('../src/db.js')]);
const databaseAvailable=Boolean(process.env.TEST_DATABASE_URL||process.env.DATABASE_URL);

describe('supplier spreadsheet import API',()=>{
  let server:Server;let origin='';let userId=0;let debitId=0;let creditId=0;const tag=`SUPROUTE${Date.now()}`;
  beforeAll(async()=>{
    const app=express();
    app.use('/api',(req,_res,next)=>{req.appUser={userId:userId||1,authUserId:'supplier-import-test',name:'Import Test',email:'import-test@example.invalid',permissions:new Set(['opening_balances.prepare','suppliers.write','transaction_types.write','opening_balances.read','opening_balances.approve'])};next()});
    app.use('/api',openingBalancesApi);
    app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(Number(error.status)||500).json({error:error.expose?error.message:'Internal server error',...(error.details?{details:error.details}:{})}));
    server=app.listen(0,'127.0.0.1');await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});const address=server.address();if(!address||typeof address==='string')throw new Error('Could not bind test server');origin=`http://127.0.0.1:${address.port}`;
    if(databaseAvailable){const user=await db('users').where({status:'ACTIVE'}).first();if(!user)throw new Error('TEST_DATABASE_URL must point at a migrated and seeded database');userId=Number(user.user_id);const [debit]=await db('accounts').insert({account_no:`${tag}-D`,account_name:`${tag} debit`,account_type:'ASSET',account_nature:'DEBIT',currency:'KES'}).returning('*');const [credit]=await db('accounts').insert({account_no:`${tag}-C`,account_name:`${tag} credit`,account_type:'EQUITY',account_nature:'CREDIT',currency:'KES'}).returning('*');debitId=Number(debit.account_id);creditId=Number(credit.account_id)}
  });
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));if(databaseAvailable)await db.destroy()});
  function fileForm(){const form=new FormData();form.append('file',new Blob([`Name,Code,Opening Balance\n${tag} Route Supplier,${tag}-SUP-1,123.45\n`],{type:'text/csv'}),'suppliers.csv');return form}
  it('previews multipart CSV data and returns normalized values before writing',async()=>{
    const response=await fetch(`${origin}/api/opening-balance-batches/import-preview`,{method:'POST',body:fileForm()});expect(response.status).toBe(200);const body=await response.json();expect(body.valid_rows).toBe(1);expect(body.rows[0]).toMatchObject({supplier_name:`${tag} Route Supplier`,supplier_code:`${tag}-SUP-1`,amount:'123.4500'});
  });
  it.skipIf(!databaseAvailable)('prepares a pending batch and creates the supplier on multipart commit',async()=>{
    const form=fileForm();form.append('effective_date','2000-01-01');form.append('description',`${tag} supplier import`);form.append('accounts',JSON.stringify([{entity_id:debitId,debit_amount:'10',credit_amount:'0'},{entity_id:creditId,debit_amount:'0',credit_amount:'10'}]));
    const response=await fetch(`${origin}/api/opening-balance-batches/import`,{method:'POST',body:form});expect(response.status).toBe(201);const body=await response.json();expect(body.batch.status).toBe('PENDING');expect(body.suppliers_created).toBe(1);expect(body.opening_balances_imported).toBe(1);expect(body.auto_accounts.some((account:any)=>account.account_no.startsWith('SUP-AP-CTRL'))).toBe(true);expect(body.auto_accounts.some((account:any)=>account.account_no.startsWith('OPENING-CLEARING'))).toBe(true);
    expect(await db('suppliers').where({supplier_code:`${tag}-SUP-1`}).first()).toBeTruthy();
  });
});
