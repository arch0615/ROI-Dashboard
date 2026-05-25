// Pulls per-(campaign, placement, date) cost data from Google Ads via
// the detail_placement_view GAQL view. Writes to ads_placements.
//
// Runs ONE GAQL search per leaf account (filtering all campaigns at
// once with WHERE campaign.status IN (ENABLED, PAUSED)). The original
// tracker queried per-campaign — that wastes a request per campaign;
// we batch on the account.
//
// `placement_clean` strips off url params + protocol + www. so the
// same physical site under multiple campaigns matches up cleanly
// when joining against utm_revenue_placements.placement_value.

const crypto = require('crypto');
const db = require('../db/database');
const { decrypt } = require('../lib/crypto');
const googleAds = require('../lib/google-ads');

const ALLOWED_PRESETS = new Set([
  'TODAY',
  'YESTERDAY',
  'LAST_7_DAYS',
  'LAST_14_DAYS',
  'LAST_30_DAYS',
]);

function dateClauseFromInput({ datePreset, from, to }) {
  if (datePreset && ALLOWED_PRESETS.has(String(datePreset).toUpperCase())) {
    return `segments.date DURING ${String(datePreset).toUpperCase()}`;
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (from && to && iso.test(from) && iso.test(to)) {
    return `segments.date BETWEEN '${from}' AND '${to}'`;
  }
  return 'segments.date DURING LAST_7_DAYS';
}

// Strip protocol + www + path/query so the same physical placement
// matches against the GAM-reported utm_placement value.
function cleanPlacement(raw, targetUrl) {
  const s = String(raw || targetUrl || '').trim().toLowerCase();
  if (!s) return '';
  const appMatch = s.match(/mobileapp::\d+-(.+)$/i);
  if (appMatch) return appMatch[1];
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return s.replace(/^www\./, '').split('/')[0];
  }
}

async function syncAdsPlacementsForLeaf({ userId, leaf, accessToken, dateClause }) {
  const query = `
    SELECT
      detail_placement_view.placement,
      detail_placement_view.display_name,
      detail_placement_view.target_url,
      detail_placement_view.placement_type,
      ad_group.id,
      ad_group.name,
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.clicks,
      metrics.impressions,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr,
      segments.date
    FROM detail_placement_view
    WHERE ${dateClause}
      AND campaign.status IN ('ENABLED', 'PAUSED')
  `;
  let results;
  try {
    results = await googleAds.adsSearch({
      customerId: leaf.customer_id,
      loginCustomerId: leaf.login_customer_id || null,
      accessToken,
      query,
    });
  } catch (err) {
    return { customer_id: leaf.customer_id, error: err.message, rows: 0 };
  }

  const upsert = db.prepare(`
    INSERT INTO ads_placements (
      id, user_id, google_account_id, campaign_id, campaign_name,
      ad_group_id, ad_group_name, placement, placement_clean,
      display_name, target_url, placement_type, date,
      impressions, clicks, cost, conversions, ctr
    ) VALUES (
      @id, @user_id, @google_account_id, @campaign_id, @campaign_name,
      @ad_group_id, @ad_group_name, @placement, @placement_clean,
      @display_name, @target_url, @placement_type, @date,
      @impressions, @clicks, @cost, @conversions, @ctr
    )
    ON CONFLICT(user_id, google_account_id, campaign_id, placement, date)
    DO UPDATE SET
      campaign_name   = excluded.campaign_name,
      ad_group_id     = excluded.ad_group_id,
      ad_group_name   = excluded.ad_group_name,
      placement_clean = excluded.placement_clean,
      display_name    = excluded.display_name,
      target_url      = excluded.target_url,
      placement_type  = excluded.placement_type,
      impressions     = excluded.impressions,
      clicks          = excluded.clicks,
      cost            = excluded.cost,
      conversions     = excluded.conversions,
      ctr             = excluded.ctr
  `);

  let written = 0;
  const writeAll = db.transaction(() => {
    for (const r of results) {
      const dp = r.detailPlacementView || {};
      const placement = String(dp.placement ?? dp.displayName ?? 'unknown');
      const targetUrl = dp.targetUrl ?? null;
      upsert.run({
        id: crypto.randomUUID(),
        user_id: userId,
        google_account_id: leaf.id,
        campaign_id: String(r.campaign?.id ?? ''),
        campaign_name: r.campaign?.name ?? null,
        ad_group_id: r.adGroup?.id ? String(r.adGroup.id) : null,
        ad_group_name: r.adGroup?.name ?? null,
        placement,
        placement_clean: cleanPlacement(placement, targetUrl),
        display_name: dp.displayName ?? null,
        target_url: targetUrl,
        placement_type: dp.placementType ?? null,
        date: r.segments?.date ?? null,
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks: Number(r.metrics?.clicks ?? 0),
        cost: Number(r.metrics?.costMicros ?? 0) / 1_000_000,
        conversions: Number(r.metrics?.conversions ?? 0),
        ctr: Number(r.metrics?.ctr ?? 0),
      });
      written += 1;
    }
  });
  writeAll();
  return { customer_id: leaf.customer_id, name: leaf.account_name, rows: written };
}

// Top-level: resolves the saved google_accounts row, expands MCC if
// needed (same logic as syncGoogleAdsAccount, but minimal — we only
// need leaf accounts here, not to upsert them).
async function syncAdsPlacementsForAccount({ userId, accountId, datePreset, from, to }) {
  const root = db
    .prepare(`SELECT * FROM google_accounts WHERE id = ? AND user_id = ?`)
    .get(accountId, userId);
  if (!root) {
    const err = new Error('Conta não encontrada');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!root.refresh_token_enc) {
    const err = new Error('Conta sem refresh_token salvo');
    err.code = 'NO_TOKEN';
    throw err;
  }

  const refreshToken = decrypt({
    ciphertext: root.refresh_token_enc,
    iv: root.refresh_token_iv,
    tag: root.refresh_token_tag,
  });
  const { accessToken } = await googleAds.getAccessToken(refreshToken);

  // For an MCC, iterate all children rows we already have stored
  // (the Ads sync should have expanded them previously). For a leaf,
  // just sync that one customer.
  let leaves;
  if (root.is_mcc) {
    leaves = db
      .prepare(
        `SELECT id, customer_id, login_customer_id, account_name
           FROM google_accounts
          WHERE user_id = ? AND manager_account_id = ?`,
      )
      .all(userId, root.id);
  } else {
    leaves = [
      {
        id: root.id,
        customer_id: root.customer_id,
        login_customer_id: root.login_customer_id,
        account_name: root.account_name ?? root.customer_id,
      },
    ];
  }

  const dateClause = dateClauseFromInput({ datePreset, from, to });
  const perAccount = [];
  let totalRows = 0;
  for (const leaf of leaves) {
    const r = await syncAdsPlacementsForLeaf({ userId, leaf, accessToken, dateClause });
    perAccount.push(r);
    if (r.rows) totalRows += r.rows;
  }
  return {
    root: { id: root.id, customer_id: root.customer_id, is_mcc: !!root.is_mcc },
    date_clause: dateClause,
    leaf_count: leaves.length,
    rows_written: totalRows,
    accounts: perAccount,
  };
}

module.exports = { syncAdsPlacementsForAccount, cleanPlacement };
