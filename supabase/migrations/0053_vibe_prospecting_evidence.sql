-- Vibe Prospecting reuses business research reports and CRM review. A name,
-- role or address is never inferred from a search result or email pattern.
alter table public.business_research_reports
 add column decision_maker_candidates jsonb not null default '[]'::jsonb
 check(jsonb_typeof(decision_maker_candidates)='array'
   and jsonb_array_length(decision_maker_candidates)<=3
   and length(decision_maker_candidates::text)<=6000);

create or replace function public.finish_business_research_job(p_job uuid,p_token uuid,p_report jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare item jsonb; rid uuid; source_host text; email_domain text; website_url text;
begin
 if p_report ? 'contact_candidates' and
  (jsonb_typeof(p_report->'contact_candidates')<>'array' or jsonb_array_length(p_report->'contact_candidates')>3)
  then raise exception 'INVALID_CONTACT_CANDIDATES'; end if;
 if p_report ? 'decision_maker_candidates' and
  (jsonb_typeof(p_report->'decision_maker_candidates')<>'array'
   or jsonb_array_length(p_report->'decision_maker_candidates')>3
   or length((p_report->'decision_maker_candidates')::text)>6000)
  then raise exception 'INVALID_DECISION_MAKERS'; end if;
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
 rid:=private.finish_business_research_job(p_job,p_token,p_report);
 if rid is not null then
  update public.business_research_reports set
   contact_candidates=coalesce(p_report->'contact_candidates','[]'::jsonb),
   decision_maker_candidates=coalesce(p_report->'decision_maker_candidates','[]'::jsonb)
   where id=rid;
 end if;
 return rid;
end $$;
revoke execute on function public.finish_business_research_job(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finish_business_research_job(uuid,uuid,jsonb) to service_role;

create function public.approve_vibe_contact_candidate(p_org uuid,p_report uuid,p_name text,p_email text,p_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare report public.business_research_reports; item jsonb; normalized text; cid uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if length(trim(coalesce(p_note,''))) not between 20 and 500 then raise exception 'CONTACT_REVIEW_NOTE_REQUIRED'; end if;
 select * into report from public.business_research_reports
  where org_id=p_org and id=p_report and expires_at>now() for update;
 if not found then raise exception 'RESEARCH_REPORT_NOT_FOUND'; end if;
 if not exists(select 1 from public.leads l where l.org_id=p_org and l.id=report.lead_id
  and not l.is_demo and private.research_snapshot(l)=report.source_snapshot)
  then raise exception 'LEAD_CHANGED'; end if;
 normalized:=lower(trim(coalesce(p_email,'')));
 select value into item from jsonb_array_elements(report.decision_maker_candidates)
  where value->>'full_name'=trim(p_name) and lower(value->>'email')=normalized
   and value->>'email_status'='publicly_sourced' limit 1;
 if item is null then raise exception 'SOURCED_DECISION_MAKER_NOT_FOUND'; end if;
 if item->>'source_url'<>report.website->>'url' or
  not exists(select 1 from public.lead_evidence e where e.org_id=p_org and e.lead_id=report.lead_id
   and e.source_url=item->>'source_url' and e.reviewed_by is not null and e.rejected_by is null
   and e.source_type=report.provider||'_website' and e.observed_at>now()-interval '30 days')
  then raise exception 'REVIEWED_OFFICIAL_WEBSITE_REQUIRED'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text||':'||normalized,0));
 if exists(select 1 from public.contacts where org_id=p_org and email_normalized=normalized)
  then raise exception 'CONTACT_DUPLICATE_REVIEW_REQUIRED'; end if;
 insert into public.contacts(org_id,lead_id,contact_name,role,email,email_normalized,source_url)
  values(p_org,report.lead_id,item->>'full_name',item->>'role',normalized,normalized,item->>'source_url') returning id into cid;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
  values(p_org,auth.uid(),'vibe_contact_candidate_approved','contacts',cid,
   jsonb_build_object('report_id',p_report,'review_note',trim(p_note)));
 return cid;
end $$;
revoke execute on function public.approve_vibe_contact_candidate(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.approve_vibe_contact_candidate(uuid,uuid,text,text,text) to authenticated;
