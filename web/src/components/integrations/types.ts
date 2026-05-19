export type GoogleAccount = {
  id: string;
  customer_id: string;
  login_customer_id: string | null;
  account_name: string | null;
  is_mcc: boolean;
  status: string;
  last_synced_at: string | null;
  created_at: string;
  has_refresh_token: boolean;
};

export type GamAccount = {
  id: string;
  network_code: string;
  account_name: string | null;
  service_account_email: string | null;
  status: string;
  last_synced_at: string | null;
  created_at: string;
};

export type Site = {
  id: string;
  name: string;
  domain: string | null;
  created_at: string;
};

export type AccountSiteLink = {
  id: string;
  site_id: string;
  google_account_id: string | null;
  gam_account_id: string | null;
  created_at: string;
};
