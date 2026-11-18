/**
 * Seed one administrator account from the environment.
 *
 * A deployment *without* the demo storyline still needs a first login: PCS has no
 * open bootstrap account, and registration cannot grant the admin scope. Setting
 * PCS_SEED_ADMIN_USERNAME and PCS_SEED_ADMIN_PASSWORD makes the entrypoint run
 * this once per start; it is idempotent and never resets an existing password, so
 * a password changed in the UI survives a restart.
 *
 * The password still has to satisfy the normal policy; nothing here weakens it.
 */
import { query } from "../src/db.js";
import { ACCOUNT_SCOPES } from "../src/jwt.js";
import { hashPassword } from "../src/passwords.js";

async function main(): Promise<void> {
  const username = (process.env.PCS_SEED_ADMIN_USERNAME ?? "").trim();
  const password = process.env.PCS_SEED_ADMIN_PASSWORD ?? "";
  if (!username) {
    console.log("[seed-admin] PCS_SEED_ADMIN_USERNAME is empty; nothing to seed");
    return;
  }
  if (password.length <= 8) {
    throw new Error("[seed-admin] PCS_SEED_ADMIN_PASSWORD must be longer than 8 characters");
  }

  const existing = await query(`SELECT account_id FROM pcs_accounts WHERE username=$1`, [username]);
  if (existing.rowCount) {
    console.log(`[seed-admin] account ${username} already exists; leaving it untouched`);
    return;
  }

  await query(
    `INSERT INTO pcs_accounts
       (account_id, username, display_name, password_hash, role, scopes, status, approved_by)
     VALUES ($1,$2,$3,$4,'admin',$5,'ACTIVE','seed')`,
    [
      `acc_${username.replace(/[^a-zA-Z0-9]/g, "_")}`,
      username,
      "Administrator",
      hashPassword(password),
      [...ACCOUNT_SCOPES],
    ],
  );
  console.log(`[seed-admin] administrator ${username} created`);
}

void main().catch((e) => {
  console.error("[seed-admin] failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
