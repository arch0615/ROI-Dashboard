// Pulls per-(campaign, ad_group, ad, date) cost data from Google Ads via
// the ad_group_ad GAQL view. Writes to ads_creatives.
//
// Same shape as google-ads-placements.js but the dimension is the
// individual creative (ad_group_ad). The "ad name" is typically the
// HTML5 bundle filename Julio uploaded (300x250_v4.html etc.) which
// matches what he sees in the original tracker's Criativos tab.

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

async function syncCreativesForLeaf({ userId, leaf, accessToken, dateClause }) {
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.ad.type,
      ad_group_ad.status,
      ad_group_ad.resource_name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.ctr,
      segments.date
    FROM ad_group_ad
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
    INSERT INTO ads_creatives (
      id, user_id, google_account_id, campaign_id, campaign_name,
      ad_group_id, ad_group_name, ad_id, ad_name, ad_type, status,
      resource_name, date, impressions, clicks, cost, conversions, ctr
    ) VALUES (
      @id, @user_id, @google_account_id, @campaign_id, @campaign_name,
      @ad_group_id, @ad_group_name, @ad_id, @ad_name, @ad_type, @status,
      @resource_name, @date, @impressions, @clicks, @cost, @conversions, @ctr
    )
    ON CONFLICT(user_id, google_account_id, campaign_id, ad_id, date)
    DO UPDATE SET
      campaign_name = excluded.campaign_name,
      ad_group_id   = excluded.ad_group_id,
      ad_group_name = excluded.ad_group_name,
      ad_name       = excluded.ad_name,
      ad_type       = excluded.ad_type,
      status        = excluded.status,
      resource_name = excluded.resource_name,
      impressions   = excluded.impressions,
      clicks        = excluded.clicks,
      cost          = excluded.cost,
      conversions   = excluded.conversions,
      ctr           = excluded.ctr
  `);

  // Extract a readable name. For HTML5 ads the publisher uploads files
  // like "300x250_v4.html"; the API returns that in ad.name when set,
  // but some campaigns leave it blank — fall back to "ad <id>".
  function pickAdName(adObj) {
    if (adObj?.name) return adObj.name;
    if (adObj?.imageAd?.imageUrl) return adObj.imageAd.imageUrl.split('/').pop() ?? null;
    return null;
  }

  let written = 0;
  const writeAll = db.transaction(() => {
    for (const r of results) {
      const adObj = r.adGroupAd?.ad ?? {};
      upsert.run({
        id: crypto.randomUUID(),
        user_id: userId,
        google_account_id: leaf.id,
        campaign_id: String(r.campaign?.id ?? ''),
        campaign_name: r.campaign?.name ?? null,
        ad_group_id: r.adGroup?.id ? String(r.adGroup.id) : null,
        ad_group_name: r.adGroup?.name ?? null,
        ad_id: String(adObj.id ?? ''),
        ad_name: pickAdName(adObj),
        ad_type: adObj.type ?? null,
        status: r.adGroupAd?.status ?? null,
        resource_name: r.adGroupAd?.resourceName ?? null,
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

async function syncCreativesForAccount({ userId, accountId, datePreset, from, to }) {
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
    const r = await syncCreativesForLeaf({ userId, leaf, accessToken, dateClause });
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

module.exports = { syncCreativesForAccount };
