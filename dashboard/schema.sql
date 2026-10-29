CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  contact_email TEXT UNIQUE,
  phone TEXT,
  website TEXT,
  city TEXT,
  category TEXT,
  hook_angle TEXT,
  mobile_score INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  contact_email TEXT,
  event TEXT NOT NULL,          -- sent | opened | clicked | replied | bounced | unsubscribed | booked
  step INTEGER,
  campaign TEXT,
  raw TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_touches_event ON touches(event);
CREATE INDEX IF NOT EXISTS idx_touches_email ON touches(contact_email);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER REFERENCES leads(id),
  contact_email TEXT,
  call_at TEXT,
  held INTEGER NOT NULL DEFAULT 0,
  won INTEGER NOT NULL DEFAULT 0,
  value_usd INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media (
  token TEXT PRIMARY KEY,         -- unguessable id in the public link
  contact_email TEXT,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'video/mp4',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Drafts waiting for review in the dashboard (pending -> approved/rejected -> exported)
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_email TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  website TEXT,
  city TEXT,
  category TEXT,
  angle TEXT,
  mobile_score INTEGER,
  rating REAL,
  review_count INTEGER,
  findings TEXT,                 -- JSON array of verified findings
  reject_reason TEXT,
  polish INTEGER,                -- 1-5 look-and-feel rating from the screenshots            -- why a draft was rejected (polished | fit | contact | dupe | other)
  subject TEXT NOT NULL,
  email1 TEXT NOT NULL,
  email2 TEXT NOT NULL,
  email3 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  edited INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,             -- UTC ISO time to auto-publish (booked as 9:00 AM Eastern on approval)
  attempts INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'blog',   -- blog | tip | teardown
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

-- Blog posts turned into Facebook/Instagram posts (pending -> approved -> posted / rejected)
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT,
  image_url TEXT,
  categories TEXT,
  pub_date TEXT,
  link TEXT,                      -- UTM-tagged link used in the Facebook post
  fb_text TEXT NOT NULL,
  ig_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  fb_post_id TEXT,
  ig_post_id TEXT,
  error TEXT,
  edited INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,             -- UTC ISO time to auto-publish (booked as 9:00 AM Eastern on approval)
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  posted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_social_status ON social_posts(status);

-- Private screenshot pages linked from outreach emails (GET /a/<token>)
CREATE TABLE IF NOT EXISTS audit_pages (
  token TEXT PRIMARY KEY,
  contact_email TEXT,
  company TEXT NOT NULL,
  website TEXT,
  findings TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Sites the pipeline skipped because they look well kept; you can choose "send anyway"
CREATE TABLE IF NOT EXISTS skipped_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  website TEXT NOT NULL UNIQUE,
  company TEXT NOT NULL,
  city TEXT, category TEXT, rating REAL, review_count INTEGER, polish INTEGER,
  findings TEXT,
  status TEXT NOT NULL DEFAULT 'skipped',   -- skipped | send | drafted | dismissed
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);

-- Pipeline run reports and health alerts (kind: outreach | alert)
CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Replies from prospects pulled from Instantly, with a suggested answer
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL UNIQUE,
  thread_id TEXT,
  lead_email TEXT NOT NULL,
  company TEXT, subject TEXT, body TEXT, received_at TEXT,
  category TEXT,
  suggestion TEXT,
  status TEXT NOT NULL DEFAULT 'new',   -- new | done
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Wrong dashboard passwords, per address (see authGate in src/index.js). Created on first use for existing databases.
CREATE TABLE IF NOT EXISTS auth_failures (ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS auth_failures_ip_at ON auth_failures (ip, at);
