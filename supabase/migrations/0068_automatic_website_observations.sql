-- Machine observations are separate from owner-reviewed website assessments.
-- No outbound or qualification function reads this table.
alter table public.website_audit_observations
 add constraint website_audit_observations_org_lead_id_key unique(org_id,lead_id,id);

create table public.lead_website_observations (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 source_fingerprint text not null check(length(source_fingerprint)=64),
 state text not null check(state in ('recorded_url_reachable','proposed_unconfirmed','unknown')),
 recorded_url text,
 checked_url text,
 audit_observation_id uuid,
 http_status integer,
 proposed_website_url text,
 proposal_source_url text,
 reason text not null check(length(trim(reason)) between 20 and 500),
 confidence numeric(4,3) not null check(confidence between 0 and 1),
 observed_at timestamptz not null,
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 foreign key(org_id,lead_id,audit_observation_id)
  references public.website_audit_observations(org_id,lead_id,id),
 unique(org_id,lead_id,source_fingerprint),
 check(recorded_url is null or recorded_url ~ '^https?://[^ /]+'),
 check(checked_url is null or checked_url ~ '^https?://[^ /]+'),
 check(proposed_website_url is null or proposed_website_url ~ '^https://[^ /]+'),
 check(proposal_source_url is null or proposal_source_url ~ '^https://[^ /]+'),
 check(state<>'recorded_url_reachable' or
  (recorded_url is not null and checked_url is not null and checked_url=recorded_url
   and audit_observation_id is not null and http_status is not null
   and http_status between 200 and 299 and proposed_website_url is null)),
 check(state<>'proposed_unconfirmed' or
  (recorded_url is null and proposed_website_url is not null and proposal_source_url is not null
   and audit_observation_id is null))
);
create index lead_website_observations_latest
 on public.lead_website_observations(org_id,lead_id,observed_at desc);
alter table public.lead_website_observations enable row level security;
create policy website_observations_read on public.lead_website_observations
 for select to authenticated using(private.is_org_member(org_id));
revoke all on public.lead_website_observations from public,anon,authenticated;
grant select on public.lead_website_observations to authenticated;
grant select,insert on public.lead_website_observations to service_role;
