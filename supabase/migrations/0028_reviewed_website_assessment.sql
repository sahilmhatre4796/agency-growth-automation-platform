-- Owner-entered assessments are explicit observations, not proof inferred from search absence.
create function public.record_website_assessment(p_org uuid,p_lead uuid,p_status text,p_official_url text,p_checks jsonb,p_evidence_ids uuid[],p_reason text,p_confidence numeric)
returns uuid language plpgsql security definer set search_path='' as $$
declare lead public.leads; item jsonb; observed timestamptz; earliest timestamptz; latest timestamptz;
 valid_count integer; check_count integer; distinct_sources integer; assessment_id uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into lead from public.leads where org_id=p_org and id=p_lead and not is_demo;
 if not found then raise exception 'LEAD_NOT_FOUND'; end if;
 if p_status not in ('NO_OFFICIAL_WEBSITE_DISCOVERED','WORKING','PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM','UNKNOWN')
  or length(trim(coalesce(p_reason,''))) not between 15 and 1000 or p_confidence not between 0 and 1
  or jsonb_typeof(p_checks)<>'array' or jsonb_array_length(p_checks)>8 then raise exception 'INVALID_WEBSITE_ASSESSMENT'; end if;
 if p_status in ('WORKING','PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM') then
  if p_official_url is null or p_official_url !~ '^https?://[^ /]+' or lead.website_url is distinct from p_official_url then
   raise exception 'OFFICIAL_WEBSITE_NOT_CONFIRMED'; end if;
 elsif p_status='NO_OFFICIAL_WEBSITE_DISCOVERED' and (p_official_url is not null or lead.website_url is not null) then raise exception 'WEBSITE_STATUS_CONFLICT'; end if;
 check_count:=jsonb_array_length(p_checks);
 for item in select value from jsonb_array_elements(p_checks) loop
  if length(coalesce(item->>'url','')) not between 12 and 2000 or item->>'url' !~ '^https?://[^ /]+'
   or (item->>'outcome') not in ('ok','http_5xx','dns_failure','tls_failure','connection_failure','not_found','verified_issue')
   or (item->>'checked_at') is null then raise exception 'INVALID_WEBSITE_CHECK'; end if;
  observed:=(item->>'checked_at')::timestamptz;
  if observed>now()+interval '5 minutes' or observed<now()-interval '30 days' then raise exception 'WEBSITE_CHECK_STALE'; end if;
  if p_status in ('WORKING','PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM') and item->>'url'<>p_official_url then
   raise exception 'WEBSITE_CHECK_DOMAIN_MISMATCH'; end if;
  earliest:=least(coalesce(earliest,observed),observed);
  latest:=greatest(coalesce(latest,observed),observed);
 end loop;
 if p_status='NO_OFFICIAL_WEBSITE_DISCOVERED' then
  select count(distinct value->>'url') into distinct_sources from jsonb_array_elements(p_checks);
  if check_count<2 or distinct_sources<2 or exists(select 1 from jsonb_array_elements(p_checks) c where c->>'outcome'<>'not_found')
   then raise exception 'WEBSITE_DISCOVERY_CHECKS_REQUIRED'; end if;
 elsif p_status='WORKING' and (check_count<1 or not exists(select 1 from jsonb_array_elements(p_checks) c where c->>'outcome'='ok')) then
  raise exception 'WORKING_WEBSITE_CHECK_REQUIRED';
 elsif p_status='PERSISTENTLY_BROKEN' and (check_count<2 or latest-earliest<interval '24 hours'
   or exists(select 1 from jsonb_array_elements(p_checks) c where c->>'outcome' not in ('http_5xx','dns_failure','tls_failure','connection_failure')
     or c->>'redirect_checked'<>'true')) then raise exception 'PERSISTENT_FAILURE_NOT_VERIFIED';
 elsif p_status='VERIFIED_TECHNICAL_PROBLEM' and (check_count<1 or not exists(select 1 from jsonb_array_elements(p_checks) c where c->>'outcome'='verified_issue')) then
  raise exception 'TECHNICAL_PROBLEM_NOT_VERIFIED'; end if;
 if p_status in ('PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM') then
  if coalesce(array_length(p_evidence_ids,1),0)=0 then raise exception 'WEBSITE_EVIDENCE_REQUIRED'; end if;
  select count(distinct id) into valid_count from public.lead_evidence where org_id=p_org and lead_id=p_lead and id=any(p_evidence_ids)
   and reviewed_by is not null and source_url ~ '^https?://[^ /]+' and observed_at>now()-interval '30 days' and confidence>=0.7;
  if valid_count<>array_length(p_evidence_ids,1) then raise exception 'WEBSITE_EVIDENCE_NOT_REVIEWED'; end if;
 end if;
 insert into public.lead_website_assessments(org_id,lead_id,status,official_url,checks,evidence_ids,reason,confidence)
 values(p_org,p_lead,p_status,p_official_url,p_checks,coalesce(p_evidence_ids,'{}'),p_reason,p_confidence) returning id into assessment_id;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'website_assessment_reviewed','lead_website_assessments',assessment_id,jsonb_build_object('status',p_status,'lead_id',p_lead));
 return assessment_id;
end $$;
revoke execute on function public.record_website_assessment(uuid,uuid,text,text,jsonb,uuid[],text,numeric) from public,anon,authenticated;
grant execute on function public.record_website_assessment(uuid,uuid,text,text,jsonb,uuid[],text,numeric) to authenticated;
