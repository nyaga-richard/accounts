import type {NextFunction,Request,Response} from 'express';
import {fromNodeHeaders} from 'better-auth/node';
import {auth} from '../auth.js';
import {db} from '../db.js';

declare global { namespace Express { interface Request { appUser?:{userId:number;authUserId:string;name:string;email:string;permissions:Set<string>} } } }
export async function requireAuth(req:Request,res:Response,next:NextFunction){
  try{
    const session=await auth.api.getSession({headers:fromNodeHeaders(req.headers)});
    if(!session){res.status(401).json({error:'Authentication required'});return;}
    const user=await db('users').where({auth_user_id:session.user.id,status:'ACTIVE'}).first();
    if(!user){res.status(403).json({error:'Account is not provisioned for this application'});return;}
    const rows=await db('user_roles as ur').join('role_permissions as rp','rp.role_id','ur.role_id').join('permissions as p','p.permission_id','rp.permission_id').where('ur.user_id',user.user_id).select('p.code');
    req.appUser={userId:Number(user.user_id),authUserId:session.user.id,name:user.name,email:user.email,permissions:new Set(rows.map(r=>r.code))};
    next();
  }catch(error){next(error);}
}
export function requirePermission(permission:string){return (req:Request,res:Response,next:NextFunction)=>{if(!req.appUser){res.status(401).json({error:'Authentication required'});return;}if(!req.appUser.permissions.has('*')&&!req.appUser.permissions.has(permission)){res.status(403).json({error:`Permission denied: ${permission}`});return;}next();};}
