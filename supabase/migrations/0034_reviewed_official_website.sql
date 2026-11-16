-- An extracted page is only a proposed website until its identity is reviewed.
create function public.confirm_discovered_website(
 p_org uuid,p_lead uuid,p_evidence uuid,p_url text,p_reason text
) returns void language plpgsql security definer set search_path='' as $$
declare lead public.leads; fact public.lead_evidence; proposed_host text; source_host text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into lead from public.leads where org_id=p_org and id=p_lead and not is_demo for update;
 if not found then raise exception 'LEAD_NOT_FOUND'; end if;
 select * into fact from public.lead_evidence where org_id=p_org and lead_id=p_lead
  and id=p_evidence and reviewed_by is not null and rejected_by is null
  and source_type in ('serper','harvey') and confidence>=0.7
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
revoke execute on function public.confirm_discovered_website(uuid,uuid,uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.confirm_discovered_website(uuid,uuid,uuid,text,text)
 to authenticated;
