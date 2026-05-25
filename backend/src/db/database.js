const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Idempotent ALTER TABLE ADD COLUMN. CREATE TABLE IF NOT EXISTS below
// handles fresh DBs, but pre-existing DBs need column-level migrations
// for new fields. We add columns here BEFORE the CREATE TABLE block so
// callers below can rely on the final shape.
function addColumnIfMissing(table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
try {
  addColumnIfMissing('gam_accounts', 'utm_key_id', 'TEXT');
  addColumnIfMissing('gam_accounts', 'utm_key_name', 'TEXT');
  addColumnIfMissing('gam_accounts', 'utm_placement_key_id', 'TEXT');
  addColumnIfMissing('gam_accounts', 'utm_placement_key_name', 'TEXT');
} catch (err) {
  // Tables may not exist on a fresh DB — that's fine, CREATE TABLE below
  // will use the new shape. Only surfaces when a missing column blocks
  // a table that *does* exist.
  if (!String(err.message).includes('no such table')) throw err;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS site_memberships (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    site_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, site_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_site_memberships_user ON site_memberships(user_id);

  CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

  -- Data tables mirror the original Supabase schema. TEXT UUID PKs so IDs
  -- round-trip during M4 data migration. JSON columns stored as TEXT.

  CREATE TABLE IF NOT EXISTS google_accounts (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    customer_id TEXT NOT NULL,
    login_customer_id TEXT,
    account_name TEXT,
    descriptive_name TEXT,
    currency TEXT,
    manager_account_id TEXT,
    is_mcc INTEGER NOT NULL DEFAULT 0,
    refresh_token_enc TEXT,
    refresh_token_iv TEXT,
    refresh_token_tag TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, customer_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_google_accounts_user ON google_accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_google_accounts_mgr ON google_accounts(manager_account_id);

  CREATE TABLE IF NOT EXISTS gam_accounts (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    network_code TEXT NOT NULL,
    account_name TEXT,
    service_account_email TEXT,
    service_account_json_enc TEXT,
    service_account_json_iv TEXT,
    service_account_json_tag TEXT,
    currency TEXT,
    utm_key_id TEXT,
    utm_key_name TEXT,
    utm_placement_key_id TEXT,
    utm_placement_key_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, network_code),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_gam_accounts_user ON gam_accounts(user_id);

  CREATE TABLE IF NOT EXISTS utm_revenue (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    gam_account_id TEXT NOT NULL,
    ga_campaign_id TEXT NOT NULL,
    date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, gam_account_id, ga_campaign_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gam_account_id) REFERENCES gam_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_utm_revenue_user_date ON utm_revenue(user_id, date DESC);
  CREATE INDEX IF NOT EXISTS idx_utm_revenue_campaign ON utm_revenue(user_id, ga_campaign_id, date);

  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    domain TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sites_user ON sites(user_id);

  CREATE TABLE IF NOT EXISTS account_site_links (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    site_id TEXT NOT NULL,
    google_account_id TEXT,
    gam_account_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE CASCADE,
    FOREIGN KEY (google_account_id) REFERENCES google_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (gam_account_id) REFERENCES gam_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_links_site ON account_site_links(site_id);
  CREATE INDEX IF NOT EXISTS idx_links_google ON account_site_links(google_account_id);

  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    google_account_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'enabled',
    channel_type TEXT DEFAULT 'DISPLAY',
    budget_micros INTEGER,
    target_cpa_micros INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, google_account_id, campaign_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (google_account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_campaigns_user ON campaigns(user_id);
  CREATE INDEX IF NOT EXISTS idx_campaigns_account ON campaigns(google_account_id);

  CREATE TABLE IF NOT EXISTS placements (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    gam_account_id TEXT NOT NULL,
    campaign_id TEXT,
    placement_key TEXT NOT NULL,
    site TEXT,
    ad_unit TEXT,
    date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    ecpm REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, gam_account_id, placement_key, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gam_account_id) REFERENCES gam_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_placements_user_date ON placements(user_id, date);
  CREATE INDEX IF NOT EXISTS idx_placements_campaign ON placements(user_id, campaign_id);
  CREATE INDEX IF NOT EXISTS idx_placements_gam_account ON placements(gam_account_id);

  CREATE TABLE IF NOT EXISTS daily_metrics (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    google_account_id TEXT,
    campaign_id TEXT NOT NULL,
    date TEXT NOT NULL,
    spend REAL NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    profit REAL NOT NULL DEFAULT 0,
    roi REAL NOT NULL DEFAULT 0,
    roas REAL NOT NULL DEFAULT 0,
    ecpm REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, google_account_id, campaign_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_daily_metrics_user_date ON daily_metrics(user_id, date DESC);
  CREATE INDEX IF NOT EXISTS idx_daily_metrics_campaign ON daily_metrics(user_id, campaign_id, date DESC);

  CREATE TABLE IF NOT EXISTS rules_config (
    user_id INTEGER PRIMARY KEY,
    -- Core ROI thresholds
    min_roi_pct REAL NOT NULL DEFAULT 10,
    max_loss_roi_pct REAL NOT NULL DEFAULT -20,
    boost_roi_pct REAL NOT NULL DEFAULT 40,
    min_spend_threshold REAL NOT NULL DEFAULT 50,
    budget_increase_pct REAL NOT NULL DEFAULT 20,
    revenue_share_pct REAL NOT NULL DEFAULT 6.5,
    -- Automation: time windows (days)
    auto_analysis_days INTEGER NOT NULL DEFAULT 15,
    auto_scale_interval_days INTEGER NOT NULL DEFAULT 3,
    auto_stoploss_days INTEGER NOT NULL DEFAULT 7,
    auto_cpa_review_days INTEGER NOT NULL DEFAULT 3,
    auto_standby_enter_days INTEGER NOT NULL DEFAULT 7,
    auto_standby_max_days INTEGER NOT NULL DEFAULT 14,
    -- Automation: thresholds
    auto_scale_min_roi REAL NOT NULL DEFAULT 30,
    auto_scale_budget_pct REAL NOT NULL DEFAULT 20,
    auto_stoploss_min_roi REAL NOT NULL DEFAULT -20,
    auto_stoploss_min_cost REAL NOT NULL DEFAULT 0,
    auto_cpa_up_pct REAL NOT NULL DEFAULT 10,
    auto_cpa_down_pct REAL NOT NULL DEFAULT 10,
    auto_standby_roi_low REAL NOT NULL DEFAULT 1,
    auto_standby_roi_high REAL NOT NULL DEFAULT 10,
    auto_standby_exit_roi REAL NOT NULL DEFAULT 10,
    -- Execution mode
    auto_pause_enabled INTEGER NOT NULL DEFAULT 1,
    auto_boost_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Audit log for placement exclusions applied to Google Ads. Each row
  -- records ONE (campaign, placement) pair we blocked, with the ROI
  -- snapshot at apply-time so the user can see why it was blocked and
  -- the resource_name returned by campaignCriterion:mutate so we can
  -- undo (delete) it later. undone_at != NULL means the exclusion was
  -- rolled back.
  CREATE TABLE IF NOT EXISTS placement_exclusions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    google_account_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT,
    placement TEXT NOT NULL,
    criterion_resource_name TEXT,
    snapshot_cost REAL,
    snapshot_revenue REAL,
    snapshot_roi REAL,
    snapshot_days INTEGER,
    reason TEXT,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    applied_by_user_id INTEGER,
    undone_at DATETIME,
    error TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (google_account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_placement_exclusions_campaign ON placement_exclusions(user_id, campaign_id);
  CREATE INDEX IF NOT EXISTS idx_placement_exclusions_active ON placement_exclusions(user_id, undone_at);

  CREATE TABLE IF NOT EXISTS fx_rates (
    from_currency TEXT NOT NULL,
    to_currency TEXT NOT NULL,
    date TEXT NOT NULL,
    rate REAL NOT NULL,
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (from_currency, to_currency, date)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    category TEXT NOT NULL,
    campaign_id TEXT,
    placement_key TEXT,
    title TEXT NOT NULL,
    message TEXT,
    metric_snapshot TEXT,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_user_unack ON alerts(user_id, acknowledged, created_at DESC);

  -- Per-(campaign, placement, date) Ads cost from GAQL detail_placement_view.
  -- Lives separate from daily_metrics because the granularity is finer
  -- and the source is a different GAQL surface.
  CREATE TABLE IF NOT EXISTS ads_placements (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    google_account_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT,
    ad_group_id TEXT,
    ad_group_name TEXT,
    placement TEXT NOT NULL,
    placement_clean TEXT,
    display_name TEXT,
    target_url TEXT,
    placement_type TEXT,
    date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    conversions REAL NOT NULL DEFAULT 0,
    ctr REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, google_account_id, campaign_id, placement, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (google_account_id) REFERENCES google_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_ads_placements_campaign ON ads_placements(user_id, campaign_id, date);
  CREATE INDEX IF NOT EXISTS idx_ads_placements_placement ON ads_placements(user_id, placement_clean);

  -- Per-(campaign, placement, date) GAM revenue via two UTM custom dimensions.
  -- Used by the placements-cleanup preview to attribute revenue exactly to
  -- the (campaign, placement) pair (vs the single-dimension utm_revenue
  -- which only attributes to campaign).
  CREATE TABLE IF NOT EXISTS utm_revenue_placements (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    gam_account_id TEXT NOT NULL,
    ga_campaign_id TEXT NOT NULL,
    placement_value TEXT NOT NULL,
    date TEXT NOT NULL,
    impressions INTEGER NOT NULL DEFAULT 0,
    revenue REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, gam_account_id, ga_campaign_id, placement_value, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gam_account_id) REFERENCES gam_accounts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_utm_rev_pl_campaign ON utm_revenue_placements(user_id, ga_campaign_id, date);
  CREATE INDEX IF NOT EXISTS idx_utm_rev_pl_placement ON utm_revenue_placements(user_id, placement_value);

  CREATE TABLE IF NOT EXISTS sync_logs (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    records_processed INTEGER DEFAULT 0,
    error TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sync_logs_user ON sync_logs(user_id, started_at DESC);
`);

module.exports = db;
