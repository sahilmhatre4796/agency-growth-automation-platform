-- Research is read-only public-web work, disabled until a reviewed free-tier budget is set.
alter table public.organizations add column research_provider text not null default 'serper' check(research_provider in ('serper','tavily'));
alter table public.organizations add column research_monthly_credit_cap integer not null default 0
 check(research_monthly_credit_cap between 0 and 2500);
alter table public.organizations add constraint research_provider_free_cap check(
 (research_provider='serper' and research_monthly_credit_cap<=2500) or
 (research_provider='tavily' and research_monthly_credit_cap<=1000));
create table public.research_credit_usage (
 org_id uuid not null references public.organizations(id) on delete cascade,
 provider text not null check(provider in ('serper','tavily')),
 month_start date not null,
 reserved_credits integer not null default 0 check(reserved_credits>=0),
 primary key(org_id,provider,month_start)
);
create table public.business_research_jobs (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 contact_id uuid not null,
 provider text not null check(provider in ('serper','tavily')),
 source_snapshot jsonb not null,
 state text not null default 'queued' check(state in ('queued','leased','completed','failed','cancelled')),
 attempts smallint not null default 0 check(attempts between 0 and 3),
 next_run_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 last_error_code text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 foreign key(org_id,contact_id) references public.contacts(org_id,id) on delete cascade
);
create unique index business_research_one_active on public.business_research_jobs(org_id,lead_id) where state in ('queued','leased');
create index business_research_due on public.business_research_jobs(state,next_run_at) where state in ('queued','leased');
create table public.research_credit_reservations (
 job_id uuid not null references public.business_research_jobs(id) on delete cascade,
 attempt smallint not null,
 org_id uuid not null references public.organizations(id) on delete cascade,
 provider text not null check(provider in ('serper','tavily')),
 credits smallint not null check(credits in (4,42)),
 created_at timestamptz not null default now(),
 primary key(job_id,attempt)
);
create table public.business_research_reports (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 lead_id uuid not null,
 contact_id uuid not null,
 job_id uuid not null unique references public.business_research_jobs(id),
 source_snapshot jsonb not null,
 state text not null check(state in ('ready','manual_review')),
 website jsonb not null,
 evidence jsonb not null,
 competitors jsonb not null,
 opportunity text not null,
 confidence numeric(4,3) not null check(confidence between 0 and 1),
 reason text not null,
 provider text not null default 'serper' check(provider in ('serper','tavily')),
 observed_at timestamptz not null default now(),
 expires_at timestamptz not null,
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade,
 foreign key(org_id,contact_id) references public.contacts(org_id,id) on delete cascade,
 check(length(evidence::text)<=30000),
 check(length(competitors::text)<=12000)
);
create index business_research_latest on public.business_research_reports(org_id,lead_id,observed_at desc);
create table public.personalized_email_drafts (
 draft_id uuid primary key,
 org_id uuid not null,
 report_id uuid not null references public.business_research_reports(id),
 contact_id uuid not null,
 subject_options text[] not null,
 selected_evidence_ids uuid[] not null,
 generated_at timestamptz not null default now(),
 foreign key(org_id,draft_id) references public.outbound_drafts(org_id,id) on delete cascade,
 foreign key(org_id,contact_id) references public.contacts(org_id,id),
 check(array_length(subject_options,1)=2)
);
alter table public.research_credit_usage enable row level security;
alter table public.business_research_jobs enable row level security;
alter table public.research_credit_reservations enable row level security;
alter table public.business_research_reports enable row level security;
alter table public.personalized_email_drafts enable row level security;
create policy research_usage_read on public.research_credit_usage for select to authenticated using(private.is_org_admin(org_id));
create policy research_jobs_read on public.business_research_jobs for select to authenticated using(private.is_org_admin(org_id));
create policy research_reservations_read on public.research_credit_reservations for select to authenticated using(private.is_org_admin(org_id));
create policy research_reports_read on public.business_research_reports for select to authenticated using(private.is_org_admin(org_id));
create policy personalized_drafts_read on public.personalized_email_drafts for select to authenticated using(private.is_org_admin(org_id));
revoke all on public.research_credit_usage,public.business_research_jobs,public.research_credit_reservations,public.business_research_reports,public.personalized_email_drafts from public,anon,authenticated;
grant select on public.research_credit_usage,public.business_research_jobs,public.research_credit_reservations,public.business_research_reports,public.personalized_email_drafts to authenticated;
grant all on public.research_credit_usage,public.business_research_jobs,public.research_credit_reservations,public.business_research_reports,public.personalized_email_drafts to service_role;

