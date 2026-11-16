-- Qualification is an explicit, reviewable record. Discovery remains disabled by default.
alter table public.leads add column state_region text;
alter table public.leads add column country text;
alter table public.leads add column business_type text;
alter table public.leads add column public_address text;
alter table public.leads add column public_phone text;
alter table public.leads add column business_description text;
alter table public.leads drop constraint leads_source_type_check;
alter table public.leads add constraint leads_source_type_check check(source_type in ('inbound','referral','manual','csv','approved_source','meta_form','serper','harvey'));
create table public.service_catalog (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 service_key text not null check(service_key ~ '^[a-z0-9_]{3,60}$'),
 name text not null check(length(trim(name)) between 3 and 120),
 description text not null default '',
 applicable_industries text[] not null default '{}',
 ideal_customer_profile text not null default '',
 problems_solved text[] not null default '{}',
 observable_signals text[] not null default '{}',
 disqualification_criteria text[] not null default '{}',
 evidence_requirements text[] not null default '{}',
 potential_benefits text[] not null default '{}',
 configured_price text,
 approved_proof jsonb not null default '[]'::jsonb check(jsonb_typeof(approved_proof)='array'),
 offer_cta text not null default '',
 status text not null default 'disabled' check(status in ('disabled','active','custom_quote')),
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 updated_at timestamptz not null default now(),
 unique(org_id,service_key),
 unique(org_id,id),
 check(status='disabled' or (reviewed_by is not null and reviewed_at is not null))
);

create table public.discovery_targeting (
 org_id uuid primary key references public.organizations(id) on delete cascade,
 target_industries text[] not null default '{}',
 target_subcategories text[] not null default '{}',
 target_cities text[] not null default '{}',
 target_states text[] not null default '{}',
 target_countries text[] not null default '{}',
 target_business_types text[] not null default '{}',
 excluded_industries text[] not null default '{}',
 excluded_businesses text[] not null default '{}',
 minimum_evidence_confidence numeric(4,3) not null default 0.700 check(minimum_evidence_confidence between 0.5 and 1),
 high_priority_threshold smallint not null default 75 check(high_priority_threshold between 50 and 100),
 research_depth text not null default 'basic' check(research_depth in ('basic','standard','deep')),
 max_new_prospects smallint not null default 0 check(max_new_prospects between 0 and 100),
 serper_discovery_enabled boolean not null default false,
 harvey_discovery_enabled boolean not null default false,
 updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id)
);

create table public.discovery_runs (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id) on delete cascade,
 provider text not null check(provider in ('serper','harvey')),
 state text not null default 'queued' check(state in ('queued','leased','completed','failed','cancelled')),
 requested_limit smallint not null check(requested_limit between 1 and 100),
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 unique(org_id,id)
);

-- A lead may have several genuine source records; never infer HARVEY from a score.
create table public.lead_discovery_sources (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 discovery_run_id uuid,
 source text not null check(source in ('serper','harvey','manual','csv','referral','inbound','meta_form')),
 actual_provider text not null,
 provider_record_id text,
 source_url text,
 observed_at timestamptz not null,
 created_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 foreign key(org_id,discovery_run_id) references public.discovery_runs(org_id,id),
 check(discovery_run_id is null or source in ('serper','harvey')),
 check(source_url is null or source_url ~ '^https?://[^ /]+')
);
create unique index lead_discovery_provider_record on public.lead_discovery_sources(org_id,source,provider_record_id) where provider_record_id is not null;
create index lead_discovery_by_lead on public.lead_discovery_sources(org_id,lead_id,observed_at desc);

create table public.lead_website_assessments (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 status text not null check(status in ('NO_OFFICIAL_WEBSITE_DISCOVERED','WORKING','PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM','UNKNOWN')),
 official_url text,
 checks jsonb not null default '[]'::jsonb check(jsonb_typeof(checks)='array'),
 evidence_ids uuid[] not null default '{}',
 reason text not null,
 confidence numeric(4,3) not null check(confidence between 0 and 1),
 observed_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 check(status not in ('WORKING','PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM') or official_url ~ '^https?://[^ /]+'),
 check(status<>'PERSISTENTLY_BROKEN' or jsonb_array_length(checks)>=2)
);
create index lead_website_latest on public.lead_website_assessments(org_id,lead_id,observed_at desc);

