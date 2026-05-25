// Pause / un-pause Google Ads creatives via ad_group_ad:mutate.
//
// Same safety pattern as sync/placements-apply.js — re-run the
// attribution model against the freshest data before each pause and
// reject items whose ROI has come back inside the campaign baseline.
// One mutate batch per Ads customer; partial_failure=true; full audit
// in creative_pauses.

const crypto = require('crypto');
const db = require('../db/database');
const { decrypt } = require('../lib/crypto');
const googleAds = require('../lib/google-ads');

const DEFAULT_MAX_ROI_DIFF_PP = 10;
const DEFAULT_MIN_DAYS = 7;

function netFactorFor(userId) {
  const rules = db
    .prepare(`SELECT revenue_share_pct FROM rules_config WHERE user_id = ?`)
    .get(userId);
  return 1 - (rules?.revenue_share_pct ?? 6.5) / 100;
}

// Recompute one creative's ROI + diff against its campaign baseline.
// Returns null when we can't verify (no data, no campaign revenue).
function recheckOne({ userId, campaignId, adId, from, to, netFactor }) {
  const creative = db
    .prepare(
      `SELECT
         SUM(clicks) AS clicks,
         SUM(impressions) AS impressions,
         SUM(cost) AS cost,
         COUNT(DISTINCT date) AS days
       FROM ads_creatives
       WHERE user_id = ? AND campaign_id = ? AND ad_id = ?
         AND date BETWEEN ? AND ?`,
    )
    .get(userId, campaignId, adId, from, to);
  if (!creative || !creative.cost) return null;

  const campAds = db
    .prepare(
      `SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions, SUM(cost) AS cost
         FROM ads_creatives
        WHERE user_id = ? AND campaign_id = ?
          AND date BETWEEN ? AND ?`,
    )
    .get(userId, campaignId, from, to);
  if (!campAds?.cost) return null;

  const grossRev =
    db
      .prepare(
        `SELECT SUM(revenue) AS revenue
           FROM utm_revenue_placements
          WHERE user_id = ? AND ga_campaign_id = ?
            AND date BETWEEN ? AND ?`,
      )
      .get(userId, campaignId, from, to)?.revenue || 0;

  let share = 0;
  if (campAds.clicks > 0) share = (creative.clicks || 0) / campAds.clicks;
  else if (campAds.impressions > 0) share = (creative.impressions || 0) / campAds.impressions;
  const creativeRev = grossRev * share;
  const creativeNet = creativeRev * netFactor;
  const creativeProfit = creativeNet - creative.cost;
  const creativeRoi = creative.cost > 0 ? (creativeProfit / creative.cost) * 100 : 0;

  const campNet = grossRev * netFactor;
  const campProfit = campNet - campAds.cost;
  const campRoi = campAds.cost > 0 ? (campProfit / campAds.cost) * 100 : 0;
  const diff = campRoi - creativeRoi;

  return {
    cost: creative.cost,
    revenue: creativeRev,
    roi: creativeRoi,
    diff,
    days: creative.days,
  };
}

function resolveAdsCustomer({ campaignId }) {
  return db
    .prepare(
      `SELECT c.google_account_id, ga.customer_id, ga.login_customer_id,
              ga.refresh_token_enc, ga.refresh_token_iv, ga.refresh_token_tag
         FROM campaigns c
         JOIN google_accounts ga ON ga.id = c.google_account_id
        WHERE c.campaign_id = ?
        LIMIT 1`,
    )
    .get(campaignId);
}

