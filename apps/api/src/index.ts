import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import {toNodeHandler} from 'better-auth/node';
import {db} from './db.js';
import {auth} from './auth.js';
import {ZodError} from 'zod';
import {api} from './routes/api.js';

const app=express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({origin:process.env.WEB_ORIGIN?.split(',')||true,credentials:true}));
// Better Auth must receive the request stream before JSON middleware consumes it.
app.all('/api/auth/*',toNodeHandler(auth));
app.use(express.json({limit:'2mb'}));
app.get('/health',async(_req,res)=>{try{await db.raw('select 1');res.json({status:'ok',database:'connected'});}catch{res.status(503).json({status:'degraded',database:'unavailable'});}});
app.use('/api',api);
app.use((err:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{if(err instanceof ZodError){res.status(400).json({error:'Request validation failed',details:err.issues.map(i=>({path:i.path.join('.'),message:i.message}))});return;}console.error(err);const status=Number(err?.status)||500;const payload:any={error:err?.expose?err.message:status===400?'Invalid request':'Internal server error'};if(err?.expose&&err.details)payload.details=err.details;if(err?.expose&&err.duplicates)payload.duplicates=err.duplicates;res.status(status).json(payload);});
const port=Number(process.env.PORT||4000);
app.listen(port,'0.0.0.0',()=>console.log(`Ledgerway API listening on ${port}`));