create table public.lead_service_matches (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 service_id uuid not null,
 status text not null check(status in ('verified_gap','research_needed','rejected')),
 reason text not null check(length(trim(reason)) between 10 and 1000),
 evidence_ids uuid[] not null default '{}',
 confidence numeric(4,3) not null check(confidence between 0 and 1),
 assessed_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 foreign key(org_id,service_id) references public.service_catalog(org_id,id),
 check(status<>'verified_gap' or array_length(evidence_ids,1)>0)
);
create index lead_service_match_latest on public.lead_service_matches(org_id,lead_id,service_id,assessed_at desc);

create table public.lead_qualifications (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 primary_service_id uuid,
 status text not null check(status in ('QUALIFIED','RESEARCH_NEEDED','NOT_QUALIFIED','CONTACT_UNVERIFIED','AWAITING_APPROVAL','CONTACTED','FOLLOW_UP_SCHEDULED','REPLIED','OWNER_REPLY_REQUIRED','INTERESTED','NOT_INTERESTED','CUSTOMER','SUPPRESSED')),
 score smallint not null check(score between 0 and 100),
 confidence numeric(4,3) not null check(confidence between 0 and 1),
 reasons text[] not null,
 evidence_ids uuid[] not null default '{}',
 suggested_angle text,
 recommended_cta text,
 evaluated_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 foreign key(org_id,primary_service_id) references public.service_catalog(org_id,id),
 check(status<>'QUALIFIED' or (primary_service_id is not null and array_length(evidence_ids,1)>0))
);
create index lead_qualification_latest on public.lead_qualifications(org_id,lead_id,evaluated_at desc,id desc);

alter table public.service_catalog enable row level security;
alter table public.discovery_targeting enable row level security;
alter table public.discovery_runs enable row level security;
alter table public.lead_discovery_sources enable row level security;
alter table public.lead_website_assessments enable row level security;
alter table public.lead_service_matches enable row level security;
alter table public.lead_qualifications enable row level security;
create policy service_catalog_read on public.service_catalog for select to authenticated using(private.is_org_member(org_id));
create policy service_catalog_insert on public.service_catalog for insert to authenticated with check(private.is_org_admin(org_id) and (status='disabled' or reviewed_by=auth.uid()));
create policy service_catalog_update on public.service_catalog for update to authenticated using(private.is_org_admin(org_id)) with check(private.is_org_admin(org_id) and (status='disabled' or reviewed_by=auth.uid()));
create policy targeting_read on public.discovery_targeting for select to authenticated using(private.is_org_member(org_id));
create policy targeting_insert on public.discovery_targeting for insert to authenticated with check(private.is_org_admin(org_id) and updated_by=auth.uid());
create policy targeting_update on public.discovery_targeting for update to authenticated using(private.is_org_admin(org_id)) with check(private.is_org_admin(org_id) and updated_by=auth.uid());
create policy discovery_runs_read on public.discovery_runs for select to authenticated using(private.is_org_admin(org_id));
create policy discovery_sources_read on public.lead_discovery_sources for select to authenticated using(private.is_org_member(org_id));
create policy website_assessments_read on public.lead_website_assessments for select to authenticated using(private.is_org_member(org_id));
create policy service_matches_read on public.lead_service_matches for select to authenticated using(private.is_org_member(org_id));
create policy qualifications_read on public.lead_qualifications for select to authenticated using(private.is_org_member(org_id));
revoke all on public.service_catalog,public.discovery_targeting,public.discovery_runs,public.lead_discovery_sources,public.lead_website_assessments,public.lead_service_matches,public.lead_qualifications from public,anon,authenticated;
grant select,insert,update on public.service_catalog,public.discovery_targeting to authenticated;
grant select on public.discovery_runs,public.lead_discovery_sources,public.lead_website_assessments,public.lead_service_matches,public.lead_qualifications to authenticated;
grant all on public.service_catalog,public.discovery_targeting,public.discovery_runs,public.lead_discovery_sources,public.lead_website_assessments,public.lead_service_matches,public.lead_qualifications to service_role;

