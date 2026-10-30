import ExcelJS from 'exceljs';
import type { Knex } from 'knex';
import { createOpeningBalanceBatch, type OpeningLine } from './openingBalanceService.js';

export type SupplierOpeningImportRow={row_number:number;supplier_code:string;supplier_name:string;amount:string};
export type SupplierOpeningParseResult={rows:SupplierOpeningImportRow[];errors:{row:number;field:string;message:string}[];blank_rows:number[];headers:string[];total_rows:number};
const fail=(message:string,status=422)=>Object.assign(new Error(message),{status,expose:true});

function csvRows(text:string):string[][]{
  const result:string[][]=[];let row:string[]=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i]!;
    if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;continue;}
    if(ch==='"'){if(field.length)throw fail('CSV contains an unexpected quote');quoted=true;}
    else if(ch===','){row.push(field);field='';}
    else if(ch==='\n'){row.push(field.replace(/\r$/,''));result.push(row);row=[];field='';}
    else field+=ch;
  }
  if(quoted)throw fail('CSV ends inside a quoted field');
  if(field.length||row.length){row.push(field.replace(/\r$/,''));result.push(row);}
  return result;
}
function cellValue(value:unknown):string{
  if(value===null||value===undefined)return '';
  if(typeof value==='object'){
    if(value instanceof Date)return Number.isNaN(value.getTime())?'#INVALID_DATE!':value.toISOString();
    const v=value as Record<string,unknown>;
    if('formula' in v&&!('result' in v))return '#FORMULA!';
    if('result' in v)return cellValue(v.result);
    if('text' in v)return cellValue(v.text);
    if('richText' in v&&Array.isArray(v.richText))return v.richText.map(x=>cellValue((x as Record<string,unknown>).text)).join('');
    return '';
  }
  return String(value).trim();
}
function headerKey(value:string){return value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function parseAmount(input:string):string|null{
  let value=input.trim();if(!value||['-','–','—'].includes(value))return '0.0000';
  let negative=false;const parenthesized=/^\(.*\)$/.test(value);if(parenthesized){negative=true;value=value.slice(1,-1).trim();}
  value=value.replace(/^(?:KES|KSHS?)\s*/i,'').replace(/\s/g,'');
  if(parenthesized&&/^[+-]/.test(value))return null;
  if(!parenthesized&&value.startsWith('-')){negative=true;value=value.slice(1);}else if(!parenthesized&&value.startsWith('+'))value=value.slice(1);
  const groupedInteger=value.split('.')[0]||'';if(groupedInteger.includes(',')&&!/^\d{1,3}(?:,\d{3})+$/.test(groupedInteger))return null;value=value.replaceAll(',','');
  const m=/^(?:(\d{1,15})(?:\.(\d{0,4}))?|\.(\d{1,4}))$/.exec(value);if(!m)return null;
  const whole=m[1]||'0',fraction=(m[2]??m[3]??'').padEnd(4,'0');const units=BigInt(whole)*10000n+BigInt(fraction||'0');
  return `${negative&&units!==0n?'-':''}${units/10000n}.${String(units%10000n).padStart(4,'0')}`;
}
function normalizedGrid(grid:string[][]){return grid.map(row=>row.map(value=>String(value??'').trim()));}

export async function parseSupplierOpeningFile(buffer:Buffer,filename:string):Promise<SupplierOpeningParseResult>{
  const extension=filename.toLowerCase().split('.').pop();let grid:string[][];
  if(extension==='csv'){
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{throw fail('CSV file must be UTF-8 encoded');}
    grid=normalizedGrid(csvRows(text.replace(/^\uFEFF/,'')));
  }else if(extension==='xlsx'){
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer as any);const sheet=workbook.worksheets[0];if(!sheet)throw fail('Workbook contains no worksheet');
    if(sheet.rowCount>5010)throw fail('Supplier file is limited to 5,000 data rows');
    grid=[];for(let r=1;r<=sheet.rowCount;r++){const line=sheet.getRow(r);const maxCol=Math.max(line.cellCount,1);grid.push(Array.from({length:maxCol},(_,c)=>cellValue(line.getCell(c+1).value)));}
  }else throw fail('Choose an .xlsx or .csv file',400);
  const headerSearchLimit=Math.min(grid.length,10);let headerIndex=-1,nameIndex=-1,codeIndex=-1,balanceIndex=-1;
  for(let r=0;r<headerSearchLimit;r++){
    const keys=grid[r]!.map(headerKey);const find=(names:string[])=>keys.findIndex(key=>names.includes(key));
    const n=find(['name','suppliername','supplier']);const c=find(['code','suppliercode']);const b=find(['openingbalance','balance','supplierbalance','openingbal']);
    if(n>=0&&c>=0&&b>=0){headerIndex=r;nameIndex=n;codeIndex=c;balanceIndex=b;break;}
  }
  if(headerIndex<0)throw fail('Required columns not found. Include headers Name, Code, and Opening Balance.');
  const headers=grid[headerIndex]||[],rows:SupplierOpeningImportRow[]=[],errors:SupplierOpeningParseResult['errors']=[],blank_rows:number[]=[],seen=new Set<string>();let totalRows=0;
  for(let i=headerIndex+1;i<grid.length;i++){
    const cells=grid[i]!;if(cells.every(value=>!value.trim())){blank_rows.push(i+1);continue;}totalRows++;
    if(totalRows>5000){errors.push({row:i+1,field:'Worksheet',message:'Supplier file is limited to 5,000 data rows'});break;}
    const name=(cells[nameIndex]||'').trim(),code=(cells[codeIndex]||'').trim(),amountText=(cells[balanceIndex]||'').trim();let invalid=false;
    if(!name){errors.push({row:i+1,field:'Name',message:'Supplier name is required'});invalid=true;}else if(name.length>200){errors.push({row:i+1,field:'Name',message:'Supplier name cannot exceed 200 characters'});invalid=true;}
    if(!code){errors.push({row:i+1,field:'Code',message:'Supplier code is required'});invalid=true;}else if(code.length>80){errors.push({row:i+1,field:'Code',message:'Supplier code cannot exceed 80 characters'});invalid=true;}
    const amount=parseAmount(amountText);if(amount===null){errors.push({row:i+1,field:'Opening Balance',message:'Use a number with up to four decimal places, or leave blank/use - for zero'});invalid=true;}
    if(code){const key=code.toLocaleLowerCase('en');if(seen.has(key)){errors.push({row:i+1,field:'Code',message:`Duplicate supplier code in file: ${code}`});invalid=true;}else seen.add(key);}
    if(!invalid)rows.push({row_number:i+1,supplier_code:code,supplier_name:name,amount:amount!});
  }
  if(totalRows===0)errors.push({row:headerIndex+1,field:'Worksheet',message:'No supplier rows found below the header'});
  return {rows,errors,blank_rows,headers,total_rows:totalRows};
}

