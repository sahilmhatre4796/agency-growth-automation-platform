-- A saved qualification is a snapshot. Recheck its exact supporting service
-- match, current evidence and latest website assessment at queue/send time.
create or replace function private.require_current_qualification(p_org uuid,p_lead uuid)
returns void language plpgsql security definer set search_path='' as $$
declare q public.lead_qualifications; lead public.leads; chosen public.lead_service_matches;
 service public.service_catalog; assessment public.lead_website_assessments; evidence_count integer; threshold numeric;
begin
 select * into lead from public.leads where org_id=p_org and id=p_lead;
 if not found or lead.is_demo or lead.status in ('disqualified','lost','won') then raise exception 'LEAD_NOT_ELIGIBLE'; end if;
 select * into q from public.lead_qualifications where org_id=p_org and lead_id=p_lead
  order by evaluated_at desc,id desc limit 1;
 if not found or q.status<>'QUALIFIED' or q.evaluated_at<=now()-interval '30 days'
  then raise exception 'CURRENT_QUALIFICATION_REQUIRED'; end if;
 select * into service from public.service_catalog where org_id=p_org and id=q.primary_service_id
  and status in ('active','custom_quote');
 if not found then raise exception 'APPROVED_SERVICE_REQUIRED'; end if;
 select * into chosen from public.lead_service_matches where org_id=p_org and lead_id=p_lead
  and service_id=q.primary_service_id order by assessed_at desc,id desc limit 1;
 if not found or chosen.status<>'verified_gap' or chosen.assessed_at<=now()-interval '90 days'
  or chosen.evidence_ids is distinct from q.evidence_ids
  or coalesce(cardinality(chosen.evidence_ids),0) not between 1 and 10
  then raise exception 'CURRENT_SERVICE_GAP_REQUIRED'; end if;
 select coalesce(minimum_evidence_confidence,0.7) into threshold from public.discovery_targeting where org_id=p_org;
 threshold:=coalesce(threshold,0.7);
 select count(distinct id) into evidence_count from public.lead_evidence
  where org_id=p_org and lead_id=p_lead and id=any(chosen.evidence_ids)
   and reviewed_by is not null and rejected_by is null and confidence>=threshold
   and observed_at between now()-interval '90 days' and now()
   and source_url ~ '^https?://[^ /]+';
 if evidence_count<>cardinality(chosen.evidence_ids)
  then raise exception 'CURRENT_SERVICE_GAP_REQUIRED'; end if;
 if service.service_key in ('service_01','service_02','service_03','service_04') then
  select * into assessment from public.lead_website_assessments where org_id=p_org and lead_id=p_lead
   order by observed_at desc,id desc limit 1;
  if assessment.id is null or assessment.observed_at<=now()-interval '30 days'
    or assessment.status='UNKNOWN'
    or (service.service_key='service_01' and lead.website_url is not null)
    or (service.service_key in ('service_02','service_03')
      and (assessment.official_url is null or assessment.official_url is distinct from lead.website_url))
    or (service.service_key='service_04' and not (
      (assessment.status='NO_OFFICIAL_WEBSITE_DISCOVERED' and lead.website_url is null)
      or (assessment.official_url is not null and assessment.official_url=lead.website_url)))
    or (service.service_key='service_01' and assessment.status<>'NO_OFFICIAL_WEBSITE_DISCOVERED')
    or (service.service_key='service_02' and assessment.status<>'VERIFIED_TECHNICAL_PROBLEM')
    or (service.service_key='service_03' and assessment.status not in ('PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM'))
    then raise exception 'CURRENT_WEBSITE_ASSESSMENT_REQUIRED'; end if;
  if (service.service_key='service_01' or
     (service.service_key='service_04' and assessment.status='NO_OFFICIAL_WEBSITE_DISCOVERED')) and not exists(
   select 1 from public.lead_evidence e where e.org_id=p_org and e.lead_id=p_lead
    and e.id=any(assessment.evidence_ids) and e.source_type='business_website_statement'
    and e.reviewed_by is not null and e.rejected_by is null and e.confidence>=0.8
    and e.observed_at>now()-interval '30 days'
  ) then raise exception 'CURRENT_WEBSITE_ASSESSMENT_REQUIRED'; end if;
 end if;
end $$;

-- The model worker calls this before reserving AI tokens. The save RPC checks
-- again afterward, so changes during generation still fail closed.
create function public.preflight_personalized_draft(p_org uuid,p_report uuid,p_contact uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare report public.business_research_reports; recipient public.contacts;
begin
 select * into report from public.business_research_reports where org_id=p_org and id=p_report
  and (contact_id=p_contact or contact_id is null) and state='ready' and expires_at>now();
 if not found then raise exception 'RESEARCH_REVIEW_REQUIRED'; end if;
 select * into recipient from public.contacts where org_id=p_org and id=p_contact
  and lead_id=report.lead_id and email_normalized is not null;
 if not found then raise exception 'EMAIL_CONTACT_REQUIRED'; end if;
 perform private.require_current_qualification(p_org,report.lead_id);
 if not exists(select 1 from public.consent_records c where c.org_id=p_org and c.contact_id=p_contact
  and c.channel='email' and c.state in ('permitted','opted_in') and c.revoked_at is null
  and c.id=(select id from public.consent_records where org_id=p_org and contact_id=p_contact
   and channel='email' order by recorded_at desc,id desc limit 1))
  then raise exception 'EMAIL_PERMISSION_REQUIRED'; end if;
 perform private.email_send_verification_gate(p_org,p_contact,recipient.email_normalized);
 return true;
end $$;
revoke execute on function public.preflight_personalized_draft(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.preflight_personalized_draft(uuid,uuid,uuid) to service_role;
