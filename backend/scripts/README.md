# Backend scripts

One-shot operational scripts that aren't part of the running backend.

## migrate-from-supabase.js

Pulls Julio's data out of the original ad-genius-tracker Supabase Postgres and
writes it into our local SQLite. Idempotent — safe to re-run.

### What gets migrated

| Table                 | Notes                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------- |
| `google_accounts`     | `refresh_token` is re-encrypted with our local `ENCRYPTION_KEY` before write          |
| `gam_accounts`        | `service_account_json` lives in Supabase secrets, not the table — won't migrate       |
| `sites`               | name + domain                                                                          |
| `account_site_links`  | site ↔ google_account ↔ gam_account joins                                              |
| `campaigns`           | rows without a `google_account_id` are skipped (our schema requires it)                |
| `daily_metrics`       | spend/clicks/conversions/impressions/revenue/profit/ROI                                |
| `placements`          | falls back to the user's first GAM account if `gam_account_id` is null in source       |
| `rules_config`        | all 23 threshold + automation fields                                                   |
| `alerts`              | severity + category + ack state                                                        |

Skipped: `profiles`, `automation_actions`, `sync_logs` (operational, regenerate
locally), and anything else not in our schema yet.

### Prerequisites

You need the **service-role key** from Supabase Project Settings > API >
service_role. The anon key in `ad-genius-tracker/.env` won't work — it's
restricted by RLS and returns empty arrays without a user JWT.

You also need the **source user UUID** (Julio's `auth.users.id` in Supabase).
Find it by querying `select id from auth.users` in the SQL editor, or by
inspecting any row in `google_accounts` and copying its `user_id`.

### Run

```bash
cd /home/ad-genius/backend

# Optional: preview row counts without writing
DRY_RUN=true \
  SUPABASE_URL=https://pxlgkpuaaptbubsnvfkz.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...PASTE_FULL_JWT \
  SOURCE_USER_ID=00000000-0000-0000-0000-000000000000 \
  ENCRYPTION_KEY=$(grep ENCRYPTION_KEY .env | cut -d= -f2) \
  node scripts/migrate-from-supabase.js

# Real run — drop DRY_RUN
SUPABASE_URL=https://pxlgkpuaaptbubsnvfkz.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...PASTE_FULL_JWT \
  SOURCE_USER_ID=00000000-0000-0000-0000-000000000000 \
  ENCRYPTION_KEY=$(grep ENCRYPTION_KEY .env | cut -d= -f2) \
  node scripts/migrate-from-supabase.js
```

After it finishes, re-run the rollup so derived columns (profit/ROI/ROAS/eCPM)
recompute against the freshly migrated data:

```bash
PASS=$(grep '^DASHBOARD_PASS=' .env | cut -d= -f2)
curl -s -X POST http://127.0.0.1:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PASS\"}" \
  -c /tmp/c.txt -o /dev/null

curl -s -X POST http://127.0.0.1:4000/api/sync/rollup \
  -H 'Content-Type: application/json' \
  -b /tmp/c.txt -d '{}'
```

### Options

| Env             | Default | Purpose                                                         |
| --------------- | ------- | --------------------------------------------------------------- |
| `DRY_RUN`       | `false` | Print counts, no writes                                         |
| `TABLES`        | all     | CSV subset, e.g. `google_accounts,sites,campaigns`              |
| `TARGET_USER_ID`| `1`     | Our local user id to attach the imported rows to                |

### After GAM credentials are uploaded

`gam_accounts` migrates with `status='pending'` and `has_service_account=false`
because Service Account JSONs live in Supabase secrets, not in the table.
Re-upload each SA JSON in the Integrações page and the row flips to `active`.
