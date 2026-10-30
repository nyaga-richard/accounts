import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requirePermission } from '../middleware/authz.js';
import { getChequeDetail, listCheques } from '../services/chequeRegisterService.js';
export const chequesApi = Router();
const wrap = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => { void handler(req, res).catch(next); };
chequesApi.get('/cheques', requirePermission('cheques.read'), wrap(async (req, res) => {
  const filters = z.object({ q: z.string().max(160).optional(), status: z.string().max(40).optional(), direction: z.enum(['ISSUED','RECEIVED']).optional(), from: z.string().date().optional(), to: z.string().date().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
  res.json(await listCheques(db, filters));
}));
chequesApi.get('/cheques/:id', requirePermission('cheques.read'), wrap(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  res.json(await getChequeDetail(db, id));
}));
