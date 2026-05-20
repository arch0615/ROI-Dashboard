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

### Two auth modes

Pick whichever you can actually use.

#### Mode A — sign in as the user (no dashboard access needed) ★ recommended

The script POSTs `/auth/v1/token?grant_type=password` to log in as Julio,
gets a user JWT back, and uses it for all reads. RLS returns exactly his
rows — which is what we want.

Needs:
- `SUPABASE_URL` — from `ad-genius-tracker/.env`
- `SUPABASE_ANON_KEY` — the `VITE_SUPABASE_PUBLISHABLE_KEY` value from
  `ad-genius-tracker/.env`
- `SOURCE_EMAIL` — Julio's login email for ad-genius-tracker
- `SOURCE_PASSWORD` — his password
- `ENCRYPTION_KEY` — from our backend's `.env` (so refresh_tokens decrypt later)

```bash
cd /home/ad-genius/backend

# Pull URL + anon key out of the tracker's .env automatically
TRACKER_ENV=/home/ad-genius-tracker/.env
SUPABASE_URL=$(grep '^VITE_SUPABASE_URL=' $TRACKER_ENV | cut -d= -f2- | tr -d '"')
SUPABASE_ANON_KEY=$(grep '^VITE_SUPABASE_PUBLISHABLE_KEY=' $TRACKER_ENV | cut -d= -f2- | tr -d '"')
ENCRYPTION_KEY=$(grep '^ENCRYPTION_KEY=' .env | cut -d= -f2)

# Dry run first — counts only, no writes
DRY_RUN=true \
  SUPABASE_URL=$SUPABASE_URL \
  SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY \
  ENCRYPTION_KEY=$ENCRYPTION_KEY \
  SOURCE_EMAIL='julio@example.com' \
  SOURCE_PASSWORD='his-real-password' \
  node scripts/migrate-from-supabase.js

# Real run — drop DRY_RUN
SUPABASE_URL=$SUPABASE_URL \
  SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY \
  ENCRYPTION_KEY=$ENCRYPTION_KEY \
  SOURCE_EMAIL='julio@example.com' \
  SOURCE_PASSWORD='his-real-password' \
  node scripts/migrate-from-supabase.js
```

#### Mode B — service-role key (needs Supabase dashboard access)

```bash
SUPABASE_URL=https://pxlgkpuaaptbubsnvfkz.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...PASTE_FULL_JWT \
  SOURCE_USER_ID=00000000-0000-0000-0000-000000000000 \
  ENCRYPTION_KEY=$(grep ENCRYPTION_KEY .env | cut -d= -f2) \
  node scripts/migrate-from-supabase.js
```

### After the migration

⚠️ **Do NOT run the rollup against migrated-only data.** The original
`placements` table has no `gam_account_id` column, so the script assigns
every imported placement to a single fallback GAM account (the user's first
one). The rollup's site→GAM join then fails to attribute revenue to sites
linked to the *other* GAM accounts, and it would overwrite the migrated
`daily_metrics.revenue` / `profit` / `roi` values with zeros. The migrated
`daily_metrics` already carries the correct revenue/profit values from the
old system — leave them alone.

Once Julio reconnects via OAuth and a fresh GAM sync runs, the new
`placements` rows DO carry `gam_account_id` and the rollup works as intended.
Rule of thumb: rollup is safe only when the placements in scope all came
from a real sync (not from migration).

To recompute derived columns when that's true (post-fresh-sync):

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
