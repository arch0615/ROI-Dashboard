#!/usr/bin/env node
//
// One-shot migration from the original ad-genius-tracker Supabase
// Postgres into our local SQLite. Two auth modes — pick one:
//
// === Mode A: sign in as the user (no dashboard access needed) ===
//   SUPABASE_URL          e.g. https://pxlgkpuaaptbubsnvfkz.supabase.co
//   SUPABASE_ANON_KEY     the publishable key (already in tracker/.env
//                         as VITE_SUPABASE_PUBLISHABLE_KEY)
//   SOURCE_EMAIL          the email used to log into ad-genius-tracker
//   SOURCE_PASSWORD       that account's password
//
//   The script POSTs to /auth/v1/token?grant_type=password, gets a
//   user JWT, and uses it for all subsequent reads. Supabase RLS
//   returns only the rows that user can see — which is exactly the
//   data we want to migrate.
//
// === Mode B: service-role key (bypasses RLS, needs dashboard access) ===
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   the long eyJ... JWT from Project
//                               Settings > API > service_role
//   SOURCE_USER_ID              the Supabase auth.users UUID
//
// Required for either mode:
//   ENCRYPTION_KEY    must match backend/.env (re-encrypts refresh_token)
//
// Optional:
//   TARGET_USER_ID    integer id in our users table (default 1)
//   TABLES            csv subset, e.g. "google_accounts,sites"
//   DRY_RUN           "true" to print counts without writing
//
// Usage examples at bottom of this file.

const path = require('path');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SOURCE_EMAIL = process.env.SOURCE_EMAIL;
const SOURCE_PASSWORD = process.env.SOURCE_PASSWORD;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TARGET_USER_ID = Number(process.env.TARGET_USER_ID ?? 1);
const DRY_RUN = process.env.DRY_RUN === 'true';
const TABLES_FILTER = process.env.TABLES ? new Set(process.env.TABLES.split(',').map((s) => s.trim())) : null;

function die(msg) {
  console.error(`[migrate] ${msg}`);
  process.exit(1);
}

if (!SUPABASE_URL) die('SUPABASE_URL is required');
if (!process.env.ENCRYPTION_KEY) die('ENCRYPTION_KEY is required (must match backend/.env)');

// Determine auth mode.
const passwordMode = SOURCE_EMAIL && SOURCE_PASSWORD && SUPABASE_ANON_KEY;
const serviceRoleMode = SUPABASE_SERVICE_ROLE_KEY && process.env.SOURCE_USER_ID;
if (!passwordMode && !serviceRoleMode) {
  die(
    'Auth mode unclear. For password mode set SOURCE_EMAIL + SOURCE_PASSWORD + SUPABASE_ANON_KEY. For service-role mode set SUPABASE_SERVICE_ROLE_KEY + SOURCE_USER_ID.',
  );
}

const db = require('../src/db/database');
const { encrypt } = require('../src/lib/crypto');

// Resolved at runtime by signInWithPassword() (password mode) or by env
// (service-role mode). All sbFetch calls share these.
let API_KEY = null;        // apikey header (anon key or service-role key)
let BEARER = null;         // Authorization header (user JWT or service-role key)
let SOURCE_USER_ID = null; // Julio's auth.users.id

async function signInWithPassword() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ email: SOURCE_EMAIL, password: SOURCE_PASSWORD }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    die(`Sign-in failed: ${data.error_description ?? data.error ?? res.status} (${data.msg ?? data.message ?? ''})`);
  }
  if (!data.access_token || !data.user?.id) {
    die(`Sign-in response missing access_token/user.id: ${JSON.stringify(data).slice(0, 200)}`);
  }
  API_KEY = SUPABASE_ANON_KEY;
  BEARER = data.access_token;
  SOURCE_USER_ID = data.user.id;
  console.log(`[migrate] signed in as ${SOURCE_EMAIL} (user_id=${SOURCE_USER_ID})`);
}

function useServiceRole() {
  API_KEY = SUPABASE_SERVICE_ROLE_KEY;
  BEARER = SUPABASE_SERVICE_ROLE_KEY;
  SOURCE_USER_ID = process.env.SOURCE_USER_ID;
}