create function public.ensure_service_catalog(p_org uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare added integer;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 insert into public.service_catalog(org_id,service_key,name)
 select p_org,'service_'||lpad(ordinality::text,2,'0'),name from unnest(array[
  'Premium business websites','Website redesign and modernization','Website repair and technical improvements','E-commerce websites',
  'Android applications','iOS applications','Custom web applications','SaaS applications','AI receptionists',
  'AI customer support systems','AI chatbots','WhatsApp bots and integrations','Business process automation',
  'AI agents and custom AI integrations','Appointment and booking systems','B2B wholesale/dealer ordering platforms',
  'CRM systems','Sales and lead follow-up automation','Custom admin panels','Operational dashboards',
  'UI/UX design','Google Business Profile and local-visibility services','Custom business software',
  'Custom integrations and digital solutions']) with ordinality as offerings(name,ordinality)
 on conflict(org_id,service_key) do nothing;
 get diagnostics added=row_count;
 return added;
end $$;
revoke execute on function public.ensure_service_catalog(uuid) from public,anon,authenticated;
grant execute on function public.ensure_service_catalog(uuid) to authenticated;

-- Owner-reviewed service gaps are accepted only with fresh evidence from this lead.
create function public.record_service_match(p_org uuid,p_lead uuid,p_service uuid,p_status text,p_reason text,p_evidence_ids uuid[],p_confidence numeric)
returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid; expected integer; valid_count integer; threshold numeric;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_status not in ('verified_gap','research_needed','rejected') or length(trim(coalesce(p_reason,''))) not between 10 and 1000
  or p_confidence not between 0 and 1 then raise exception 'INVALID_SERVICE_MATCH'; end if;
 if not exists(select 1 from public.leads where id=p_lead and org_id=p_org and not is_demo)
  or not exists(select 1 from public.service_catalog where id=p_service and org_id=p_org) then raise exception 'LEAD_OR_SERVICE_NOT_FOUND'; end if;
 if p_status='verified_gap' then
  expected:=coalesce(array_length(p_evidence_ids,1),0);
  if expected=0 or expected>10 then raise exception 'GAP_EVIDENCE_REQUIRED'; end if;
  select coalesce(minimum_evidence_confidence,0.7) into threshold from public.discovery_targeting where org_id=p_org;
  threshold:=coalesce(threshold,0.7);
  select count(distinct id) into valid_count from public.lead_evidence where org_id=p_org and lead_id=p_lead and id=any(p_evidence_ids)
   and reviewed_by is not null and confidence>=threshold and observed_at between now()-interval '90 days' and now()
   and source_url ~ '^https?://[^ /]+';
  if valid_count<>expected or p_confidence<threshold then raise exception 'GAP_EVIDENCE_NOT_VERIFIED'; end if;
 end if;
 insert into public.lead_service_matches(org_id,lead_id,service_id,status,reason,evidence_ids,confidence)
 values(p_org,p_lead,p_service,p_status,p_reason,coalesce(p_evidence_ids,'{}'),p_confidence) returning id into sid;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'service_match_reviewed','lead_service_matches',sid,jsonb_build_object('status',p_status,'lead_id',p_lead));
 return sid;
end $$;
revoke execute on function public.record_service_match(uuid,uuid,uuid,text,text,uuid[],numeric) from public,anon,authenticated;
grant execute on function public.record_service_match(uuid,uuid,uuid,text,text,uuid[],numeric) to authenticated;

