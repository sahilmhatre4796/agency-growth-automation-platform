-- A human may verify a proposed site directly when the search provider did
-- not supply an on-site excerpt. This records what was observed and who checked.
create function public.record_manual_identity_evidence(p_org uuid,p_lead uuid,p_url text,p_claim text,p_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare eid uuid; host text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if not exists(select 1 from public.leads where org_id=p_org and id=p_lead and not is_demo)
  then raise exception 'LEAD_NOT_FOUND'; end if;
 host:=lower(split_part(split_part(p_url,'/',3),':',1));
 if p_url !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
  or host ~ '(^|\.)(localhost|local|internal)$'
  or length(p_url)>2000 or length(trim(coalesce(p_claim,''))) not between 25 and 300
  or length(trim(coalesce(p_note,''))) not between 20 and 500 then
  raise exception 'INVALID_IDENTITY_REVIEW'; end if;
 if not exists(select 1 from public.lead_discovery_sources where org_id=p_org and lead_id=p_lead
  and proposed_website_url=p_url) then raise exception 'PROPOSED_SITE_NOT_FOUND'; end if;
 insert into public.lead_evidence(org_id,lead_id,source_type,source_url,observed_at,claim,confidence,reviewed_by,review_note,kind)
 values(p_org,p_lead,'manual_identity',p_url,now(),trim(p_claim),0.8,auth.uid(),trim(p_note),'observation') returning id into eid;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'manual_identity_evidence_recorded','lead_evidence',eid,
  jsonb_build_object('lead_id',p_lead,'review_note',trim(p_note)));
 return eid;
end $$;
revoke execute on function public.record_manual_identity_evidence(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.record_manual_identity_evidence(uuid,uuid,text,text,text) to authenticated;

create or replace function public.confirm_discovered_website(
 p_org uuid,p_lead uuid,p_evidence uuid,p_url text,p_reason text
) returns void language plpgsql security definer set search_path='' as $$
declare lead public.leads; fact public.lead_evidence; proposed_host text; source_host text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into lead from public.leads where org_id=p_org and id=p_lead and not is_demo for update;
 if not found then raise exception 'LEAD_NOT_FOUND'; end if;
 select * into fact from public.lead_evidence where org_id=p_org and lead_id=p_lead
  and id=p_evidence and reviewed_by is not null and rejected_by is null
  and source_type in ('serper','harvey','serper_website','tavily_website','manual_identity') and confidence>=0.7
  and observed_at between now()-interval '30 days' and now();
 if not found then raise exception 'REVIEWED_IDENTITY_EVIDENCE_REQUIRED'; end if;
 if lead.website_url is not null or length(trim(coalesce(p_reason,''))) not between 20 and 500
  or p_url !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
  or position(lower(lead.business_name) in lower(fact.claim))=0 then
  raise exception 'OFFICIAL_IDENTITY_REVIEW_REQUIRED'; end if;
 proposed_host:=lower(split_part(split_part(p_url,'/',3),':',1));
 source_host:=lower(split_part(split_part(fact.source_url,'/',3),':',1));
 if proposed_host<>source_host or proposed_host ~ '(^|\.)(localhost|local|internal)$'
  then raise exception 'WEBSITE_SOURCE_MISMATCH'; end if;
 update public.leads set website_url=p_url where org_id=p_org and id=p_lead;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'discovered_website_confirmed','leads',p_lead,
  jsonb_build_object('evidence_id',p_evidence,'review_reason',trim(p_reason)));
end $$;
