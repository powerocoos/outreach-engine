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
  subject TEXT NOT NULL,
  email1 TEXT NOT NULL,
  email2 TEXT NOT NULL,
  email3 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  edited INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT,             -- UTC ISO time to auto-publish (booked as 9:00 AM Eastern on approval)
  attempts INTEGER NOT NULL DEFAULT 0,
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