create function public.evaluate_lead_qualification(p_org uuid,p_lead uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare lead public.leads; target public.discovery_targeting; match public.lead_service_matches;
 service public.service_catalog; assessment public.lead_website_assessments; result_status text:='RESEARCH_NEEDED';
 reasons text[]:='{}'; score integer:=0; qid uuid; fit_industry boolean; fit_geo boolean; fit_type boolean; contact_ok boolean;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into lead from public.leads where org_id=p_org and id=p_lead and not is_demo for update;
 if not found then raise exception 'LEAD_NOT_FOUND'; end if;
 select * into target from public.discovery_targeting where org_id=p_org;
 select m.* into match from public.lead_service_matches m join public.service_catalog s on s.id=m.service_id and s.org_id=m.org_id
  where m.org_id=p_org and m.lead_id=p_lead and s.status in ('active','custom_quote')
   and m.id=(select id from public.lead_service_matches where org_id=p_org and lead_id=p_lead and service_id=m.service_id order by assessed_at desc,id desc limit 1)
   and m.status='verified_gap' and m.assessed_at>now()-interval '90 days'
  order by m.confidence desc,m.assessed_at desc limit 1;
 if match.id is not null then select * into service from public.service_catalog where id=match.service_id and org_id=p_org; end if;
 fit_industry:=target.org_id is not null and cardinality(target.target_industries)>0 and
  lower(trim(coalesce(lead.business_category,'')))=any(select lower(trim(unnest(target.target_industries)))) and
  lower(trim(coalesce(lead.business_category,'')))<>all(select lower(trim(unnest(target.excluded_industries))));
 fit_geo:=target.org_id is not null and cardinality(target.target_cities)>0 and
  lower(trim(coalesce(lead.city,'')))=any(select lower(trim(unnest(target.target_cities)))) and
  (cardinality(target.target_states)=0 or lower(trim(coalesce(lead.state_region,'')))=any(select lower(trim(unnest(target.target_states))))) and
  (cardinality(target.target_countries)=0 or lower(trim(coalesce(lead.country,'')))=any(select lower(trim(unnest(target.target_countries))))) and
  lower(trim(coalesce(lead.business_name,'')))<>all(select lower(trim(unnest(target.excluded_businesses))));
 fit_type:=target.org_id is not null and (cardinality(target.target_business_types)=0 or
  lower(trim(coalesce(lead.business_type,'')))=any(select lower(trim(unnest(target.target_business_types)))));
 if target.org_id is null then reasons:=array_append(reasons,'Targeting has not been configured.');
 elsif cardinality(target.target_industries)=0 or cardinality(target.target_cities)=0 then reasons:=array_append(reasons,'Target industry and city must be selected.');
 elsif not fit_industry or not fit_geo or not fit_type then result_status:='NOT_QUALIFIED'; reasons:=array_append(reasons,'Business falls outside selected targeting or is excluded.'); end if;
 if match.id is null then reasons:=array_append(reasons,'No current, verified gap for an approved service.'); end if;
 if match.id is not null and service.service_key in ('service_01','service_02','service_03','service_04') then
  select * into assessment from public.lead_website_assessments where org_id=p_org and lead_id=p_lead order by observed_at desc,id desc limit 1;
  if assessment.id is null or assessment.observed_at<now()-interval '30 days' or assessment.status='UNKNOWN'
    or (service.service_key='service_01' and assessment.status<>'NO_OFFICIAL_WEBSITE_DISCOVERED')
    or (service.service_key='service_02' and assessment.status<>'VERIFIED_TECHNICAL_PROBLEM')
    or (service.service_key='service_03' and assessment.status not in ('PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM')) then
   match.id:=null; reasons:=array_append(reasons,'Website assessment does not support this service.');
  end if;
 end if;
 if match.id is not null and fit_industry and fit_geo and fit_type and result_status<>'NOT_QUALIFIED' then
  score:=least(100,40+15+15+round(match.confidence*20)::integer);
  select exists(select 1 from public.contacts c join public.email_verification_records v on v.org_id=c.org_id and v.contact_id=c.id
   where c.org_id=p_org and c.lead_id=p_lead and c.email_normalized=v.email_normalized and v.status='valid' and v.expires_at>now()
    and exists(select 1 from public.consent_records cr where cr.org_id=p_org and cr.contact_id=c.id and cr.channel='email'
      and cr.id=(select id from public.consent_records where org_id=p_org and contact_id=c.id and channel='email' order by recorded_at desc,id desc limit 1)
      and cr.state in ('permitted','opted_in') and cr.revoked_at is null)
    and v.id=(select id from public.email_verification_records where org_id=p_org and contact_id=c.id order by checked_at desc,id desc limit 1)) into contact_ok;
  if contact_ok then score:=least(100,score+10); result_status:='QUALIFIED';
   reasons:=array_append(reasons,'Reviewed evidence supports an approved service gap and target fit.');
  else result_status:='CONTACT_UNVERIFIED'; reasons:=array_append(reasons,'Contact requires current email verification.'); end if;
 end if;
 if exists(select 1 from public.contacts c join public.consent_records cr on cr.org_id=c.org_id and cr.contact_id=c.id
   where c.org_id=p_org and c.lead_id=p_lead and cr.channel='email' and cr.state in ('opted_out','unsubscribed','blocked','complained')
    and cr.id=(select id from public.consent_records where org_id=p_org and contact_id=c.id and channel='email' order by recorded_at desc,id desc limit 1)) then
  result_status:='SUPPRESSED'; reasons:=array_append(reasons,'Latest contact permission prohibits email outreach.');
 end if;
 insert into public.lead_qualifications(org_id,lead_id,primary_service_id,status,score,confidence,reasons,evidence_ids,suggested_angle,recommended_cta)
 values(p_org,p_lead,case when match.id is not null then service.id else null end,result_status,score,
  case when match.id is not null then match.confidence else 0 end,reasons,
  case when match.id is not null then match.evidence_ids else '{}' end,
  case when match.id is not null then match.reason else null end,
  case when match.id is not null then nullif(service.offer_cta,'') else null end) returning id into qid;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'lead_qualification_evaluated','lead_qualifications',qid,jsonb_build_object('status',result_status,'lead_id',p_lead));
 return qid;
end $$;
revoke execute on function public.evaluate_lead_qualification(uuid,uuid) from public,anon,authenticated;
grant execute on function public.evaluate_lead_qualification(uuid,uuid) to authenticated;
