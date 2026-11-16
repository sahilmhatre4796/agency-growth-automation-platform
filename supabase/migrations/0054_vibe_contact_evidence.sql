-- Contact-first enrichment. Discovery observations are evidence, not verified
-- mailboxes, recipient permission, consent or authority to send.
create table public.vibe_contact_points (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 kind text not null check(kind in ('email','phone','whatsapp')),
 normalized_value text not null check(length(normalized_value) between 3 and 254),
 display_value text not null check(length(display_value) between 3 and 254),
 email_type text not null default 'unknown' check(email_type in ('general','sales','support','owner','unknown')),
 contact_name text,
 role text,
 review_status text not null default 'pending' check(review_status in ('pending','approved','rejected')),
 preferred boolean not null default false,
 first_discovered_at timestamptz not null,
 last_cross_checked_at timestamptz not null,
 created_at timestamptz not null default now(),
 reviewed_by uuid references auth.users(id),
 reviewed_at timestamptz,
 review_note text,
 unique(org_id,id),
 unique(org_id,lead_id,id),
 unique(org_id,lead_id,kind,normalized_value),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 check(not preferred or (kind='email' and review_status='approved')),
 check(contact_name is null or length(contact_name) between 3 and 160),
 check(role is null or length(role) between 2 and 100)
);
create unique index vibe_one_preferred_email on public.vibe_contact_points(org_id,lead_id)
 where kind='email' and preferred;
create index vibe_points_by_lead on public.vibe_contact_points(org_id,lead_id,kind,review_status);