create function private.research_snapshot(p_lead public.leads)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('name',p_lead.business_name,'website_url',p_lead.website_url,'industry',p_lead.business_category,'market',p_lead.city)
$$;
revoke execute on function private.research_snapshot(public.leads) from public,anon,authenticated;
grant execute on function private.research_snapshot(public.leads) to service_role;

create function public.request_business_research(p_org uuid,p_lead uuid,p_contact uuid,p_email text,p_identifier_hash text,p_actor uuid,p_force boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare lead public.leads; contact public.contacts; org public.organizations; snapshot jsonb; existing uuid; cached uuid; used integer; needed integer;
begin
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and role='admin') then raise exception 'FORBIDDEN'; end if;
 if p_identifier_hash !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_IDENTIFIER_HASH'; end if;
 select * into org from public.organizations where id=p_org for update;
 select * into lead from public.leads where org_id=p_org and id=p_lead and not is_demo for update;
 select * into contact from public.contacts where org_id=p_org and id=p_contact and lead_id=p_lead for update;
 if lead.id is null or contact.id is null or contact.email_normalized<>lower(trim(p_email)) then raise exception 'LEAD_OR_CONTACT_CHANGED'; end if;
 if exists(select 1 from public.suppressions where org_id=p_org and channel in ('email','all') and identifier_hash=p_identifier_hash)
  or exists(select 1 from public.consent_records c where c.org_id=p_org and c.contact_id=p_contact and c.channel='email'
   and c.id=(select id from public.consent_records where org_id=p_org and contact_id=p_contact and channel='email' order by recorded_at desc,id desc limit 1)
   and c.state in ('opted_out','unsubscribed','blocked','complained')) then raise exception 'CONTACT_SUPPRESSED'; end if;
 perform private.email_send_verification_gate(p_org,p_contact,p_email);
 snapshot:=private.research_snapshot(lead);
 if not p_force then
  select id into cached from public.business_research_reports where org_id=p_org and lead_id=p_lead and contact_id=p_contact
   and provider=org.research_provider and source_snapshot=snapshot and expires_at>now() order by observed_at desc limit 1;
  if found then return jsonb_build_object('state','cached','report_id',cached); end if;
 end if;
 select id into existing from public.business_research_jobs where org_id=p_org and lead_id=p_lead and state in ('queued','leased');
 if found then return jsonb_build_object('state','pending','job_id',existing); end if;
 needed:=case when org.research_provider='serper' then 42 else 4 end;
 select coalesce(reserved_credits,0) into used from public.research_credit_usage
  where org_id=p_org and provider=org.research_provider and month_start=date_trunc('month',now() at time zone 'UTC')::date;
 if org.research_monthly_credit_cap=0 or coalesce(used,0)+needed>org.research_monthly_credit_cap then raise exception 'RESEARCH_CREDIT_CAP'; end if;
 insert into public.business_research_jobs(org_id,lead_id,contact_id,provider,source_snapshot)
 values(p_org,p_lead,p_contact,org.research_provider,snapshot) returning id into existing;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,p_actor,'business_research_requested','business_research_jobs',existing);
 return jsonb_build_object('state','queued','job_id',existing);
end $$;

create function public.lease_business_research_jobs(p_limit integer default 2,p_provider text default 'serper')
returns setof public.business_research_jobs language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 5 then raise exception 'INVALID_BATCH_SIZE'; end if;
 if p_provider not in ('serper','tavily') then raise exception 'INVALID_RESEARCH_PROVIDER'; end if;
 update public.business_research_jobs set state='queued',lease_token=null,lease_until=null,next_run_at=now()+interval '1 minute',last_error_code='LEASE_EXPIRED',updated_at=now()
  where state='leased' and lease_until<now() and attempts<3;
 update public.business_research_jobs set state='failed',lease_token=null,lease_until=null,last_error_code='MAX_ATTEMPTS',updated_at=now()
  where state='leased' and lease_until<now() and attempts>=3;
 return query with candidates as (select id from public.business_research_jobs where provider=p_provider and state='queued' and attempts<3 and next_run_at<=now()
  order by next_run_at,id for update skip locked limit p_limit)
 update public.business_research_jobs j set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',updated_at=now()
 from candidates c where j.id=c.id returning j.*;
end $$;

