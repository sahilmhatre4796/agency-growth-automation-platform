-- Public business research can precede contact discovery. A draft still needs a
-- verified contact, consent/suppression checks, qualification and human approval.
alter table public.business_research_jobs alter column contact_id drop not null;
alter table public.business_research_reports alter column contact_id drop not null;

create function public.request_lead_research(p_org uuid,p_lead uuid,p_actor uuid,p_force boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare lead public.leads; org public.organizations; snapshot jsonb; existing uuid; cached uuid; used integer; needed integer;
begin
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and role='admin')
  then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into org from public.organizations where id=p_org for update;
 select * into lead from public.leads where org_id=p_org and id=p_lead and not is_demo for update;
 if not found then raise exception 'LEAD_NOT_FOUND'; end if;
 if exists(select 1 from public.contacts c join public.consent_records r on r.org_id=c.org_id and r.contact_id=c.id
  where c.org_id=p_org and c.lead_id=p_lead and r.channel='email'
   and r.id=(select id from public.consent_records where org_id=p_org and contact_id=c.id and channel='email'
    order by recorded_at desc,id desc limit 1)
   and r.state in ('opted_out','unsubscribed','blocked','complained'))
  then raise exception 'LEAD_SUPPRESSED'; end if;
 snapshot:=private.research_snapshot(lead);
 if not p_force then
  select id into cached from public.business_research_reports where org_id=p_org and lead_id=p_lead
   and contact_id is null and provider=org.research_provider and source_snapshot=snapshot and expires_at>now()
   order by observed_at desc limit 1;
  if found then return jsonb_build_object('state','cached','report_id',cached); end if;
 end if;
 select id into existing from public.business_research_jobs where org_id=p_org and lead_id=p_lead and state in ('queued','leased');
 if found then return jsonb_build_object('state','pending','job_id',existing); end if;
 needed:=case when org.research_provider='serper' then 42 else 4 end;
 select coalesce(reserved_credits,0) into used from public.research_credit_usage
  where org_id=p_org and provider=org.research_provider and month_start=date_trunc('month',now() at time zone 'UTC')::date;
 if org.research_monthly_credit_cap=0 or coalesce(used,0)+needed>org.research_monthly_credit_cap
  then raise exception 'RESEARCH_CREDIT_CAP'; end if;
 insert into public.business_research_jobs(org_id,lead_id,contact_id,provider,source_snapshot)
 values(p_org,p_lead,null,org.research_provider,snapshot) returning id into existing;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id)
 values(p_org,p_actor,'lead_research_requested','business_research_jobs',existing);
 return jsonb_build_object('state','queued','job_id',existing);
end $$;
revoke execute on function public.request_lead_research(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.request_lead_research(uuid,uuid,uuid,boolean) to service_role;

-- A lead-only report is bound to the first eligible contact when a reviewed
-- draft is saved. If the inherited save gate fails, this update rolls back.
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
 if report.contact_id is null then
  if not exists(select 1 from public.contacts where org_id=p_org and lead_id=report.lead_id and id=p_contact)
   then raise exception 'CONTACT_NOT_FOR_LEAD'; end if;
  update public.business_research_reports set contact_id=p_contact where id=p_report and org_id=p_org;
 end if;
 return private.save_personalized_email_draft_qualified(p_org,p_report,p_contact,p_identifier_hash,
  p_subjects,p_body,p_evidence_ids,p_language,p_model,p_actor);
end $$;