type AutoAccountSpec={key:string;baseCode:string;name:string;account_type:'ASSET'|'LIABILITY'|'EQUITY';account_nature:'DEBIT'|'CREDIT'};
const autoAccountSpecs:AutoAccountSpec[]=[
  {key:'ap_control',baseCode:'SUP-AP-CTRL',name:'Suppliers Payable Control',account_type:'LIABILITY',account_nature:'CREDIT'},
  {key:'supplier_advances',baseCode:'SUP-ADVANCES',name:'Supplier Advances and Prepayments',account_type:'ASSET',account_nature:'DEBIT'},
  {key:'opening_clearing',baseCode:'OPENING-CLEARING',name:'Opening Balance Clearing',account_type:'EQUITY',account_nature:'CREDIT'},
];
function amountUnits(amount:string):bigint{
  const m=/^(-?)(\d{1,15})(?:\.(\d{1,4}))?$/.exec(amount);if(!m)throw fail(`Invalid normalized supplier amount: ${amount}`);
  const magnitude=BigInt(m[2])*10000n+BigInt((m[3]||'').padEnd(4,'0')||'0');return m[1]?-magnitude:magnitude;
}
function unitsAmount(units:bigint){const abs=units<0n?-units:units;return `${units<0n?'-':''}${abs/10000n}.${String(abs%10000n).padStart(4,'0')}`}
async function ensureAutoAccount(trx:Knex.Transaction,spec:AutoAccountSpec,userId:number){
  for(let suffix=1;suffix<=999;suffix++){
    const code=suffix===1?spec.baseCode:`${spec.baseCode}-${String(suffix).padStart(2,'0')}`;
    const existing=await trx('accounts').where({account_no:code}).first();
    if(existing){if(existing.status==='ACTIVE'&&existing.account_type===spec.account_type&&existing.account_nature===spec.account_nature&&String(existing.currency||'KES').toUpperCase()==='KES')return {account:existing,created:false};continue;}
    const [account]=await trx('accounts').insert({account_no:code,account_name:spec.name,account_type:spec.account_type,account_nature:spec.account_nature,currency:'KES',status:'ACTIVE'}).returning('*');
    await trx('audit_logs').insert({user_id:userId,action:'SUPPLIER_IMPORT_ACCOUNT_CREATED',table_name:'accounts',record_id:String(account.account_id),new_values:account});
    return {account,created:true};
  }
  throw fail(`Could not find or create a compatible ${spec.name} account`,409);
}
async function updateSupplierPostingRules(trx:Knex.Transaction,controlAccountId:number,userId:number){
  const rules=await trx('transaction_type_rules as r').join('transaction_types as t','t.transaction_type_id','r.transaction_type_id')
    .where('t.status','ACTIVE').where('t.affects_supplier',true).where('r.status','ACTIVE')
    .select('r.*','t.code as transaction_type_code');
  let updatedCount=0,unfixedCount=0;
  for(const rule of rules){
    if(rule.account_selection_mode!=='FIXED'||(rule.party_account_side!=='DEBIT'&&rule.party_account_side!=='CREDIT')){unfixedCount++;continue;}
    const field=rule.party_account_side==='DEBIT'?'debit_account_id':'credit_account_id';
    const current=rule[field];if(current===null||current===undefined){unfixedCount++;continue;}
    if(Number(current)===controlAccountId)continue;
    const opposite=rule.party_account_side==='DEBIT'?rule.credit_account_id:rule.debit_account_id;
    if(opposite!==null&&opposite!==undefined&&Number(opposite)===controlAccountId)throw fail(`Supplier posting rule ${rule.transaction_type_code} would debit and credit the same control account; review its accounts before import`,409);
    const oldValues=rule;
    const [updated]=await trx('transaction_type_rules').where({rule_id:rule.rule_id}).update({[field]:controlAccountId}).returning('*');
    const reason='Supplier opening import assigned the shared AP control account to the fixed supplier side';
    await trx('transaction_type_rule_history').insert({transaction_type_id:rule.transaction_type_id,old_values:oldValues,new_values:updated,changed_by:userId,reason});
    await trx('audit_logs').insert({user_id:userId,action:'SUPPLIER_CONTROL_ACCOUNT_ASSIGNED',table_name:'transaction_type_rules',record_id:String(rule.rule_id),old_values:oldValues,new_values:updated});
    updatedCount++;
  }
  return {updated:updatedCount,unfixed:unfixedCount};
}