create function public.reserve_research_credits(p_job uuid,p_token uuid,p_credits integer default 4)
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.business_research_jobs; org public.organizations; current_used integer; month date;
begin
 select * into job from public.business_research_jobs where id=p_job and state='leased' and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'RESEARCH_LEASE_INVALID'; end if;
 if p_credits<>(case when job.provider='serper' then 42 else 4 end) then raise exception 'INVALID_CREDIT_RESERVATION'; end if;
 if exists(select 1 from public.research_credit_reservations where job_id=p_job and attempt=job.attempts) then return true; end if;
 select * into org from public.organizations where id=job.org_id for update;
 month:=date_trunc('month',now() at time zone 'UTC')::date;
 if org.research_provider<>job.provider then return false; end if;
 insert into public.research_credit_usage(org_id,provider,month_start) values(job.org_id,job.provider,month) on conflict do nothing;
 select reserved_credits into current_used from public.research_credit_usage where org_id=job.org_id and provider=job.provider and month_start=month for update;
 if org.research_monthly_credit_cap=0 or current_used+p_credits>org.research_monthly_credit_cap then return false; end if;
 update public.research_credit_usage set reserved_credits=reserved_credits+p_credits where org_id=job.org_id and provider=job.provider and month_start=month;
 insert into public.research_credit_reservations(job_id,attempt,org_id,provider,credits) values(p_job,job.attempts,job.org_id,job.provider,p_credits);
 return true;
end $$;

create function public.finish_business_research_job(p_job uuid,p_token uuid,p_report jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare job public.business_research_jobs; lead public.leads; rid uuid; item jsonb;
begin
 select * into job from public.business_research_jobs where id=p_job and state='leased' and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'RESEARCH_LEASE_INVALID'; end if;
 select * into lead from public.leads where id=job.lead_id and org_id=job.org_id for update;
 if lead.id is null or private.research_snapshot(lead)<>job.source_snapshot then
  update public.business_research_jobs set state='cancelled',lease_token=null,lease_until=null,last_error_code='LEAD_CHANGED',updated_at=now() where id=p_job;
  return null;
 end if;
 if length(p_report::text)>30000 or p_report->>'state' not in ('ready','manual_review') or jsonb_typeof(p_report->'evidence')<>'array'
  or jsonb_typeof(p_report->'competitors')<>'array' or jsonb_array_length(p_report->'competitors')>3
  or jsonb_typeof(p_report->'website')<>'object' or (p_report->>'confidence')::numeric not between 0 and 1 then raise exception 'INVALID_RESEARCH_REPORT'; end if;
 insert into public.business_research_reports(org_id,lead_id,contact_id,job_id,source_snapshot,state,website,evidence,competitors,opportunity,confidence,reason,provider,expires_at)
 values(job.org_id,job.lead_id,job.contact_id,p_job,job.source_snapshot,p_report->>'state',p_report->'website',p_report->'evidence',p_report->'competitors',
  p_report->>'opportunity',(p_report->>'confidence')::numeric,left(p_report->>'reason',500),job.provider,now()+interval '14 days') returning id into rid;
 for item in select value from jsonb_array_elements(p_report->'evidence') loop
  if item->>'kind' in ('business_fact','competitor','website') and length(coalesce(item->>'claim','')) between 10 and 500
   and length(coalesce(item->>'url','')) between 12 and 2000 then
   insert into public.lead_evidence(id,org_id,lead_id,source_url,source_type,observed_at,claim,confidence)
   values((item->>'id')::uuid,job.org_id,job.lead_id,item->>'url',job.provider||'_'||(item->>'kind'),(item->>'observed_at')::timestamptz,item->>'claim',(item->>'confidence')::numeric);
  end if;
 end loop;
 update public.business_research_jobs set state='completed',lease_token=null,lease_until=null,last_error_code=null,updated_at=now() where id=p_job;
 insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context) values(job.org_id,'business_research_completed','business_research_reports',rid,jsonb_build_object('state',p_report->>'state'));
 return rid;
end $$;

create function public.fail_business_research_job(p_job uuid,p_token uuid,p_code text)
returns void language plpgsql security definer set search_path='' as $$
declare job public.business_research_jobs;
begin
 select * into job from public.business_research_jobs where id=p_job and state='leased' and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'RESEARCH_LEASE_INVALID'; end if;
 if length(coalesce(p_code,'')) not between 1 and 80 then raise exception 'INVALID_ERROR_CODE'; end if;
 update public.business_research_jobs set state=case when attempts>=3 or p_code in ('TAVILY_CREDITS_OR_RATE_EXHAUSTED','SERPER_CREDITS_OR_RATE_EXHAUSTED','SERPER_CREDIT_COST_UNEXPECTED','RESEARCH_CREDIT_CAP') then 'failed' else 'queued' end,
  next_run_at=now()+make_interval(mins=>attempts*15),lease_token=null,lease_until=null,last_error_code=p_code,updated_at=now() where id=p_job;