async function sbFetch(table, { filterByUser = true, select = '*', extra = '' } = {}) {
  // page through the result set 1000 rows at a time using the Range header
  const all = [];
  let from = 0;
  const pageSize = 1000;
  // In password mode, RLS already scopes results to the signed-in user,
  // so the explicit user_id filter is redundant but harmless.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userFilter = filterByUser ? `&user_id=eq.${SOURCE_USER_ID}` : '';
    const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${userFilter}${extra}`;
    const res = await fetch(url, {
      headers: {
        apikey: API_KEY,
        Authorization: `Bearer ${BEARER}`,
        Range: `${from}-${from + pageSize - 1}`,
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) {
      throw new Error(`${table} fetch ${res.status}: ${(await res.text()).slice(0, 240)}`);
    }
    const rows = await res.json();
    all.push(...rows);
    if (rows.length < pageSize) return all;
    from += pageSize;
  }
}

// Per-table migrators. Each returns { read, written } counts.
const migrators = {
  google_accounts: async () => {
    const src = await sbFetch('google_accounts');
    if (DRY_RUN) return { read: src.length, written: 0 };
    const upsert = db.prepare(`
      INSERT INTO google_accounts (
        id, user_id, customer_id, login_customer_id, account_name,
        descriptive_name, currency, manager_account_id, is_mcc,
        refresh_token_enc, refresh_token_iv, refresh_token_tag,
        status, last_synced_at, created_at
      ) VALUES (
        @id, @user_id, @customer_id, @login_customer_id, @account_name,
        @descriptive_name, @currency, @manager_account_id, @is_mcc,
        @refresh_token_enc, @refresh_token_iv, @refresh_token_tag,
        @status, @last_synced_at, COALESCE(@created_at, CURRENT_TIMESTAMP)
      )
      ON CONFLICT(user_id, customer_id) DO UPDATE SET
        login_customer_id = excluded.login_customer_id,
        account_name      = excluded.account_name,
        descriptive_name  = excluded.descriptive_name,
        currency          = excluded.currency,
        manager_account_id = excluded.manager_account_id,
        is_mcc            = excluded.is_mcc,
        refresh_token_enc = COALESCE(excluded.refresh_token_enc, google_accounts.refresh_token_enc),
        refresh_token_iv  = COALESCE(excluded.refresh_token_iv,  google_accounts.refresh_token_iv),
        refresh_token_tag = COALESCE(excluded.refresh_token_tag, google_accounts.refresh_token_tag),
        status            = excluded.status,
        last_synced_at    = excluded.last_synced_at
    `);
    let written = 0;
    const tx = db.transaction(() => {
      for (const r of src) {
        const enc = r.refresh_token
          ? encrypt(r.refresh_token)
          : { ciphertext: null, iv: null, tag: null };
        upsert.run({
          id: r.id,
          user_id: TARGET_USER_ID,
          customer_id: r.customer_id,
          login_customer_id: r.login_customer_id ?? null,
          account_name: r.account_name ?? null,
          descriptive_name: r.descriptive_name ?? null,
          currency: r.currency ?? null,
          manager_account_id: r.manager_account_id ?? null,
          is_mcc: r.is_mcc ? 1 : 0,
          refresh_token_enc: enc.ciphertext,
          refresh_token_iv: enc.iv,
          refresh_token_tag: enc.tag,
          status: r.status ?? 'connected',
          last_synced_at: r.last_synced_at ?? null,
          created_at: r.created_at ?? null,
        });
        written += 1;
      }
    });
    tx();
    return { read: src.length, written };
  },

  gam_accounts: async () => {
    const src = await sbFetch('gam_accounts');
    if (DRY_RUN) return { read: src.length, written: 0 };
    // We don't have the service_account_json from Supabase secrets;
    // status stays 'pending' until the user re-uploads. We DO migrate
    // network_code, account_name, service_account_email, currency.
    const upsert = db.prepare(`
      INSERT INTO gam_accounts (
        id, user_id, network_code, account_name, service_account_email,
        currency, status, last_synced_at, created_at
      ) VALUES (
        @id, @user_id, @network_code, @account_name, @service_account_email,
        @currency, @status, @last_synced_at, COALESCE(@created_at, CURRENT_TIMESTAMP)
      )
      ON CONFLICT(user_id, network_code) DO UPDATE SET
        account_name = excluded.account_name,
        service_account_email = excluded.service_account_email,
        currency     = excluded.currency,
        last_synced_at = excluded.last_synced_at
    `);
    let written = 0;
    const tx = db.transaction(() => {
      for (const r of src) {
        upsert.run({
          id: r.id,
          user_id: TARGET_USER_ID,
          network_code: r.network_code,
          account_name: r.account_name ?? null,
          service_account_email: r.service_account_email ?? null,
          currency: r.gam_currency ?? r.currency ?? null,
          status: r.status ?? 'pending',
          last_synced_at: r.last_synced_at ?? null,
          created_at: r.created_at ?? null,
        });
        written += 1;
      }
    });
    tx();
    return { read: src.length, written };
  },

  sites: async () => {
    const src = await sbFetch('sites');
    if (DRY_RUN) return { read: src.length, written: 0 };
    const upsert = db.prepare(`
      INSERT INTO sites (id, user_id, name, domain, created_at)
      VALUES (@id, @user_id, @name, @domain, COALESCE(@created_at, CURRENT_TIMESTAMP))
      ON CONFLICT(user_id, name) DO UPDATE SET domain = excluded.domain
    `);
    let written = 0;
    const tx = db.transaction(() => {
      for (const r of src) {
        upsert.run({
          id: r.id,
          user_id: TARGET_USER_ID,
          name: r.name,
          domain: r.domain ?? null,
          created_at: r.created_at ?? null,
        });
        written += 1;
      }
    });
    tx();
    return { read: src.length, written };
  },

  account_site_links: async () => {
    const src = await sbFetch('account_site_links');
    if (DRY_RUN) return { read: src.length, written: 0 };
    const upsert = db.prepare(`
      INSERT OR IGNORE INTO account_site_links (
        id, user_id, site_id, google_account_id, gam_account_id, created_at
      ) VALUES (
        @id, @user_id, @site_id, @google_account_id, @gam_account_id,
        COALESCE(@created_at, CURRENT_TIMESTAMP)
      )
    `);
    let written = 0;
    const tx = db.transaction(() => {
      for (const r of src) {
        upsert.run({
          id: r.id,
          user_id: TARGET_USER_ID,
          site_id: r.site_id,
          google_account_id: r.google_account_id ?? null,
          gam_account_id: r.gam_account_id ?? null,
          created_at: r.created_at ?? null,
        });
        written += 1;
      }
    });
    tx();
    return { read: src.length, written };
  },

  campaigns: async () => {
    const src = await sbFetch('campaigns');
    if (DRY_RUN) return { read: src.length, written: 0 };
    const upsert = db.prepare(`
      INSERT INTO campaigns (
        id, user_id, google_account_id, campaign_id, name, status,
        channel_type, budget_micros, target_cpa_micros, created_at, updated_at
      ) VALUES (
        @id, @user_id, @google_account_id, @campaign_id, @name, @status,
        @channel_type, @budget_micros, @target_cpa_micros,
        COALESCE(@created_at, CURRENT_TIMESTAMP),
        COALESCE(@updated_at, CURRENT_TIMESTAMP)
      )
      ON CONFLICT(user_id, google_account_id, campaign_id) DO UPDATE SET
        name = excluded.name,
        status = excluded.status,
        channel_type = excluded.channel_type,
        budget_micros = excluded.budget_micros,
        target_cpa_micros = excluded.target_cpa_micros,
        updated_at = excluded.updated_at
    `);
    let written = 0;
    let skipped = 0;
    const tx = db.transaction(() => {
      for (const r of src) {
        if (!r.google_account_id) {
          skipped += 1; // schema requires it now; the original had it nullable
          continue;
        }
        upsert.run({
          id: r.id,
          user_id: TARGET_USER_ID,
          google_account_id: r.google_account_id,
          campaign_id: r.campaign_id,
          name: r.name ?? r.campaign_id,
          status: r.status ?? 'enabled',
          channel_type: r.channel_type ?? 'DISPLAY',
          budget_micros: r.budget_micros ?? null,
          target_cpa_micros: r.target_cpa_micros ?? null,
          created_at: r.created_at ?? null,
          updated_at: r.updated_at ?? null,
        });
        written += 1;
      }
    });
    tx();
    return { read: src.length, written, skipped_no_google_account: skipped };
  },

  daily_metrics: async () => {
    const src = await sbFetch('daily_metrics');
    if (DRY_RUN) return { read: src.length, written: 0 };
    const upsert = db.prepare(`
      INSERT INTO daily_metrics (
        id, user_id, google_account_id, campaign_id, date,
        spend, clicks, conversions, impressions,
        revenue, profit, roi, roas, ecpm,
        created_at, updated_at
      ) VALUES (
        @id, @user_id, @google_account_id, @campaign_id, @date,
        @spend, @clicks, @conversions, @impressions,
        @revenue, @profit, @roi, @roas, @ecpm,
        COALESCE(@created_at, CURRENT_TIMESTAMP),
        COALESCE(@updated_at, CURRENT_TIMESTAMP)
      )
      ON CONFLICT(user_id, google_account_id, campaign_id, date) DO UPDATE SET
        spend = excluded.spend,
        clicks = excluded.clicks,
        conversions = excluded.conversions,
        impressions = excluded.impressions,
        revenue = excluded.revenue,
        profit = excluded.profit,
        roi = excluded.roi,
        roas = excluded.roas,
        ecpm = excluded.ecpm,
        updated_at = excluded.updated_at
    `);
    let written = 0;
    const tx = db.transaction(() => {
      for (const r of src) {
        upsert.run({
          id: r.id,
          user_id: TARGET_USER_ID,
          google_account_id: r.google_account_id ?? null,
          campaign_id: r.campaign_id,
          date: r.date,
          spend: Number(r.spend ?? 0),
          clicks: Number(r.clicks ?? 0),
          conversions: Number(r.conversions ?? 0),
          impressions: Number(r.impressions ?? 0),
          revenue: Number(r.revenue ?? 0),
          profit: Number(r.profit ?? 0),
          roi: Number(r.roi ?? 0),
          roas: Number(r.roas ?? 0),
          ecpm: Number(r.ecpm ?? 0),
          created_at: r.created_at ?? null,
          updated_at: r.updated_at ?? null,
        });
        written += 1;
      }
    });
    tx();
    return { read: src.length, written };
  },

  placements: async () => {
    const src = await sbFetch('placements');
    if (DRY_RUN) return { read: src.length, written: 0 };
    // placements in the original schema didn't reference a specific GAM
    // account — but our schema NOT NULLs gam_account_id. If the source
    // doesn't carry it, we need a fallback: the user's first GAM account.
    const fallbackGam = db
      .prepare(`SELECT id FROM gam_accounts WHERE user_id = ? ORDER BY created_at LIMIT 1`)
      .get(TARGET_USER_ID);
    const upsert = db.prepare(`
      INSERT INTO placements (
        id, user_id, gam_account_id, campaign_id, placement_key,
        site, ad_unit, date, impressions, revenue, ecpm, created_at
      ) VALUES (
        @id, @user_id, @gam_account_id, @campaign_id, @placement_key,
        @site, @ad_unit, @date, @impressions, @revenue, @ecpm,
        COALESCE(@created_at, CURRENT_TIMESTAMP)
      )
      ON CONFLICT(user_id, gam_account_id, placement_key, date) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        site        = excluded.site,
        ad_unit     = excluded.ad_unit,
        impressions = excluded.impressions,
        revenue     = excluded.revenue,
        ecpm        = excluded.ecpm
    `);
    let written = 0;
    let skipped = 0;
    const tx = db.transaction(() => {
      for (const r of src) {
        const gamId = r.gam_account_id ?? fallbackGam?.id;
        if (!gamId) {
          skipped += 1;
          continue;
        }
        upsert.run({
          id: r.id,
          user_id: TARGET_USER_ID,
          gam_account_id: gamId,
          campaign_id: r.campaign_id ?? null,
          placement_key: r.placement_key,
          site: r.site ?? null,
          ad_unit: r.ad_unit ?? null,
          date: r.date,
          impressions: Number(r.impressions ?? 0),
          revenue: Number(r.revenue ?? 0),
          ecpm: Number(r.ecpm ?? 0),
          created_at: r.created_at ?? null,
        });
        written += 1;
      }
    });
    tx();
    return { read: src.length, written, skipped_no_gam_account: skipped };
  },

  rules_config: async () => {
    const src = await sbFetch('rules_config');
    if (DRY_RUN) return { read: src.length, written: 0 };
    if (src.length === 0) return { read: 0, written: 0 };
    const r = src[0]; // 1 row per user in the source
    const upsert = db.prepare(`
      INSERT INTO rules_config (
        user_id,
        min_roi_pct, max_loss_roi_pct, boost_roi_pct, min_spend_threshold,
        budget_increase_pct, revenue_share_pct,
        auto_analysis_days, auto_scale_interval_days, auto_stoploss_days,
        auto_cpa_review_days, auto_standby_enter_days, auto_standby_max_days,
        auto_scale_min_roi, auto_scale_budget_pct, auto_stoploss_min_roi,
        auto_stoploss_min_cost, auto_cpa_up_pct, auto_cpa_down_pct,
        auto_standby_roi_low, auto_standby_roi_high, auto_standby_exit_roi,
        auto_pause_enabled, auto_boost_enabled
      ) VALUES (
        @user_id,
        @min_roi_pct, @max_loss_roi_pct, @boost_roi_pct, @min_spend_threshold,
        @budget_increase_pct, @revenue_share_pct,
        @auto_analysis_days, @auto_scale_interval_days, @auto_stoploss_days,
        @auto_cpa_review_days, @auto_standby_enter_days, @auto_standby_max_days,
        @auto_scale_min_roi, @auto_scale_budget_pct, @auto_stoploss_min_roi,
        @auto_stoploss_min_cost, @auto_cpa_up_pct, @auto_cpa_down_pct,
        @auto_standby_roi_low, @auto_standby_roi_high, @auto_standby_exit_roi,
        @auto_pause_enabled, @auto_boost_enabled
      )
      ON CONFLICT(user_id) DO UPDATE SET
        min_roi_pct = excluded.min_roi_pct,
        max_loss_roi_pct = excluded.max_loss_roi_pct,
        boost_roi_pct = excluded.boost_roi_pct,
        min_spend_threshold = excluded.min_spend_threshold,
        budget_increase_pct = excluded.budget_increase_pct,
        revenue_share_pct = excluded.revenue_share_pct,
        auto_analysis_days = excluded.auto_analysis_days,
        auto_scale_interval_days = excluded.auto_scale_interval_days,
        auto_stoploss_days = excluded.auto_stoploss_days,
        auto_cpa_review_days = excluded.auto_cpa_review_days,
        auto_standby_enter_days = excluded.auto_standby_enter_days,
        auto_standby_max_days = excluded.auto_standby_max_days,
        auto_scale_min_roi = excluded.auto_scale_min_roi,
        auto_scale_budget_pct = excluded.auto_scale_budget_pct,
        auto_stoploss_min_roi = excluded.auto_stoploss_min_roi,
        auto_stoploss_min_cost = excluded.auto_stoploss_min_cost,
        auto_cpa_up_pct = excluded.auto_cpa_up_pct,
        auto_cpa_down_pct = excluded.auto_cpa_down_pct,
        auto_standby_roi_low = excluded.auto_standby_roi_low,
        auto_standby_roi_high = excluded.auto_standby_roi_high,
        auto_standby_exit_roi = excluded.auto_standby_exit_roi,
        auto_pause_enabled = excluded.auto_pause_enabled,
        auto_boost_enabled = excluded.auto_boost_enabled,
        updated_at = CURRENT_TIMESTAMP
    `);
    upsert.run({
      user_id: TARGET_USER_ID,
      min_roi_pct: Number(r.min_roi_pct ?? 10),
      max_loss_roi_pct: Number(r.max_loss_roi_pct ?? -20),
      boost_roi_pct: Number(r.boost_roi_pct ?? 40),
      min_spend_threshold: Number(r.min_spend_threshold ?? 50),
      budget_increase_pct: Number(r.budget_increase_pct ?? 20),
      revenue_share_pct: Number(r.revenue_share_pct ?? 6.5),
      auto_analysis_days: Number(r.auto_analysis_days ?? 15),
      auto_scale_interval_days: Number(r.auto_scale_interval_days ?? 3),
      auto_stoploss_days: Number(r.auto_stoploss_days ?? 7),
      auto_cpa_review_days: Number(r.auto_cpa_review_days ?? 3),
      auto_standby_enter_days: Number(r.auto_standby_enter_days ?? 7),
      auto_standby_max_days: Number(r.auto_standby_max_days ?? 14),
      auto_scale_min_roi: Number(r.auto_scale_min_roi ?? 30),
      auto_scale_budget_pct: Number(r.auto_scale_budget_pct ?? 20),
      auto_stoploss_min_roi: Number(r.auto_stoploss_min_roi ?? -20),
      auto_stoploss_min_cost: Number(r.auto_stoploss_min_cost ?? 0),
      auto_cpa_up_pct: Number(r.auto_cpa_up_pct ?? 10),
      auto_cpa_down_pct: Number(r.auto_cpa_down_pct ?? 10),
      auto_standby_roi_low: Number(r.auto_standby_roi_low ?? 1),
      auto_standby_roi_high: Number(r.auto_standby_roi_high ?? 10),
      auto_standby_exit_roi: Number(r.auto_standby_exit_roi ?? 10),
      auto_pause_enabled: r.auto_pause_enabled ? 1 : 0,
      auto_boost_enabled: r.auto_boost_enabled ? 1 : 0,
    });
    return { read: 1, written: 1 };
  },

  alerts: async () => {
    const src = await sbFetch('alerts');
    if (DRY_RUN) return { read: src.length, written: 0 };
    const upsert = db.prepare(`
      INSERT OR IGNORE INTO alerts (
        id, user_id, severity, category, campaign_id, placement_key,
        title, message, metric_snapshot, acknowledged, created_at
      ) VALUES (
        @id, @user_id, @severity, @category, @campaign_id, @placement_key,
        @title, @message, @metric_snapshot, @acknowledged,
        COALESCE(@created_at, CURRENT_TIMESTAMP)
      )
    `);
    let written = 0;
    const tx = db.transaction(() => {
      for (const r of src) {
        upsert.run({
          id: r.id,
          user_id: TARGET_USER_ID,
          severity: r.severity ?? 'warning',
          category: r.category ?? 'risk',
          campaign_id: r.campaign_id ?? null,
          placement_key: r.placement_key ?? null,
          title: r.title ?? '(sem título)',
          message: r.message ?? null,
          metric_snapshot: r.metric_snapshot ? JSON.stringify(r.metric_snapshot) : null,
          acknowledged: r.acknowledged ? 1 : 0,
          created_at: r.created_at ?? null,
        });
        written += 1;
      }
    });
    tx();
    return { read: src.length, written };
  },
};

const ORDER = [
  'google_accounts',
  'gam_accounts',
  'sites',
  'account_site_links',
  'campaigns',
  'daily_metrics',
  'placements',
  'rules_config',
  'alerts',
];

(async () => {
  if (passwordMode) await signInWithPassword();
  else useServiceRole();
  console.log(`[migrate] source=${SUPABASE_URL} src_user=${SOURCE_USER_ID} -> target_user=${TARGET_USER_ID}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  if (TABLES_FILTER) console.log(`[migrate] tables filter: ${[...TABLES_FILTER].join(',')}`);
  const summary = [];
  for (const t of ORDER) {
    if (TABLES_FILTER && !TABLES_FILTER.has(t)) continue;
    process.stdout.write(`  ${t.padEnd(22)} `);
    try {
      const r = await migrators[t]();
      summary.push({ table: t, ...r });
      console.log(`read=${r.read} written=${r.written}${r.skipped_no_google_account ? ` skipped(no_ga)=${r.skipped_no_google_account}` : ''}${r.skipped_no_gam_account ? ` skipped(no_gam)=${r.skipped_no_gam_account}` : ''}`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      summary.push({ table: t, error: err.message });
    }
  }
  console.log('');
  console.log('[migrate] summary:');
  for (const r of summary) {
    if (r.error) console.log(`  ${r.table.padEnd(22)} ERROR: ${r.error}`);
    else console.log(`  ${r.table.padEnd(22)} +${r.written} (read ${r.read})`);
  }
  console.log('');
  console.log('[migrate] done. Run the rollup to recompute ROI/profit:');
  console.log("  curl -s -X POST http://127.0.0.1:4000/api/sync/rollup -H 'Content-Type: application/json' -b cookies.txt -d '{}'");
})();