export async function createSupplierOpeningImportBatch(db:Knex,rows:SupplierOpeningImportRow[],input:{effective_date:string;description:string;accounts?:OpeningLine[]},userId:number){
  if(!rows.length)throw fail('No valid suppliers found in the uploaded file');
  return db.transaction(async trx=>{
    await trx.raw('SELECT pg_advisory_xact_lock(7224103902)');
    const lowerCodes=rows.map(row=>row.supplier_code.trim().toLocaleLowerCase('en'));
    const found=await trx.raw('SELECT supplier_id,supplier_code,supplier_name,status FROM suppliers WHERE LOWER(BTRIM(supplier_code))=ANY(?::text[])',[lowerCodes]);
    const supplierByCode=new Map<string,any>((found.rows as any[]).map(row=>[String(row.supplier_code).trim().toLocaleLowerCase('en'),row]));
    const missing:SupplierOpeningImportRow[]=[];
    for(const row of rows){const existing=supplierByCode.get(row.supplier_code.trim().toLocaleLowerCase('en'));if(!existing){missing.push(row);continue;}
      if(String(existing.supplier_name).trim().toLocaleLowerCase('en')!==row.supplier_name.trim().toLocaleLowerCase('en'))throw fail(`Supplier code ${row.supplier_code} already exists with a different name; resolve it before importing`,409);
      if(existing.status!=='ACTIVE')throw fail(`Supplier ${row.supplier_code} is inactive; reactivate it before importing`,409);
    }
    let createdCount=0;
    for(let offset=0;offset<missing.length;offset+=500){const chunk=missing.slice(offset,offset+500);const created=await trx('suppliers').insert(chunk.map(row=>({supplier_code:row.supplier_code,supplier_name:row.supplier_name,created_by:userId,status:'ACTIVE'}))).returning(['supplier_id','supplier_code','supplier_name','status']);
      for(const supplier of created)supplierByCode.set(String(supplier.supplier_code).trim().toLocaleLowerCase('en'),supplier);
      await trx('audit_logs').insert(created.map(supplier=>({user_id:userId,action:'MASTER_CREATED',table_name:'suppliers',record_id:String(supplier.supplier_id),new_values:supplier})));
      createdCount+=created.length;
    }
    const openingRows=rows.filter(row=>row.amount!=='0.0000');
    const openingIds=openingRows.map(row=>Number(supplierByCode.get(row.supplier_code.trim().toLocaleLowerCase('en')).supplier_id));
    if(openingIds.length){const previous=await trx('supplier_opening_balances').whereIn('supplier_id',openingIds).whereIn('status',['PENDING','APPROVED']).select('supplier_id','status').first();if(previous)throw fail('One or more suppliers already have a pending or approved opening balance; resolve existing batches before importing',409);}
    const supplierLines:OpeningLine[]=openingRows.map(row=>({entity_id:Number(supplierByCode.get(row.supplier_code.trim().toLocaleLowerCase('en')).supplier_id),amount:row.amount}));
    const units=rows.map(row=>amountUnits(row.amount));const positiveTotal=units.filter(v=>v>0n).reduce((sum,v)=>sum+v,0n),negativeTotal=units.filter(v=>v<0n).reduce((sum,v)=>sum-v,0n),net=positiveTotal-negativeTotal;
    const allZero=positiveTotal===0n&&negativeTotal===0n;let batch:any=null,autoAccounts:{account_no:string;account_name:string;account_type:string;account_nature:string;account_id:number;created:boolean}[]=[];let rulesUpdated=0,rulesUnfixed=0;
    if(!allZero){
      const ap=await ensureAutoAccount(trx,autoAccountSpecs[0]!,userId);const clearing=await ensureAutoAccount(trx,autoAccountSpecs[2]!,userId);let advances:{account:any;created:boolean}|null=null;
      if(negativeTotal>0n)advances=await ensureAutoAccount(trx,autoAccountSpecs[1]!,userId);
      const rules=await updateSupplierPostingRules(trx,Number(ap.account.account_id),userId);rulesUpdated=rules.updated;rulesUnfixed=rules.unfixed;
      const accountLines:OpeningLine[]=[];
      if(positiveTotal>0n)accountLines.push({entity_id:Number(ap.account.account_id),debit_amount:'0',credit_amount:unitsAmount(positiveTotal)});
      if(negativeTotal>0n&&advances)accountLines.push({entity_id:Number(advances.account.account_id),debit_amount:unitsAmount(negativeTotal),credit_amount:'0'});
      if(net>0n)accountLines.push({entity_id:Number(clearing.account.account_id),debit_amount:unitsAmount(net),credit_amount:'0'});
      else if(net<0n)accountLines.push({entity_id:Number(clearing.account.account_id),debit_amount:'0',credit_amount:unitsAmount(-net)});
      accountLines.push(...(input.accounts||[]));
      autoAccounts=[ap, ...(advances?[advances]:[]), clearing].map(item=>({account_id:Number(item.account.account_id),account_no:String(item.account.account_no),account_name:String(item.account.account_name),account_type:String(item.account.account_type),account_nature:String(item.account.account_nature),created:item.created}));
      batch=await createOpeningBalanceBatch(trx as unknown as Knex,{...input,accounts:accountLines,suppliers:supplierLines,customers:[],cashiers:[]},userId);
    }else if((input.accounts||[]).length){
      batch=await createOpeningBalanceBatch(trx as unknown as Knex,{...input,accounts:input.accounts||[],suppliers:[],customers:[],cashiers:[]},userId);
    }
    return {batch,rows_imported:rows.length,suppliers_created:createdCount,suppliers_reused:rows.length-createdCount,opening_balances_imported:openingRows.length,auto_accounts:autoAccounts,posting_rules_updated:rulesUpdated,posting_rules_unfixed:rulesUnfixed,positive_supplier_total:unitsAmount(positiveTotal),negative_supplier_total:unitsAmount(-negativeTotal),clearing_net:unitsAmount(net)};
  });
}
