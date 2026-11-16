-- Qualification can be earned through another contact on the lead. Require the
-- selected draft recipient's own current email permission before saving a draft.
create or replace function public.save_personalized_email_draft(p_org uuid,p_report uuid,p_contact uuid,p_identifier_hash text,p_subjects text[],p_body text,p_evidence_ids uuid[],p_language text,p_model text,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare report public.business_research_reports; reviewed_count integer;
begin
 select * into report from public.business_research_reports where org_id=p_org and id=p_report
  and (contact_id=p_contact or contact_id is null) for update;
 if not found then raise exception 'RESEARCH_REVIEW_REQUIRED'; end if;
 if coalesce(cardinality(p_evidence_ids),0) not between 1 and 4 then raise exception 'INVALID_DRAFT_EVIDENCE'; end if;
 select count(distinct id) into reviewed_count from public.lead_evidence
  where org_id=p_org and lead_id=report.lead_id and id=any(p_evidence_ids)
   and reviewed_by is not null and rejected_by is null and confidence>=0.7
   and observed_at between now()-interval '30 days' and now() and source_url ~ '^https://[^ /]+';
 if reviewed_count<>cardinality(p_evidence_ids) then raise exception 'SOURCE_EVIDENCE_NOT_REVIEWED'; end if;
 if not exists (
  select 1 from public.consent_records c where c.org_id=p_org and c.contact_id=p_contact
   and c.channel='email' and c.state in ('permitted','opted_in') and c.revoked_at is null
   and c.id=(select id from public.consent_records where org_id=p_org and contact_id=p_contact
    and channel='email' order by recorded_at desc,id desc limit 1)
 ) then raise exception 'EMAIL_PERMISSION_REQUIRED'; end if;
 if report.contact_id is null then
  if not exists(select 1 from public.contacts where org_id=p_org and lead_id=report.lead_id and id=p_contact)
   then raise exception 'CONTACT_NOT_FOR_LEAD'; end if;
  update public.business_research_reports set contact_id=p_contact where id=p_report and org_id=p_org;
 end if;
 return private.save_personalized_email_draft_qualified(p_org,p_report,p_contact,p_identifier_hash,
  p_subjects,p_body,p_evidence_ids,p_language,p_model,p_actor);
end $$;
