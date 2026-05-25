// Apply placement exclusions to Google Ads — the destructive endpoint.
//
// SAFETY RE-CHECK: before sending any mutate, we re-run the preview's
// attribution model against the FRESHEST data for each (campaign,
// placement) pair the user picked. If the ROI improved past the
// max_roi threshold, the row is REJECTED (logged, never sent to
// Google). This guards against acting on stale numbers.
//
// Submits one mutate batch per (google_account_id, login_customer_id)
// — campaignCriterion:mutate is per-customer, partial_failure=true so
// a single rejected row doesn't sink the batch. Every applied row
// gets a placement_exclusions audit entry with the criterion's
// resource name so an Undo can remove it later.

const crypto = require('crypto');
const db = require('../db/database');
const { decrypt } = require('../lib/crypto');
const googleAds = require('../lib/google-ads');

const DEFAULT_MAX_ROI = -10;

function netFactorFor(userId) {
  const rules = db
    .prepare(`SELECT revenue_share_pct FROM rules_config WHERE user_id = ?`)
    .get(userId);
  return 1 - (rules?.revenue_share_pct ?? 6.5) / 100;
}

// Recompute the cost+revenue+roi for a (campaign, placement) using the
// same attribution model as the preview. Returns null when the pair
// has no data in the window (treat as "couldn't verify, refuse").
function recheckOne({ userId, campaignId, placement, from, to, netFactor }) {
  const rev = db
    .prepare(
      `SELECT SUM(revenue) AS revenue, SUM(impressions) AS impressions, COUNT(DISTINCT date) AS days
         FROM utm_revenue_placements
        WHERE user_id = ? AND ga_campaign_id = ?
          AND date BETWEEN ? AND ?
          AND LOWER(TRIM(placement_value)) LIKE LOWER(?)`,
    )
    .get(userId, campaignId, from, to, `%${placement}%`);
  if (!rev || !rev.impressions) return null;

  const campImps = db
    .prepare(
      `SELECT SUM(impressions) AS total_imp
         FROM utm_revenue_placements
        WHERE user_id = ? AND ga_campaign_id = ?
          AND date BETWEEN ? AND ?`,
    )
    .get(userId, campaignId, from, to);
  const campCost = db
    .prepare(
      `SELECT SUM(spend) AS cost
         FROM daily_metrics
        WHERE user_id = ? AND campaign_id = ?
          AND date BETWEEN ? AND ?`,
    )
    .get(userId, campaignId, from, to);
  if (!campImps?.total_imp || !campCost?.cost) return null;

  const impShare = rev.impressions / campImps.total_imp;
  const cost = (campCost.cost || 0) * impShare;
  const netRevenue = (rev.revenue || 0) * netFactor;
  const profit = netRevenue - cost;
  const roi = cost > 0 ? (profit / cost) * 100 : 0;
  return { cost, revenue: rev.revenue || 0, impressions: rev.impressions, days: rev.days, roi };
}

// Group selected items by google_account_id (which determines the
// customer_id for the mutate call) and the customer_id of the AD
// account that owns the campaign.
function resolveAdsCustomer({ campaignId }) {
  const row = db
    .prepare(
      `SELECT c.google_account_id, ga.customer_id, ga.login_customer_id, ga.manager_account_id,
              ga.refresh_token_enc, ga.refresh_token_iv, ga.refresh_token_tag,
              ga.account_name
         FROM campaigns c
         JOIN google_accounts ga ON ga.id = c.google_account_id
        WHERE c.campaign_id = ?
        LIMIT 1`,
    )
    .get(campaignId);
  return row;
}

