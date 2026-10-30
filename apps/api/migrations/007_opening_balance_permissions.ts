import type { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    INSERT INTO permissions(code,description) VALUES
      ('opening_balances.read','Read opening balance batches'),
      ('opening_balances.prepare','Prepare opening balance batches'),
      ('opening_balances.approve','Approve or reject opening balance batches')
      ON CONFLICT(code) DO NOTHING;
    INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.role_id,p.permission_id FROM roles r CROSS JOIN permissions p
      WHERE r.name='Accounts' AND p.code IN ('opening_balances.read','opening_balances.prepare','opening_balances.approve')
      ON CONFLICT(role_id,permission_id) DO NOTHING;
    INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.role_id,p.permission_id FROM roles r CROSS JOIN permissions p
      WHERE r.name='Viewer' AND p.code='opening_balances.read'
      ON CONFLICT(role_id,permission_id) DO NOTHING;
  `);
}
export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DELETE FROM role_permissions WHERE permission_id IN (SELECT permission_id FROM permissions WHERE code LIKE 'opening_balances.%'); DELETE FROM permissions WHERE code LIKE 'opening_balances.%';`);
}
