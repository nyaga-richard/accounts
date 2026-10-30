import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import ExcelJS from 'exceljs';
import { db } from '../src/db.js';
import { createSupplierOpeningImportBatch,parseSupplierOpeningFile } from '../src/services/supplierOpeningImportService.js';
import { getOpeningBalanceBatch } from '../src/services/openingBalanceService.js';

describe('supplier opening-balance file import parser',()=>{
  it('reads CSV headers, quoted names, grouped amounts, dashes and signed parenthesized balances',async()=>{
    const csv='Name,Code,opening balance\r\n"ACME, Kenya Ltd",SUP-00001,"1,234,567.80"\r\nSecond Supplier,SUP-00002,-\r\nThird Supplier,SUP-00003,"(525.25)"\r\n';
    const parsed=await parseSupplierOpeningFile(Buffer.from(csv),'suppliers.csv');
    expect(parsed.errors).toEqual([]);expect(parsed.total_rows).toBe(3);expect(parsed.rows.map(row=>row.supplier_name)).toEqual(['ACME, Kenya Ltd','Second Supplier','Third Supplier']);
    expect(parsed.rows.map(row=>row.amount)).toEqual(['1234567.8000','0.0000','-525.2500']);
  });
  it('reads Excel workbooks and reports duplicate codes and invalid amounts rather than silently importing them',async()=>{
    const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Suppliers');sheet.addRow(['Supplier Name','Supplier Code','Balance']);sheet.addRow(['First','SUP-1',50]);sheet.addRow(['Duplicate','sup-1',25]);sheet.addRow(['Bad amount','SUP-2','not a number']);
    const buffer=Buffer.from(await workbook.xlsx.writeBuffer());const parsed=await parseSupplierOpeningFile(buffer,'opening.xlsx');
    expect(parsed.total_rows).toBe(3);expect(parsed.rows).toHaveLength(1);expect(parsed.rows[0]?.amount).toBe('50.0000');
    expect(parsed.errors).toEqual(expect.arrayContaining([expect.objectContaining({row:3,field:'Code'}),expect.objectContaining({row:4,field:'Opening Balance'})]));
  });
});

const databaseAvailable=Boolean(process.env.TEST_DATABASE_URL||process.env.DATABASE_URL);
describe.skipIf(!databaseAvailable)('PostgreSQL supplier opening-balance import',()=>{
  let userId=0;const tag=`SUPFILE${Date.now()}`;
  beforeAll(async()=>{const user=await db('users').where({status:'ACTIVE'}).first();if(!user)throw new Error('TEST_DATABASE_URL must point at a migrated and seeded database');userId=Number(user.user_id)});
  afterAll(async()=>{await db.destroy()});
  it('creates missing suppliers and pending signed subledger openings atomically, reuses exact matches, and blocks duplicates',async()=>{
    const [debit]=await db('accounts').insert({account_no:`${tag}-D`,account_name:`${tag} debit`,account_type:'ASSET',account_nature:'DEBIT',currency:'KES'}).returning('*');
    const [credit]=await db('accounts').insert({account_no:`${tag}-C`,account_name:`${tag} credit`,account_type:'EQUITY',account_nature:'CREDIT',currency:'KES'}).returning('*');
    const [existing]=await db('suppliers').insert({supplier_code:`${tag}-OLD`,supplier_name:'Existing file supplier',created_by:userId}).returning('*');
    const rows=[{row_number:2,supplier_code:`${tag}-01`,supplier_name:'New supplier one',amount:'1200.5000'},{row_number:3,supplier_code:`${tag}-02`,supplier_name:'New supplier two',amount:'-75.2500'},{row_number:4,supplier_code:String(existing.supplier_code).toLowerCase(),supplier_name:'Existing file supplier',amount:'0.0000'}];
    const input={effective_date:'2000-01-01',description:`${tag} imported opening balances`,accounts:[{entity_id:Number(debit.account_id),debit_amount:'1275.75',credit_amount:'0'},{entity_id:Number(credit.account_id),debit_amount:'0',credit_amount:'1275.75'}]};
    const invalidRows=[{row_number:2,supplier_code:`${tag}-ROLLBACK`,supplier_name:'Must roll back',amount:'1.0000'}];
    await expect(createSupplierOpeningImportBatch(db,invalidRows,{...input,accounts:[{entity_id:Number(debit.account_id),debit_amount:'1',credit_amount:'0'}]},userId)).rejects.toThrow(/must balance exactly/);
    expect(await db('suppliers').where({supplier_code:`${tag}-ROLLBACK`}).first()).toBeFalsy();
    const result=await createSupplierOpeningImportBatch(db,rows,input,userId);
    expect(result.rows_imported).toBe(3);expect(result.suppliers_created).toBe(2);expect(result.suppliers_reused).toBe(1);expect(result.opening_balances_imported).toBe(2);expect(result.batch.status).toBe('PENDING');
    const detail=await getOpeningBalanceBatch(db,Number(result.batch.opening_batch_id));expect(detail.suppliers.map((row:any)=>row.amount)).toEqual(['1200.5000','-75.2500']);
    await expect(createSupplierOpeningImportBatch(db,rows,input,userId)).rejects.toThrow(/pending or approved opening balance/);
    expect(await db('suppliers').whereIn('supplier_code',[`${tag}-01`,`${tag}-02`]).count('* as n').first().then(row=>String(row?.n))).toBe('2');
  });
});
