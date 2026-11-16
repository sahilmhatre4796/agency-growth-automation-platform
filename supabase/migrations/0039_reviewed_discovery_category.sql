-- The target industry is only a proposal until the owner checks its source.
create function public.confirm_discovered_category(
 p_org uuid,p_lead uuid,p_source uuid,p_evidence uuid,p_reason text
) returns void language plpgsql security definer set search_path='' as $$
declare lead public.leads; origin public.lead_discovery_sources; fact public.lead_evidence;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into lead from public.leads where org_id=p_org and id=p_lead and not is_demo for update;
 if not found then raise exception 'LEAD_NOT_FOUND'; end if;
 select * into origin from public.lead_discovery_sources where org_id=p_org and lead_id=p_lead and id=p_source
  and source in ('serper','harvey') and proposed_category is not null;
 select * into fact from public.lead_evidence where org_id=p_org and lead_id=p_lead and id=p_evidence
  and source_type=origin.source and reviewed_by is not null and rejected_by is null and confidence>=0.7
  and observed_at between now()-interval '30 days' and now();
 if origin.id is null or fact.id is null or length(trim(coalesce(p_reason,''))) not between 20 and 500
  or lead.business_category is not null or position(lower(lead.business_name) in lower(fact.claim))=0
  or lower(split_part(origin.source_url,'/',3))<>lower(split_part(fact.source_url,'/',3))
  then raise exception 'CATEGORY_IDENTITY_REVIEW_REQUIRED'; end if;
 update public.leads set business_category=origin.proposed_category where id=p_lead and org_id=p_org;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'discovered_category_confirmed','leads',p_lead,
  jsonb_build_object('source_id',p_source,'evidence_id',p_evidence,'reason',trim(p_reason)));
end $$;
revoke execute on function public.confirm_discovered_category(uuid,uuid,uuid,uuid,text)
 from public,anon,authenticated;
grant execute on function public.confirm_discovered_category(uuid,uuid,uuid,uuid,text) to authenticated;
