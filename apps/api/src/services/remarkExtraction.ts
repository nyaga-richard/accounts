export type ExtractionRule={rule_id:number;rule_name:string;pattern:string;extraction_field:string;priority:number};
export type ExtractedField={field_name:string;extracted_value:string;confidence:string;extraction_method:string};
export function extractRemarkFields(remarks:string,bankReference:string|null,rules:ExtractionRule[],categories:string[]):ExtractedField[]{
 const out:ExtractedField[]=[];if(bankReference!==null&&bankReference!=='')out.push({field_name:'bank_reference',extracted_value:bankReference,confidence:'1.0000',extraction_method:'STATEMENT_COLUMN'});
 const normalized=remarks.toLocaleLowerCase();for(const category of categories){if(category&&normalized.includes(category.toLocaleLowerCase()))out.push({field_name:'transaction_category',extracted_value:category,confidence:'0.9500',extraction_method:'CATEGORY_NAME'});}
 for(const rule of [...rules].sort((a,b)=>a.priority-b.priority||a.rule_id-b.rule_id)){try{const match=new RegExp(rule.pattern,'i').exec(remarks);if(match){const value=(match[1]??match[0]).trim();if(value)out.push({field_name:rule.extraction_field,extracted_value:value,confidence:'0.9000',extraction_method:`CONFIGURED_RULE:${rule.rule_name}`});}}catch{/* Invalid stored rules are skipped; rule editor validates new expressions. */}}
 return out;
}