async function applyPlacementExclusions({
  userId,
  appliedByUserId,
  items,
  maxRoi = DEFAULT_MAX_ROI,
  from,
  to,
}) {
  if (!Array.isArray(items) || items.length === 0) {
    return { applied: 0, rejected: 0, results: [] };
  }
  const netFactor = netFactorFor(userId);

  // Phase 1 — safety re-check. Build approved/rejected lists.
  const approved = [];
  const rejected = [];
  for (const it of items) {
    const placement = String(it.placement || '').trim();
    const campaignId = String(it.campaign_id || '').trim();
    if (!campaignId || !placement) {
      rejected.push({ ...it, rejected_reason: 'invalid_input' });
      continue;
    }
    const rc = recheckOne({ userId, campaignId, placement, from, to, netFactor });
    if (!rc) {
      rejected.push({ ...it, rejected_reason: 'no_data_in_window' });
      continue;
    }
    if (rc.roi > maxRoi) {
      rejected.push({
        ...it,
        rejected_reason: 'roi_improved',
        recheck: rc,
      });
      continue;
    }
    approved.push({ ...it, recheck: rc });
  }

  // Phase 2 — mutate by Ads customer. We share an OAuth access token
  // per customer (the MCC root) instead of refreshing per-row.
  const byCustomer = new Map();
  for (const it of approved) {
    const ads = resolveAdsCustomer({ campaignId: it.campaign_id });
    if (!ads) {
      rejected.push({ ...it, rejected_reason: 'ads_account_not_found' });
      continue;
    }
    const key = ads.customer_id;
    if (!byCustomer.has(key)) byCustomer.set(key, { ads, ops: [] });
    byCustomer.get(key).ops.push({ it, ads });
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
      for (const { it } of group.ops) {
        results.push({ ...it, status: 'error', error: `token_refresh: ${err.message}` });
      }
      continue;
    }

    // Build one operation per (campaign, placement). Google Ads
    // negative placement criteria target a campaign, with the
    // placement.url being the page to exclude.
    const operations = group.ops.map(({ it }) => ({
      create: {
        campaign: `customers/${customerId.replace(/-/g, '')}/campaigns/${it.campaign_id}`,
        negative: true,
        placement: { url: it.placement.startsWith('http') ? it.placement : `https://${it.placement}` },
      },
    }));

    let mutateResp;
    try {
      mutateResp = await googleAds.mutateCampaignCriteria({
        customerId,
        accessToken,
        loginCustomerId: group.ads.login_customer_id || null,
        operations,
      });
    } catch (err) {
      for (const { it } of group.ops) {
        results.push({ ...it, status: 'error', error: err.message });
      }
      continue;
    }

    const insertAudit = db.prepare(`
      INSERT INTO placement_exclusions (
        id, user_id, google_account_id, campaign_id, campaign_name,
        placement, criterion_resource_name,
        snapshot_cost, snapshot_revenue, snapshot_roi, snapshot_days,
        reason, applied_by_user_id, error
      ) VALUES (
        @id, @user_id, @google_account_id, @campaign_id, @campaign_name,
        @placement, @criterion_resource_name,
        @snapshot_cost, @snapshot_revenue, @snapshot_roi, @snapshot_days,
        @reason, @applied_by_user_id, @error
      )
    `);

    db.transaction(() => {
      for (let i = 0; i < group.ops.length; i++) {
        const { it } = group.ops[i];
        const r = mutateResp.results?.[i] ?? null;
        const resourceName = r?.resourceName ?? null;
        const opError = mutateResp.partialFailureError?.details?.find?.((d) =>
          d.errors?.find?.((e) => Number(e.location?.fieldPathElements?.find?.((p) => p.fieldName === 'operations')?.index) === i),
        );
        const isError = !resourceName && opError;
        insertAudit.run({
          id: crypto.randomUUID(),
          user_id: userId,
          google_account_id: group.ads.id ?? null,
          campaign_id: it.campaign_id,
          campaign_name: it.campaign_name ?? null,
          placement: it.placement,
          criterion_resource_name: resourceName,
          snapshot_cost: it.recheck.cost,
          snapshot_revenue: it.recheck.revenue,
          snapshot_roi: it.recheck.roi,
          snapshot_days: it.recheck.days,
          reason: it.reason ?? null,
          applied_by_user_id: appliedByUserId,
          error: isError ? JSON.stringify(opError).slice(0, 400) : null,
        });
        results.push({
          ...it,
          status: isError ? 'error' : 'applied',
          resource_name: resourceName,
          error: isError ? 'partial_failure' : null,
        });
      }
    })();
  }

  return {
    applied: results.filter((r) => r.status === 'applied').length,
    rejected: rejected.length,
    errors: results.filter((r) => r.status === 'error').length,
    rejected_items: rejected,
    results,
  };
}

async function undoPlacementExclusion({ userId, exclusionId }) {
  const row = db
    .prepare(`SELECT * FROM placement_exclusions WHERE id = ? AND user_id = ?`)
    .get(exclusionId, userId);
  if (!row) {
    const err = new Error('Exclusão não encontrada');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (row.undone_at) {
    const err = new Error('Exclusão já foi desfeita');
    err.code = 'ALREADY_UNDONE';
    throw err;
  }
  if (!row.criterion_resource_name) {
    // Apply failed before — just mark as undone.
    db.prepare(`UPDATE placement_exclusions SET undone_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      row.id,
    );
    return { id: row.id, removed_via_api: false };
  }

  const ads = db
    .prepare(`SELECT * FROM google_accounts WHERE id = ?`)
    .get(row.google_account_id);
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
  await googleAds.mutateCampaignCriteria({
    customerId: ads.customer_id,
    accessToken,
    loginCustomerId: ads.login_customer_id || null,
    operations: [{ remove: row.criterion_resource_name }],
  });
  db.prepare(`UPDATE placement_exclusions SET undone_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  return { id: row.id, removed_via_api: true };
}

module.exports = { applyPlacementExclusions, undoPlacementExclusion };
