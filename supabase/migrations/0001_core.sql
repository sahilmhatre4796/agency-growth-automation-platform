-- ChainCraft Sales Command Center — M0 draft schema. APPLY ONLY ON DISPOSABLE DEV DATABASE.
-- Requires Supabase PostgreSQL with auth.users. OAuth secrets intentionally excluded.
create extension if not exists pgcrypto;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  outbound_paused boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','sales','analyst')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  business_name text not null,
  website_url text,
  normalized_domain text,
  source_type text not null check (source_type in ('inbound','referral','manual','csv','approved_source','meta_form')),
  source_url text,
  source_observed_at timestamptz,
  status text not null default 'new' check (status in ('new','researching','qualified','contacted','replied','meeting_booked','proposal_sent','won','lost','disqualified')),
  business_category text,
  needs text,
  owner_user_id uuid references auth.users(id),
  deal_value_paise bigint check (deal_value_paise is null or deal_value_paise >= 0),
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_org_stage_idx on public.leads(org_id,status,updated_at desc);
create index leads_org_domain_idx on public.leads(org_id,normalized_domain) where normalized_domain is not null;

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  contact_name text,
  email text,
  email_normalized text,
  phone_e164 text,
  role text,
  source_url text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint contact_endpoint check (email is not null or phone_e164 is not null)
);
create index contacts_org_email_idx on public.contacts(org_id,email_normalized) where email_normalized is not null;
create index contacts_org_lead_idx on public.contacts(org_id,lead_id);

create table public.lead_evidence (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  source_url text,
  source_type text not null,
  observed_at timestamptz not null,
  claim text not null,
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index lead_evidence_org_lead_idx on public.lead_evidence(org_id,lead_id,observed_at desc);

create table public.lead_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  score smallint not null check (score between 0 and 100),
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  score_version text not null,
  breakdown jsonb not null default '{}'::jsonb,
  evidence_ids uuid[] not null default '{}'::uuid[],
  ai_model_id text,
  created_at timestamptz not null default now()
);
create index lead_scores_org_lead_idx on public.lead_scores(org_id,lead_id,created_at desc);

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp')),
  state text not null check (state in ('unknown','permitted','opted_in','opted_out','unsubscribed','blocked','complained')),
  purpose text,
  source text not null,
  evidence_ref text,
  recorded_at timestamptz not null default now(),
  revoked_at timestamptz,
  recorded_by uuid references auth.users(id)
);
create index consent_contact_channel_idx on public.consent_records(org_id,contact_id,channel,recorded_at desc);

create table public.suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  channel text not null check (channel in ('email','whatsapp','all')),
  identifier_hash text not null, -- keyed/HMAC hash should be generated server-side; do not store raw identifier here
  reason text not null,
  recorded_at timestamptz not null default now(),
  unique (org_id, channel, identifier_hash)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  channel text not null check (channel in ('email','whatsapp')),
  state text not null default 'draft' check (state in ('draft','paused','active','archived')),
  daily_send_cap integer not null default 0 check (daily_send_cap >= 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.outbound_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid references public.campaigns(id),
  lead_id uuid not null references public.leads(id),
  contact_id uuid not null references public.contacts(id),
  channel text not null check (channel in ('email','whatsapp')),
  subject text,
  body text not null,
  evidence_ids uuid[] not null default '{}'::uuid[],
  state text not null default 'draft' check (state in ('draft','needs_review','approved','rejected','queued','sent','suppressed','failed')),
  approval_by uuid references auth.users(id),
  approved_at timestamptz,
  approved_sha256 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbound_drafts_org_state_idx on public.outbound_drafts(org_id,state,created_at desc);

create table public.message_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id),
  contact_id uuid references public.contacts(id),
  draft_id uuid references public.outbound_drafts(id),
  provider text not null,
  provider_message_id text,
  provider_thread_id text,
  direction text not null check (direction in ('inbound','outbound')),
  event_type text not null,
  event_at timestamptz not null default now(),
  safe_metadata jsonb not null default '{}'::jsonb,
  unique (org_id,provider,provider_message_id,event_type)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null,
  state text not null default 'queued' check (state in ('queued','leased','completed','failed','suppressed','cancelled')),
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  lease_until timestamptz,
  next_run_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id,idempotency_key)
);
create index jobs_due_idx on public.jobs(next_run_at,state) where state in ('queued','leased');

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  title text not null,
  description text,
  assigned_to uuid references auth.users(id),
  due_at timestamptz,
  state text not null default 'open' check (state in ('open','done','cancelled')),
  created_at timestamptz not null default now()
);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id),
  attendee_contact_id uuid references public.contacts(id),
  provider text,
  provider_event_id text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  state text not null default 'proposed' check (state in ('proposed','confirmed','cancelled','completed')),
  created_at timestamptz not null default now(),
  constraint appointment_time_valid check (ends_at > starts_at)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  entity_table text,
  entity_id uuid,
  safe_context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index audit_org_date_idx on public.audit_events(org_id,occurred_at desc);

comment on schema public is 'Do not run this draft migration in production without test review of org scoping, foreign-key org consistency, and privileged-write paths.';
