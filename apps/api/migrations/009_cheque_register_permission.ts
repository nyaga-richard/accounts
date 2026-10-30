import type { Knex } from 'knex';
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    INSERT INTO permissions(code,description) VALUES ('cheques.read','Read posted cheque register and history') ON CONFLICT(code) DO NOTHING;
    INSERT INTO role_permissions(role_id,permission_id)
      SELECT r.role_id,p.permission_id FROM roles r CROSS JOIN permissions p
      WHERE r.name IN ('Accounts','Viewer','Cashier') AND p.code='cheques.read'
      ON CONFLICT(role_id,permission_id) DO NOTHING;
  `);
}
export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DELETE FROM role_permissions WHERE permission_id IN (SELECT permission_id FROM permissions WHERE code='cheques.read'); DELETE FROM permissions WHERE code='cheques.read';`);
}
