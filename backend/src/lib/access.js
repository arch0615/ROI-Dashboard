// Compute a user's data-access scope.
//
// Single-tenant model: an `admin` user owns everything (every site,
// every Google/GAM account, every campaign and metric belongs to them).
// `member` users are guests of that tenant — they don't own data but
// have read access to a subset of sites via site_memberships, and
// transitively to the Google/GAM accounts linked to those sites.
//
// Every read endpoint asks `getAccessScope(user)` for the lists of
// IDs they may see and filters its WHERE clause against them. Writes
// are admin-only (gated by requireAdmin).

const db = require('../db/database');

const EMPTY_SCOPE = {
  is_admin: false,
  tenant_user_id: null,
  site_ids: [],
  google_account_ids: [],
  gam_account_ids: [],
};

function getAccessScope(user) {
  if (!user) return { ...EMPTY_SCOPE };
  if (user.role === 'admin') {
    // Admin sees everything they own. We still return the explicit
    // ID lists so the same filtering helpers work uniformly.
    const sites = db.prepare(`SELECT id FROM sites WHERE user_id = ?`).all(user.id);
    const gas = db.prepare(`SELECT id FROM google_accounts WHERE user_id = ?`).all(user.id);
    const gams = db.prepare(`SELECT id FROM gam_accounts WHERE user_id = ?`).all(user.id);
    return {
      is_admin: true,
      tenant_user_id: user.id,
      site_ids: sites.map((s) => s.id),
      google_account_ids: gas.map((g) => g.id),
      gam_account_ids: gams.map((g) => g.id),
    };
  }

  // Member: site_ids comes from site_memberships; account ids derive
  // from account_site_links restricted to those sites.
  const sites = db
    .prepare(`SELECT site_id FROM site_memberships WHERE user_id = ?`)
    .all(user.id)
    .map((m) => m.site_id);
  if (sites.length === 0) {
    return { ...EMPTY_SCOPE };
  }
  const placeholders = sites.map(() => '?').join(',');
  const tenantRow = db
    .prepare(`SELECT DISTINCT user_id FROM sites WHERE id IN (${placeholders}) LIMIT 1`)
    .get(...sites);
  const tenantUserId = tenantRow?.user_id ?? null;

  const links = db
    .prepare(
      `SELECT google_account_id, gam_account_id
         FROM account_site_links
        WHERE site_id IN (${placeholders})`,
    )
    .all(...sites);
  const googleAccountIds = [...new Set(links.map((l) => l.google_account_id).filter(Boolean))];
  const gamAccountIds = [...new Set(links.map((l) => l.gam_account_id).filter(Boolean))];

  return {
    is_admin: false,
    tenant_user_id: tenantUserId,
    site_ids: sites,
    google_account_ids: googleAccountIds,
    gam_account_ids: gamAccountIds,
  };
}

// Returns a SQL `column IN (?, ?, ...)` snippet plus the params array,
// or `column IN (NULL)` (always false) when the list is empty. This is
// the safe degradation for empty scopes — members with no memberships
// get zero rows instead of, say, accidentally seeing everything.
function inClause(column, ids) {
  if (!ids || ids.length === 0) {
    return { sql: `${column} IN (NULL)`, params: [] };
  }
  return {
    sql: `${column} IN (${ids.map(() => '?').join(',')})`,
    params: ids.slice(),
  };
}

module.exports = { getAccessScope, inClause };