async function pauseCreatives({
  userId,
  appliedByUserId,
  items,
  maxRoiDiffPp = DEFAULT_MAX_ROI_DIFF_PP,
  minDays = DEFAULT_MIN_DAYS,
  from,
  to,
}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { applied: 0, rejected: 0, errors: 0, results: [] };
  }
  const netFactor = netFactorFor(userId);

  const approved = [];
  const rejected = [];
  for (const it of items) {
    const campaignId = String(it.campaign_id || '').trim();
    const adId = String(it.ad_id || '').trim();
    const resourceName = String(it.resource_name || '').trim();
    if (!campaignId || !adId || !resourceName) {
      rejected.push({ ...it, rejected_reason: 'invalid_input' });
      continue;
    }
    const rc = recheckOne({ userId, campaignId, adId, from, to, netFactor });
    if (!rc) {
      rejected.push({ ...it, rejected_reason: 'no_data_in_window' });
      continue;
    }
    if (rc.days < minDays) {
      rejected.push({ ...it, rejected_reason: 'days_below_min', recheck: rc });
      continue;
    }
    if (rc.diff < maxRoiDiffPp) {
      rejected.push({ ...it, rejected_reason: 'roi_diff_improved', recheck: rc });
      continue;
    }
    approved.push({ ...it, recheck: rc });
  }

  const byCustomer = new Map();
  for (const it of approved) {
    const ads = resolveAdsCustomer({ campaignId: it.campaign_id });
    if (!ads) {
      rejected.push({ ...it, rejected_reason: 'ads_account_not_found' });
      continue;
    }
    const key = ads.customer_id;
    if (!byCustomer.has(key)) byCustomer.set(key, { ads, items: [] });
    byCustomer.get(key).items.push(it);
  }

  const results = [];
  for (const [customerId, group] of byCustomer) {
    const refreshToken = decrypt({
      ciphertext: group.ads.refresh_token_enc,
      iv: group.ads.refresh_token_iv,
      tag: group.ads.refresh_token_tag,
    });
    let accessToken;
    try {
      ({ accessToken } = await googleAds.getAccessToken(refreshToken));
    } catch (err) {
      for (const it of group.items) {
        results.push({ ...it, status: 'error', error: `token_refresh: ${err.message}` });
      }
      continue;
    }

    // Each operation updates the ad_group_ad's status to PAUSED.
    // update_mask must list 'status' for the mutate to take effect.
    const operations = group.items.map((it) => ({
      update: { resourceName: it.resource_name, status: 'PAUSED' },
      updateMask: 'status',
    }));

    let mutateResp;
    try {
      mutateResp = await googleAds.mutateAdGroupAds({
        customerId,
        accessToken,
        loginCustomerId: group.ads.login_customer_id || null,
        operations,
      });
    } catch (err) {
      for (const it of group.items) {
        results.push({ ...it, status: 'error', error: err.message });
      }
      continue;
    }

    const insertAudit = db.prepare(`
      INSERT INTO creative_pauses (
        id, user_id, google_account_id, campaign_id, campaign_name,
        ad_id, ad_name, resource_name,
        snapshot_cost, snapshot_revenue, snapshot_roi, snapshot_diff_pp, snapshot_days,
        applied_by_user_id, error
      ) VALUES (
        @id, @user_id, @google_account_id, @campaign_id, @campaign_name,
        @ad_id, @ad_name, @resource_name,
        @snapshot_cost, @snapshot_revenue, @snapshot_roi, @snapshot_diff_pp, @snapshot_days,
        @applied_by_user_id, @error
      )
    `);

    db.transaction(() => {
      for (let i = 0; i < group.items.length; i++) {
        const it = group.items[i];
        const r = mutateResp.results?.[i] ?? null;
        const opError = mutateResp.partialFailureError?.details?.find?.((d) =>
          d.errors?.find?.((e) => Number(e.location?.fieldPathElements?.find?.((p) => p.fieldName === 'operations')?.index) === i),
        );
        const isError = !r?.resourceName && opError;
        insertAudit.run({
          id: crypto.randomUUID(),
          user_id: userId,
          google_account_id: group.ads.google_account_id ?? null,
          campaign_id: it.campaign_id,
          campaign_name: it.campaign_name ?? null,
          ad_id: it.ad_id,
          ad_name: it.ad_name ?? null,
          resource_name: it.resource_name,
          snapshot_cost: it.recheck.cost,
          snapshot_revenue: it.recheck.revenue,
          snapshot_roi: it.recheck.roi,
          snapshot_diff_pp: it.recheck.diff,
          snapshot_days: it.recheck.days,
          applied_by_user_id: appliedByUserId,
          error: isError ? JSON.stringify(opError).slice(0, 400) : null,
        });
        results.push({
          ...it,
          status: isError ? 'error' : 'paused',
          error: isError ? 'partial_failure' : null,
        });
      }
    })();
  }

  return {
    applied: results.filter((r) => r.status === 'paused').length,
    rejected: rejected.length,
    errors: results.filter((r) => r.status === 'error').length,
    rejected_items: rejected,
    results,
  };
}

async function undoCreativePause({ userId, pauseId }) {
  const row = db
    .prepare(`SELECT * FROM creative_pauses WHERE id = ? AND user_id = ?`)
    .get(pauseId, userId);
  if (!row) {
    const err = new Error('Pausa não encontrada');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (row.undone_at) {
    const err = new Error('Pausa já foi desfeita');
    err.code = 'ALREADY_UNDONE';
    throw err;
  }
  const ads = db.prepare(`SELECT * FROM google_accounts WHERE id = ?`).get(row.google_account_id);
  if (!ads) {
    const err = new Error('Conta Google Ads não encontrada');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const refreshToken = decrypt({
    ciphertext: ads.refresh_token_enc,
    iv: ads.refresh_token_iv,
    tag: ads.refresh_token_tag,
  });
  const { accessToken } = await googleAds.getAccessToken(refreshToken);
  await googleAds.mutateAdGroupAds({
    customerId: ads.customer_id,
    accessToken,
    loginCustomerId: ads.login_customer_id || null,
    operations: [
      { update: { resourceName: row.resource_name, status: 'ENABLED' }, updateMask: 'status' },
    ],
  });
  db.prepare(`UPDATE creative_pauses SET undone_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  return { id: row.id };
}

module.exports = { pauseCreatives, undoCreativePause };
