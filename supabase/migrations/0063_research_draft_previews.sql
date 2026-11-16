-- Internal research copy is deliberately separate from outbound_drafts.
-- It can never be approved, queued, or sent through the email outbox.
alter table public.business_research_reports
 add constraint business_research_reports_org_lead_id_key unique(org_id,lead_id,id);
create table public.research_draft_previews (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 report_id uuid not null,
 service_id uuid not null,
 subjects text[] not null check (cardinality(subjects)=2),
 body text not null check (length(body) between 20 and 2000),
 evidence_ids uuid[] not null check (cardinality(evidence_ids) between 1 and 4),
 confidence numeric(4,3) not null check (confidence between 0 and 1),
 state text not null default 'research_review' check (state='research_review'),
 generator text not null check (generator='grounded_template'),
 created_at timestamptz not null default now(),
 unique(org_id,report_id,service_id),
 foreign key(org_id,lead_id,report_id) references public.business_research_reports(org_id,lead_id,id) on delete cascade,
 foreign key(org_id,service_id) references public.service_catalog(org_id,id)
);
create index research_draft_previews_lead on public.research_draft_previews(org_id,lead_id,created_at desc);
alter table public.research_draft_previews enable row level security;
create policy research_draft_previews_admin_read on public.research_draft_previews for select to authenticated
 using(private.is_org_admin(org_id));
revoke all on public.research_draft_previews from public,anon,authenticated;
grant select on public.research_draft_previews to authenticated;
grant select,insert on public.research_draft_previews to service_role;
