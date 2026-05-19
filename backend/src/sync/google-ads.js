// Google Ads sync orchestrator.
//
// Flow:
//  1. Resolve the root account (the saved google_accounts row).
//  2. If it's an MCC, list customer_clients where manager = FALSE and
//     upsert each as a child google_accounts row pointing back at the
//     root via manager_account_id. The child shares the root's
//     refresh_token (Google Ads model).
//  3. For each leaf (non-manager) account, run a GAQL search for
//     campaigns + per-day metrics, upsert into campaigns and
//     daily_metrics. spend = cost_micros / 1_000_000 (native currency
//     of the Ads account — conversion to BRL happens downstream when
//     the daily rollup combines Ads + GAM).

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

function statusFromGoogle(s) {
  const g = String(s ?? 'ENABLED').toUpperCase();
  if (g === 'SUSPENDED') return 'suspended';
  if (g === 'CANCELED' || g === 'CLOSED') return 'canceled';
  return 'connected';
}

async function expandMccChildren({ userId, root, accessToken }) {
  const query = `
    SELECT customer_client.id, customer_client.descriptive_name,
           customer_client.currency_code, customer_client.manager,
           customer_client.status
    FROM customer_client
    WHERE customer_client.manager = FALSE
  `;
  const rows = await googleAds.adsSearch({
    customerId: root.customer_id,
    loginCustomerId: root.customer_id,
    accessToken,
    query,
  });

  const upsert = db.prepare(`
    INSERT INTO google_accounts (
      id, user_id, customer_id, login_customer_id, account_name,
      descriptive_name, currency, manager_account_id, is_mcc,
      refresh_token_enc, refresh_token_iv, refresh_token_tag,
      status, last_synced_at
    ) VALUES (
      @id, @user_id, @customer_id, @login_customer_id, @account_name,
      @descriptive_name, @currency, @manager_account_id, 0,
      @refresh_token_enc, @refresh_token_iv, @refresh_token_tag,
      @status, CURRENT_TIMESTAMP
    )
    ON CONFLICT(user_id, customer_id) DO UPDATE SET
      login_customer_id = excluded.login_customer_id,
      account_name      = excluded.account_name,
      descriptive_name  = excluded.descriptive_name,
      currency          = excluded.currency,
      manager_account_id = excluded.manager_account_id,
      status            = excluded.status,
      last_synced_at    = CURRENT_TIMESTAMP
    RETURNING id, customer_id, login_customer_id, currency, account_name
  `);

  const leaves = [];
  for (const r of rows) {
    const cc = r.customerClient || {};
    const cid = String(cc.id);
    const name = cc.descriptiveName ?? `Conta ${cid}`;
    const row = upsert.get({
      id: crypto.randomUUID(),
      user_id: userId,
      customer_id: cid,
      login_customer_id: root.customer_id,
      account_name: name,
      descriptive_name: name,
      currency: cc.currencyCode ?? null,
      manager_account_id: root.id,
      refresh_token_enc: root.refresh_token_enc,
      refresh_token_iv: root.refresh_token_iv,
      refresh_token_tag: root.refresh_token_tag,
      status: statusFromGoogle(cc.status),
    });
    leaves.push(row);
  }
  return leaves;
}

