import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
vi.mock('../src/auth.js',()=>({auth:{api:{getSession:vi.fn()}}}));
const { coreApi }=await import('../src/routes/core.js');

const databaseAvailable=Boolean(process.env.TEST_DATABASE_URL||process.env.DATABASE_URL);
describe('core API routes and permission boundaries',()=>{
  let server:Server;let origin:string;
  beforeAll(async()=>{
    const app=express();
    app.use('/api',(req,_res,next)=>{const permissions=String(req.header('x-test-permissions')||'').split(',').filter(Boolean);req.appUser={userId:73,authUserId:'route-test-user',name:'Route Test',email:'route-test@example.invalid',permissions:new Set(permissions)};next()});
    app.use('/api',coreApi);
    server=app.listen(0,'127.0.0.1');
    await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Test server did not bind a TCP port');origin=`http://127.0.0.1:${address.port}`;
  });
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))});
  it('returns the current authenticated user and permission set',async()=>{
    const response=await fetch(`${origin}/api/me`);expect(response.status).toBe(200);expect(await response.json()).toEqual({userId:73,name:'Route Test',email:'route-test@example.invalid',permissions:[]});
  });
  it('denies dashboard and supplier lookup when their permissions are absent',async()=>{
    const dashboard=await fetch(`${origin}/api/dashboard`);expect(dashboard.status).toBe(403);expect(await dashboard.json()).toEqual({error:'Permission denied: dashboard.read'});
    const suppliers=await fetch(`${origin}/api/suppliers`);expect(suppliers.status).toBe(403);expect(await suppliers.json()).toEqual({error:'Permission denied: suppliers.read'});
  });
  it.skipIf(!databaseAvailable)('returns dashboard totals and supplier search results for authorized users',async()=>{
    const dashboard=await fetch(`${origin}/api/dashboard`,{headers:{'x-test-permissions':'dashboard.read'}});expect(dashboard.status).toBe(200);const body=await dashboard.json();
    for(const field of ['suppliers','customers','accounts','transactions','outstandingCheques','unmatchedBankEntries'])expect(Number.isInteger(body[field])).toBe(true);
    expect(typeof body.currentBalance).toBe('string');expect(typeof body.netBalance).toBe('string');
    const suppliers=await fetch(`${origin}/api/suppliers?q=__route_test_no_match__`,{headers:{'x-test-permissions':'suppliers.read'}});expect(suppliers.status).toBe(200);expect(Array.isArray(await suppliers.json())).toBe(true);
  });
});
