const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
    status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, network_code),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_gam_accounts_user ON gam_accounts(user_id);

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