create table public.vibe_contact_sources (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 point_id uuid not null,
 source_provider text not null check(source_provider in ('serper','harvey','vibe','official_website')),
 source_url text not null check(source_url ~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'),
 evidence_excerpt text not null check(length(evidence_excerpt) between 5 and 320),
 observed_at timestamptz not null,
 confidence numeric(4,3) not null check(confidence between 0 and 1),
 created_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 foreign key(org_id,lead_id,point_id) references public.vibe_contact_points(org_id,lead_id,id) on delete cascade,
 unique(org_id,point_id,source_provider,source_url,evidence_excerpt)
);
create index vibe_sources_by_point on public.vibe_contact_sources(org_id,point_id,observed_at desc);

alter table public.vibe_contact_points enable row level security;
alter table public.vibe_contact_sources enable row level security;
create policy vibe_points_admin_read on public.vibe_contact_points for select to authenticated
 using(private.is_org_admin(org_id));
create policy vibe_sources_admin_read on public.vibe_contact_sources for select to authenticated
 using(private.is_org_admin(org_id));
revoke all on public.vibe_contact_points,public.vibe_contact_sources from public,anon,authenticated;
grant select on public.vibe_contact_points,public.vibe_contact_sources to authenticated;
grant all on public.vibe_contact_points,public.vibe_contact_sources to service_role;

create function public.record_vibe_contact_observations(
 p_org uuid,p_lead uuid,p_provider text,p_observations jsonb
) returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; point_id uuid; point_kind text; raw_value text; normalized text; source_link text;
 observed timestamptz; confidence numeric; added integer:=0; excerpt text;
begin
 if p_provider is null or p_provider not in ('serper','harvey','vibe','official_website')
  or jsonb_typeof(p_observations)<>'array' or jsonb_array_length(p_observations)>20
  then raise exception 'INVALID_CONTACT_BATCH'; end if;
 if not exists(select 1 from public.leads where org_id=p_org and id=p_lead and not is_demo)
  then raise exception 'CONTACT_LEAD_NOT_FOUND'; end if;
 if p_provider in ('serper','harvey') and not exists(
  select 1 from public.lead_discovery_sources where org_id=p_org and lead_id=p_lead and source=p_provider)
  then raise exception 'DISCOVERY_SOURCE_NOT_MATCHED'; end if;
 for item in select value from jsonb_array_elements(p_observations) loop
  point_kind:=item->>'kind'; raw_value:=trim(coalesce(item->>'value',''));
  source_link:=item->>'source_url'; excerpt:=trim(coalesce(item->>'evidence_excerpt',''));
  if point_kind not in ('email','phone','whatsapp') or length(raw_value) not between 3 and 254
   or length(excerpt) not between 5 and 320 or position(lower(raw_value) in lower(excerpt))=0
   or source_link !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
   or length(coalesce(item->>'contact_name',''))>160 or length(coalesce(item->>'role',''))>100
   or (item->>'contact_name' is not null and position(lower(item->>'contact_name') in lower(excerpt))=0)
   or (item->>'role' is not null and position(lower(item->>'role') in lower(excerpt))=0)
   then raise exception 'INVALID_CONTACT_EVIDENCE'; end if;
  observed:=(item->>'observed_at')::timestamptz;
  confidence:=(item->>'confidence')::numeric;
  if observed not between now()-interval '30 days' and now()+interval '5 minutes'
   or confidence not between 0 and 1 then raise exception 'STALE_CONTACT_EVIDENCE'; end if;
  if point_kind='email' then
   normalized:=lower(raw_value);
   if normalized !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    or normalized like '%..%' then raise exception 'INVALID_CONTACT_EMAIL'; end if;
  else
   normalized:=regexp_replace(raw_value,'[[:space:]().-]','','g');
   if normalized !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'INVALID_CONTACT_PHONE'; end if;
   if point_kind='whatsapp' and excerpt !~* '(whatsapp|wa\.me|api\.whatsapp)'
    then raise exception 'WHATSAPP_NOT_EXPLICIT'; end if;
  end if;
  -- A provider URL must be connected to the resolved business. An official
  -- website URL may instead match the already recorded business domain.
  if not exists(select 1 from public.lead_discovery_sources d
   where d.org_id=p_org and d.lead_id=p_lead and d.source_url=source_link)
   and not exists(select 1 from public.leads l where l.org_id=p_org and l.id=p_lead and l.website_url=source_link)
   and not exists(select 1 from public.lead_evidence e where e.org_id=p_org and e.lead_id=p_lead
    and e.source_url=source_link and e.source_type in ('serper','serper_website','tavily_website'))
   and not exists(select 1 from public.leads l where l.org_id=p_org and l.id=p_lead
    and l.normalized_domain is not null and
    regexp_replace(lower(split_part(split_part(source_link,'/',3),':',1)),'^www\.','')=l.normalized_domain)
   then raise exception 'CONTACT_SOURCE_IDENTITY_UNCONFIRMED'; end if;
  insert into public.vibe_contact_points(org_id,lead_id,kind,normalized_value,display_value,
    contact_name,role,first_discovered_at,last_cross_checked_at)
   values(p_org,p_lead,point_kind,normalized,raw_value,nullif(item->>'contact_name',''),
    nullif(item->>'role',''),observed,observed)
   on conflict(org_id,lead_id,kind,normalized_value) do update set
    last_cross_checked_at=greatest(public.vibe_contact_points.last_cross_checked_at,excluded.last_cross_checked_at)
   returning id into point_id;
  insert into public.vibe_contact_sources(org_id,lead_id,point_id,source_provider,source_url,
   evidence_excerpt,observed_at,confidence)
   values(p_org,p_lead,point_id,p_provider,source_link,excerpt,observed,confidence)
   on conflict do nothing;
  added:=added+1;
 end loop;
 return added;
end $$;
revoke execute on function public.record_vibe_contact_observations(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_vibe_contact_observations(uuid,uuid,text,jsonb) to service_role;

-- Save all bounded official-page addresses in the same transaction as the
-- research report. A failed contact validation rolls back the report finish.
create or replace function public.finish_business_research_job(p_job uuid,p_token uuid,p_report jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare item jsonb; rid uuid; source_host text; email_domain text; website_url text;
 report_org uuid; report_lead uuid;
begin
 if p_report ? 'contact_candidates' and
  (jsonb_typeof(p_report->'contact_candidates')<>'array' or jsonb_array_length(p_report->'contact_candidates')>3)
  then raise exception 'INVALID_CONTACT_CANDIDATES'; end if;
 if p_report ? 'decision_maker_candidates' and
  (jsonb_typeof(p_report->'decision_maker_candidates')<>'array'
   or jsonb_array_length(p_report->'decision_maker_candidates')>3
   or length((p_report->'decision_maker_candidates')::text)>6000)
  then raise exception 'INVALID_DECISION_MAKERS'; end if;
 if p_report ? 'contact_observations' and
  (jsonb_typeof(p_report->'contact_observations')<>'array'
   or jsonb_array_length(p_report->'contact_observations')>10)
  then raise exception 'INVALID_CONTACT_BATCH'; end if;
 website_url:=p_report->'website'->>'url';
 for item in select value from jsonb_array_elements(coalesce(p_report->'contact_candidates','[]'::jsonb)) loop
  source_host:=lower(split_part(split_part(item->>'source_url','/',3),':',1));
  email_domain:=lower(split_part(item->>'email','@',2));
  if website_url is null or item->>'source_url'<>website_url
   or item->>'source_url' !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
   or lower(item->>'email') !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'
   or email_domain<>regexp_replace(source_host,'^www\.','')
   or (item->>'confidence')::numeric not between 0 and 1
   or (item->>'observed_at')::timestamptz not between now()-interval '30 days' and now()+interval '1 hour'
   then raise exception 'INVALID_CONTACT_CANDIDATES'; end if;
 end loop;
 for item in select value from jsonb_array_elements(coalesce(p_report->'decision_maker_candidates','[]'::jsonb)) loop
  if website_url is null or item->>'source_url'<>website_url
   or item->>'source_url' !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
   or length(coalesce(item->>'full_name','')) not between 3 and 160
   or length(coalesce(item->>'role','')) not between 3 and 100
   or length(coalesce(item->>'evidence_excerpt','')) not between 12 and 320
   or position(lower(item->>'full_name') in lower(item->>'evidence_excerpt'))=0
   or position(lower(item->>'role') in lower(item->>'evidence_excerpt'))=0
   or (item->>'confidence')::numeric not between 0 and 1
   or (item->>'observed_at')::timestamptz not between now()-interval '30 days' and now()+interval '1 hour'
   or (item->>'email_status') not in ('publicly_sourced','unknown')
   or ((item->>'email') is null)<>(item->>'email_status'='unknown')
   or (item->>'email' is not null and
      (length(item->>'email')>254
       or lower(item->>'email') !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'
       or position(lower(item->>'email') in lower(item->>'evidence_excerpt'))=0))
   then raise exception 'INVALID_DECISION_MAKERS'; end if;
 end loop;
 for item in select value from jsonb_array_elements(coalesce(p_report->'contact_observations','[]'::jsonb)) loop
  if website_url is null or item->>'source_url'<>website_url then raise exception 'INVALID_CONTACT_SOURCE'; end if;
 end loop;
 rid:=private.finish_business_research_job(p_job,p_token,p_report);
 if rid is not null then
  update public.business_research_reports set
   contact_candidates=coalesce(p_report->'contact_candidates','[]'::jsonb),
   decision_maker_candidates=coalesce(p_report->'decision_maker_candidates','[]'::jsonb)
   where id=rid;
  select org_id,lead_id into report_org,report_lead from public.business_research_reports where id=rid;
  if jsonb_array_length(coalesce(p_report->'contact_observations','[]'::jsonb))>0 then
   perform public.record_vibe_contact_observations(report_org,report_lead,'official_website',
    p_report->'contact_observations');
  end if;
 end if;
 return rid;
end $$;
revoke execute on function public.finish_business_research_job(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finish_business_research_job(uuid,uuid,jsonb) to service_role;

create function public.review_vibe_contact_point(p_org uuid,p_point uuid,p_decision text,p_type text,p_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare point public.vibe_contact_points; cid uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_decision is null or p_type is null or p_decision not in ('approve','reject') or p_type not in ('general','sales','support','owner','unknown')
  or length(trim(coalesce(p_note,''))) not between 20 and 500 then raise exception 'INVALID_CONTACT_REVIEW'; end if;
 select * into point from public.vibe_contact_points where org_id=p_org and id=p_point for update;
 if not found or point.review_status<>'pending' then raise exception 'CONTACT_POINT_NOT_PENDING'; end if;
 if p_type='owner' and (point.contact_name is null or point.role is null)
  then raise exception 'OWNER_IDENTITY_EVIDENCE_REQUIRED'; end if;
 if not exists(select 1 from public.vibe_contact_sources where org_id=p_org and point_id=p_point
  and observed_at>now()-interval '30 days')
  then raise exception 'CONTACT_SOURCE_REQUIRED'; end if;
 if p_decision='approve' then
  if point.kind='email' then
   if exists(select 1 from public.contacts where org_id=p_org and email_normalized=point.normalized_value and lead_id<>point.lead_id)
    then raise exception 'CONTACT_OWNERSHIP_CONFLICT'; end if;
   select id into cid from public.contacts where org_id=p_org and lead_id=point.lead_id
    and email_normalized=point.normalized_value limit 1;
   if cid is null then
    insert into public.contacts(org_id,lead_id,contact_name,role,email,email_normalized,source_url)
     values(p_org,point.lead_id,point.contact_name,point.role,point.normalized_value,point.normalized_value,
      (select source_url from public.vibe_contact_sources where org_id=p_org and point_id=p_point order by observed_at desc limit 1))
     returning id into cid;
   end if;
  else
   select id into cid from public.contacts where org_id=p_org and lead_id=point.lead_id
    and phone_e164=point.normalized_value limit 1;
   if cid is null then
    insert into public.contacts(org_id,lead_id,contact_name,role,phone_e164,source_url)
     values(p_org,point.lead_id,point.contact_name,point.role,point.normalized_value,
      (select source_url from public.vibe_contact_sources where org_id=p_org and point_id=p_point order by observed_at desc limit 1))
     returning id into cid;
   end if;
  end if;
 end if;
 update public.vibe_contact_points set review_status=case when p_decision='approve' then 'approved' else 'rejected' end,
  email_type=p_type,reviewed_by=auth.uid(),reviewed_at=now(),review_note=trim(p_note) where id=p_point;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
  values(p_org,auth.uid(),'vibe_contact_'||p_decision,'vibe_contact_points',p_point,
   jsonb_build_object('contact_id',cid));
 return cid;
end $$;
revoke execute on function public.review_vibe_contact_point(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.review_vibe_contact_point(uuid,uuid,text,text,text) to authenticated;

create function public.set_vibe_preferred_email(p_org uuid,p_point uuid)
returns void language plpgsql security definer set search_path='' as $$
declare point public.vibe_contact_points;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into point from public.vibe_contact_points where org_id=p_org and id=p_point and kind='email'
  and review_status='approved' for update;
 if not found then raise exception 'APPROVED_EMAIL_REQUIRED'; end if;
 update public.vibe_contact_points set preferred=false where org_id=p_org and lead_id=point.lead_id and preferred;
 update public.vibe_contact_points set preferred=true where id=p_point;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
  values(p_org,auth.uid(),'vibe_preferred_email_selected','vibe_contact_points',p_point);
end $$;
revoke execute on function public.set_vibe_preferred_email(uuid,uuid) from public,anon,authenticated;
grant execute on function public.set_vibe_preferred_email(uuid,uuid) to authenticated;
