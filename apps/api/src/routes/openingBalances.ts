import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requirePermission } from '../middleware/authz.js';
import { approveOpeningBalanceBatch, createOpeningBalanceBatch, getOpeningBalanceBatch, listOpeningBalanceBatches, rejectOpeningBalanceBatch } from '../services/openingBalanceService.js';

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
