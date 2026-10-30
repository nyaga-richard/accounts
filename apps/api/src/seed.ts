import 'dotenv/config';
import {createAuth,authPool} from './auth.js';
import {db} from './db.js';

const email=process.env.ADMIN_EMAIL?.trim().toLowerCase(),password=process.env.ADMIN_PASSWORD,name=process.env.ADMIN_NAME||'System Administrator';
if(!email||!password||password.length<12){console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD (minimum 12 characters) before seeding.');process.exitCode=1;}else{
 try{
  if(await db('users').where({email}).first())throw new Error('An application user with this email already exists.');
  const auth=createAuth(true);
  const registered=await auth.api.signUpEmail({body:{name,email,password}});
  const authUser=(registered as any)?.user;
  if(!authUser?.id)throw new Error('Better Auth did not return a user id.');
  await db.transaction(async trx=>{
   const [user]=await trx('users').insert({auth_user_id:authUser.id,name:authUser.name,email:authUser.email}).returning('*');
   const roleNames=['Administrator','Accounts','Cashier','Viewer'];
   const roleIds:Record<string,number>={};
   for(const roleName of roleNames){const existing=await trx('roles').where({name:roleName}).first();const [role]=existing?[existing]:await trx('roles').insert({name:roleName}).returning('*');roleIds[roleName]=Number(role.role_id);}
   const codes=['*','dashboard.read','transactions.read','transactions.post','transactions.reverse','suppliers.read','suppliers.write','customers.read','customers.write','cashiers.read','cashiers.write','parties.read','parties.write','accounts.read','accounts.write','transaction_types.read','transaction_types.write','reports.read','weekly_closing.read','weekly_closing.prepare','weekly_closing.approve','weekly_closing.reopen','reconciliation.read','reconciliation.prepare','reconciliation.approve','bank_import.read','bank_import.prepare','bank_import.review','bank_import.configure','opening_balances.read','opening_balances.prepare','opening_balances.approve','cheques.read','users.manage','audit.read'];
   const pids:Record<string,number>={};
   for(const code of codes){const old=await trx('permissions').where({code}).first();const [p]=old?[old]:await trx('permissions').insert({code,description:code==='*'?'All application permissions':`Permission ${code}`}).returning('*');pids[code]=Number(p.permission_id);}
   const grants:Record<string,string[]>={Administrator:['*'],Accounts:codes.filter(c=>!['*','users.manage'].includes(c)),Cashier:['dashboard.read','transactions.read','transactions.post','transaction_types.read','suppliers.read','customers.read','cashiers.read','accounts.read','cheques.read','weekly_closing.prepare'],Viewer:['dashboard.read','transactions.read','suppliers.read','customers.read','cashiers.read','accounts.read','transaction_types.read','bank_import.read','weekly_closing.read','reconciliation.read','opening_balances.read','cheques.read','reports.read']};
   for(const [roleName,list] of Object.entries(grants)){for(const code of list){await trx('role_permissions').insert({role_id:roleIds[roleName],permission_id:pids[code]}).onConflict(['role_id','permission_id']).ignore();}}
   await trx('user_roles').insert({user_id:user.user_id,role_id:roleIds.Administrator}).onConflict(['user_id','role_id']).ignore();
   const categories=['Cash Deposit','Inward Cheque Debit','Inhouse Cheque Credit','House Cheque','Outward Cheque','Cheque Leaf Withdrawal','Cheque Leaf Withdrawal Charge','Excise Duty','Account to Account Transfer','Paybill Credit','RTGS','Principal FDR Debit'];for(const category_name of categories)await trx('bank_transaction_categories').insert({category_name,description:`Configured bank statement category: ${category_name}`,status:'ACTIVE'}).onConflict('category_name').ignore();
   if(!(await trx('bank_remark_extraction_rules').first())){const extractionRules=[['Cheque number','Cheque\\s*(?:No\\.?|Number)\\s*[:#-]?\\s*([A-Za-z0-9/-]+)','cheque_number',10],['Batch number','\\bBATCH\\s*[:#-]?\\s*([A-Za-z0-9/-]+)','batch_number',20],['Source account','\\bFrom\\s+Accno\\s*[:#-]?\\s*([A-Za-z0-9/-]+)','source_account_number',30],['Destination account','\\bTo\\s+Accno\\s*[:#-]?\\s*([A-Za-z0-9/-]+)','destination_account_number',40],['RTGS reference','\\bRTGS\\s*(?:Ref(?:erence)?|No)?\\s*[:#-]?\\s*([A-Za-z0-9/-]+)','rtgs_reference',50],['Paybill reference','\\bPaybill\\s*(?:Ref(?:erence)?|No)?\\s*[:#-]?\\s*([A-Za-z0-9/-]+)','paybill_reference',60]];for(const [rule_name,pattern,extraction_field,priority] of extractionRules)await trx('bank_remark_extraction_rules').insert({bank_identifier:'DEFAULT',rule_name,pattern,extraction_field,priority,enabled:true,created_by:user.user_id});}
   await trx('audit_logs').insert({user_id:user.user_id,action:'INITIAL_ADMIN_CREATED',table_name:'users',record_id:String(user.user_id),new_values:{email,role:'Administrator'}});
  });
  console.log(`Created initial administrator ${email}. Public sign-up remains disabled in the API service.`);
 }catch(error){console.error(error);process.exitCode=1;}finally{await db.destroy();await authPool.end();}
}
