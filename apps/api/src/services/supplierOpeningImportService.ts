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

export async function createSupplierOpeningImportBatch(db:Knex,rows:SupplierOpeningImportRow[],input:{effective_date:string;description:string;accounts:OpeningLine[]},userId:number){
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
    const batch=await createOpeningBalanceBatch(trx as unknown as Knex,{...input,accounts:input.accounts,suppliers:supplierLines,customers:[],cashiers:[]},userId);
    return {batch,rows_imported:rows.length,suppliers_created:createdCount,suppliers_reused:rows.length-createdCount,opening_balances_imported:openingRows.length};
  });
}
