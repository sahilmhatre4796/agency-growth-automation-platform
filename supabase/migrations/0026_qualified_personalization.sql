-- Preserve the qualification snapshot that justified each personalized draft.
alter table public.personalized_email_drafts add column qualification_id uuid;
alter table public.lead_qualifications add constraint lead_qualifications_org_id_id_key unique(org_id,id);
alter table public.personalized_email_drafts add constraint personalized_email_qualification_fk
 foreign key(org_id,qualification_id) references public.lead_qualifications(org_id,id);

alter function public.save_personalized_email_draft(uuid,uuid,uuid,text,text[],text,uuid[],text,text,uuid) set schema private;
alter function private.save_personalized_email_draft(uuid,uuid,uuid,text,text[],text,uuid[],text,text,uuid) rename to save_personalized_email_draft_legacy;
revoke execute on function private.save_personalized_email_draft_legacy(uuid,uuid,uuid,text,text[],text,uuid[],text,text,uuid) from public,anon,authenticated,service_role;
create function public.save_personalized_email_draft(p_org uuid,p_report uuid,p_contact uuid,p_identifier_hash text,p_subjects text[],p_body text,p_evidence_ids uuid[],p_language text,p_model text,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare report public.business_research_reports; q public.lead_qualifications; draft uuid;
begin
 select * into report from public.business_research_reports where org_id=p_org and id=p_report and contact_id=p_contact;
 if not found then raise exception 'RESEARCH_REVIEW_REQUIRED'; end if;
 perform private.require_current_qualification(p_org,report.lead_id);
 select * into q from public.lead_qualifications where org_id=p_org and lead_id=report.lead_id order by evaluated_at desc,id desc limit 1;
 draft:=private.save_personalized_email_draft_legacy(p_org,p_report,p_contact,p_identifier_hash,p_subjects,p_body,p_evidence_ids,p_language,p_model,p_actor);
 update public.personalized_email_drafts set qualification_id=q.id where org_id=p_org and draft_id=draft;
 return draft;
end $$;
revoke execute on function public.save_personalized_email_draft(uuid,uuid,uuid,text,text[],text,uuid[],text,text,uuid) from public,anon,authenticated;
grant execute on function public.save_personalized_email_draft(uuid,uuid,uuid,text,text[],text,uuid[],text,text,uuid) to service_role;
