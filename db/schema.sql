create table if not exists videos (
  id bigserial primary key,
  status text not null default 'planned',
  attempts int not null default 0,
  repairs int not null default 0,
  predicted_score numeric,
  actual_score numeric,
  sub_niche text not null,
  structure text not null,
  topic jsonb,
  dossier jsonb,
  script jsonb,
  verification jsonb,
  scene_timings jsonb,
  title text,
  youtube_id text,
  short_youtube_id text,
  assets jsonb,
  issue_number int,
  publish_slot jsonb,
  publish_at timestamptz,
  short_publish_at timestamptz,
  short_status text not null default 'none',
  rejection_reason text,
  usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists videos_status_idx on videos(status);
create unique index if not exists videos_issue_idx on videos(issue_number) where issue_number is not null;

create table if not exists metrics_daily (
  video_id bigint not null references videos(id),
  day date not null,
  views int, watch_minutes numeric, avg_view_sec numeric, avg_view_pct numeric,
  likes int, comments int, subs_gained int,
  primary key (video_id, day)
);

create table if not exists retention (
  video_id bigint not null references videos(id),
  elapsed_ratio numeric not null,
  watch_ratio numeric, relative_perf numeric,
  primary key (video_id, elapsed_ratio)
);

create table if not exists incidents (
  id bigserial primary key,
  video_id bigint,
  stage text not null,
  message text not null,
  detail text,
  created_at timestamptz not null default now()
);

create table if not exists playbook_versions (
  id bigserial primary key,
  content text not null,
  weights jsonb not null,
  rationale text,
  created_at timestamptz not null default now()
);

-- idempotent upgrades for databases created by earlier versions
alter table videos add column if not exists short_youtube_id text;
alter table videos add column if not exists assets jsonb;
alter table videos add column if not exists repairs int not null default 0;
alter table videos add column if not exists predicted_score numeric;
alter table videos add column if not exists actual_score numeric;
alter table videos add column if not exists short_publish_at timestamptz;
alter table videos add column if not exists short_status text not null default 'none';
