import {betterAuth} from 'better-auth';
import {Pool} from 'pg';

export const authPool=new Pool({connectionString:process.env.DATABASE_URL||'postgres://ledgerway:ledgerway@localhost:5432/ledgerway'});
export function createAuth(allowSignUp=false){
  const secret=process.env.BETTER_AUTH_SECRET;
  if(!secret||secret.length<32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  return betterAuth({
    database:authPool,
    appName:'Ledgerway Accounting',
    baseURL:process.env.BETTER_AUTH_URL||'http://localhost:3000',
    secret,
    trustedOrigins:(process.env.WEB_ORIGIN||'http://localhost:3000').split(',').map(v=>v.trim()),
    emailAndPassword:{enabled:true,disableSignUp:!allowSignUp,minPasswordLength:12},
    session:{expiresIn:60*60*12,updateAge:60*30},
    advanced:{useSecureCookies:process.env.NODE_ENV==='production'},
  });
}
export const auth=createAuth(false);