async function syncLeafCampaigns({ userId, leaf, accessToken, dateClause }) {
  const query = `
    SELECT
      campaign.id, campaign.name, campaign.status,
      campaign.advertising_channel_type,
      campaign_budget.amount_micros,
      campaign.target_cpa.target_cpa_micros,
      campaign.maximize_conversions.target_cpa_micros,
      metrics.cost_micros, metrics.clicks, metrics.impressions,
      metrics.conversions, metrics.conversions_value,
      segments.date
    FROM campaign
    WHERE ${dateClause}
  `;
  const results = await googleAds.adsSearch({
    customerId: leaf.customer_id,
    loginCustomerId: leaf.login_customer_id || null,
    accessToken,
    query,
  });

  // Dedupe campaigns within the response (last write wins for budget/cpa)
  const campaignsByGoogleId = new Map();
  for (const r of results) {
    const c = r.campaign;
    const budgetMicros = r.campaignBudget?.amountMicros
      ? Number(r.campaignBudget.amountMicros)
      : null;
    const cpaMicros =
      c.targetCpa?.targetCpaMicros != null
        ? Number(c.targetCpa.targetCpaMicros)
        : c.maximizeConversions?.targetCpaMicros != null
          ? Number(c.maximizeConversions.targetCpaMicros)
          : null;
    campaignsByGoogleId.set(c.id, {
      name: c.name,
      status: String(c.status ?? 'enabled').toLowerCase(),
      channel: c.advertisingChannelType ?? 'DISPLAY',
      budget_micros: budgetMicros,
      target_cpa_micros: cpaMicros,
    });
  }

  const upsertCampaign = db.prepare(`
    INSERT INTO campaigns (
      id, user_id, google_account_id, campaign_id, name, status,
      channel_type, budget_micros, target_cpa_micros, updated_at
    ) VALUES (
      @id, @user_id, @google_account_id, @campaign_id, @name, @status,
      @channel_type, @budget_micros, @target_cpa_micros, CURRENT_TIMESTAMP
    )
    ON CONFLICT(user_id, google_account_id, campaign_id) DO UPDATE SET
      name              = excluded.name,
      status            = excluded.status,
      channel_type      = excluded.channel_type,
      budget_micros     = excluded.budget_micros,
      target_cpa_micros = excluded.target_cpa_micros,
      updated_at        = CURRENT_TIMESTAMP
  `);

  const upsertMetric = db.prepare(`
    INSERT INTO daily_metrics (
      id, user_id, google_account_id, campaign_id, date,
      spend, clicks, impressions, conversions, updated_at
    ) VALUES (
      @id, @user_id, @google_account_id, @campaign_id, @date,
      @spend, @clicks, @impressions, @conversions, CURRENT_TIMESTAMP
    )
    ON CONFLICT(user_id, google_account_id, campaign_id, date) DO UPDATE SET
      spend       = excluded.spend,
      clicks      = excluded.clicks,
      impressions = excluded.impressions,
      conversions = excluded.conversions,
      updated_at  = CURRENT_TIMESTAMP
  `);

  // Wrap both upsert loops in one transaction — safer rollback if the
  // process is killed mid-sync.
  const writeAll = db.transaction(() => {
    for (const [campaignId, info] of campaignsByGoogleId) {
      upsertCampaign.run({
        id: crypto.randomUUID(),
        user_id: userId,
        google_account_id: leaf.id,
        campaign_id: campaignId,
        name: info.name,
        status: info.status,
        channel_type: info.channel,
        budget_micros: info.budget_micros,
        target_cpa_micros: info.target_cpa_micros,
      });
    }
    for (const r of results) {
      const spend = Number(r.metrics.costMicros ?? 0) / 1_000_000;
      upsertMetric.run({
        id: crypto.randomUUID(),
        user_id: userId,
        google_account_id: leaf.id,
        campaign_id: r.campaign.id,
        date: r.segments.date,
        spend,
        clicks: Number(r.metrics.clicks ?? 0),
        impressions: Number(r.metrics.impressions ?? 0),
        conversions: Number(r.metrics.conversions ?? 0),
      });
    }
  });
  writeAll();

  return {
    customer_id: leaf.customer_id,
    name: leaf.account_name,
    campaigns: campaignsByGoogleId.size,
    metric_rows: results.length,
  };
}

async function syncGoogleAdsAccount({ userId, accountId, datePreset, from, to }) {
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
    leaves = await expandMccChildren({ userId, root, accessToken });
  } else {
    leaves = [
      {
        id: root.id,
        customer_id: root.customer_id,
        login_customer_id: root.login_customer_id,
        account_name: root.account_name ?? root.descriptive_name ?? root.customer_id,
      },
    ];
  }

  const dateClause = dateClauseFromInput({ datePreset, from, to });

  const perAccount = [];
  let totalMetricRows = 0;
  for (const leaf of leaves) {
    try {
      const r = await syncLeafCampaigns({ userId, leaf, accessToken, dateClause });
      perAccount.push(r);
      totalMetricRows += r.metric_rows;
    } catch (err) {
      perAccount.push({
        customer_id: leaf.customer_id,
        name: leaf.account_name,
        error: err.message,
      });
    }
  }

  db.prepare(`UPDATE google_accounts SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    root.id,
  );

  return {
    root: { id: root.id, customer_id: root.customer_id, is_mcc: !!root.is_mcc },
    date_clause: dateClause,
    leaf_count: leaves.length,
    metric_rows: totalMetricRows,
    accounts: perAccount,
  };
}

module.exports = { syncGoogleAdsAccount };