end $$;

create function public.save_personalized_email_draft(p_org uuid,p_report uuid,p_contact uuid,p_identifier_hash text,p_subjects text[],p_body text,p_evidence_ids uuid[],p_language text,p_model text,p_actor uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare report public.business_research_reports; lead public.leads; contact public.contacts; draft_id uuid; evidence_id uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and role='admin') then raise exception 'FORBIDDEN'; end if;
 if p_identifier_hash !~ '^[a-f0-9]{64}$' or array_length(p_subjects,1)<>2 or length(coalesce(p_subjects[1],'')) not between 4 and 160
  or length(coalesce(p_subjects[2],'')) not between 4 and 160 or length(coalesce(p_body,'')) not between 1 and 3000
  or p_language not in ('en','hinglish') or length(coalesce(p_model,'')) not between 1 and 100
  or coalesce(array_length(p_evidence_ids,1),0) not between 1 and 2
  or array_length(regexp_split_to_array(btrim(p_body),'\s+'),1)>90 then raise exception 'INVALID_PERSONALIZED_DRAFT'; end if;
 select * into report from public.business_research_reports where id=p_report and org_id=p_org and contact_id=p_contact and state='ready' and expires_at>now() for update;
 select * into lead from public.leads where id=report.lead_id and org_id=p_org;
 select * into contact from public.contacts where id=p_contact and org_id=p_org and lead_id=report.lead_id;
 if report.id is null or lead.id is null or contact.id is null or private.research_snapshot(lead)<>report.source_snapshot then raise exception 'RESEARCH_STALE'; end if;
 perform private.email_send_verification_gate(p_org,p_contact,contact.email_normalized);
 if exists(select 1 from public.suppressions where org_id=p_org and channel in ('email','all') and identifier_hash=p_identifier_hash) then raise exception 'CONTACT_SUPPRESSED'; end if;
 if exists(select 1 from public.consent_records c where c.org_id=p_org and c.contact_id=p_contact and c.channel='email'
  and c.id=(select id from public.consent_records where org_id=p_org and contact_id=p_contact and channel='email' order by recorded_at desc,id desc limit 1)
  and c.state in ('opted_out','unsubscribed','blocked','complained')) then raise exception 'CONTACT_SUPPRESSED'; end if;
 foreach evidence_id in array p_evidence_ids loop
  if not exists(select 1 from jsonb_array_elements(report.evidence) item where item->>'id'=evidence_id::text) then raise exception 'EVIDENCE_NOT_IN_REPORT'; end if;
 end loop;
 if not exists(select 1 from jsonb_array_elements(report.evidence) item
  where item->>'id'=p_evidence_ids[1]::text and item->>'kind'='business_fact' and (item->>'confidence')::numeric>=0.7)
  then raise exception 'BUSINESS_FACT_REQUIRED'; end if;
 insert into public.outbound_drafts(org_id,lead_id,contact_id,channel,subject,body,evidence_ids,state,language,prompt_version,model_id)
 values(p_org,report.lead_id,p_contact,'email',p_subjects[1],p_body,p_evidence_ids,'needs_review',p_language,'personalized-v1',p_model) returning id into draft_id;
 insert into public.personalized_email_drafts(draft_id,org_id,report_id,contact_id,subject_options,selected_evidence_ids)
 values(draft_id,p_org,p_report,p_contact,p_subjects,p_evidence_ids);
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,p_actor,'personalized_draft_created','outbound_drafts',draft_id,jsonb_build_object('report_id',p_report));
 return draft_id;
end $$;

revoke execute on function public.request_business_research(uuid,uuid,uuid,text,text,uuid,boolean),public.lease_business_research_jobs(integer,text),public.reserve_research_credits(uuid,uuid,integer),public.finish_business_research_job(uuid,uuid,jsonb),public.fail_business_research_job(uuid,uuid,text),public.save_personalized_email_draft(uuid,uuid,uuid,text,text[],text,uuid[],text,text,uuid) from public,anon,authenticated;
grant execute on function public.request_business_research(uuid,uuid,uuid,text,text,uuid,boolean),public.lease_business_research_jobs(integer,text),public.reserve_research_credits(uuid,uuid,integer),public.finish_business_research_job(uuid,uuid,jsonb),public.fail_business_research_job(uuid,uuid,text),public.save_personalized_email_draft(uuid,uuid,uuid,text,text[],text,uuid[],text,text,uuid) to service_role;
