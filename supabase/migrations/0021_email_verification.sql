-- Provider-neutral, tenant-scoped email checks. No SMTP probe is enabled here.
create table public.email_verification_cache (
 org_id uuid not null references public.organizations(id) on delete cascade,
 email_normalized text not null,
 status text not null check(status in ('valid','invalid','unknown','risky')),
 evidence jsonb not null,
 provider text not null,
 checked_at timestamptz not null,
 expires_at timestamptz not null,
 primary key(org_id,email_normalized),
 check(expires_at>checked_at),
 check(length(email_normalized)<=254),
 check(length(evidence::text)<=12000)
);
create table public.email_verification_records (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 contact_id uuid not null,
 email_normalized text not null,
 status text not null check(status in ('valid','invalid','unknown','risky','suppressed')),
 evidence jsonb not null,
 provider text not null,
 checked_at timestamptz not null default now(),
 expires_at timestamptz not null,
 reviewed_by uuid,
 reviewed_at timestamptz,
 foreign key(org_id,contact_id) references public.contacts(org_id,id) on delete cascade,
 foreign key(org_id,reviewed_by) references public.memberships(org_id,user_id),
 check(length(email_normalized)<=254),
 check(length(evidence::text)<=12000),
 check((reviewed_by is null)=(reviewed_at is null))
);
create index email_verification_latest on public.email_verification_records(org_id,contact_id,checked_at desc,id desc);
create table public.email_verification_jobs (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null,
 contact_id uuid not null,
 email_normalized text not null,
 state text not null default 'queued' check(state in ('queued','leased','completed','failed','cancelled')),
 attempts smallint not null default 0 check(attempts between 0 and 3),
 next_run_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 last_error_code text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(org_id,contact_id) references public.contacts(org_id,id) on delete cascade,
 check(length(email_normalized)<=254)
);
create unique index email_verification_one_active on public.email_verification_jobs(org_id,contact_id) where state in ('queued','leased');
create index email_verification_due on public.email_verification_jobs(state,next_run_at) where state in ('queued','leased');
alter table public.email_verification_cache enable row level security;
alter table public.email_verification_records enable row level security;
alter table public.email_verification_jobs enable row level security;
create policy email_verification_cache_read on public.email_verification_cache for select to authenticated using(private.is_org_admin(org_id));
create policy email_verification_records_read on public.email_verification_records for select to authenticated using(private.is_org_admin(org_id));
create policy email_verification_jobs_read on public.email_verification_jobs for select to authenticated using(private.is_org_admin(org_id));
revoke all on public.email_verification_cache,public.email_verification_records,public.email_verification_jobs from public,anon,authenticated;
grant select on public.email_verification_records,public.email_verification_jobs to authenticated;
grant all on public.email_verification_cache,public.email_verification_records,public.email_verification_jobs to service_role;

create function private.email_send_verification_gate(p_org uuid,p_contact uuid,p_email text)
returns void language plpgsql security definer set search_path='' as $$
declare record public.email_verification_records;
begin
 select * into record from public.email_verification_records
  where org_id=p_org and contact_id=p_contact and email_normalized=lower(trim(p_email))
  order by checked_at desc,id desc limit 1;
 if not found or record.expires_at<=now() then raise exception 'EMAIL_VERIFICATION_REQUIRED'; end if;
 if record.status in ('invalid','suppressed') then raise exception 'EMAIL_VERIFICATION_BLOCKED'; end if;
 if record.status in ('unknown','risky') and record.reviewed_at is null then raise exception 'EMAIL_VERIFICATION_REVIEW_REQUIRED'; end if;
end $$;
revoke execute on function private.email_send_verification_gate(uuid,uuid,text) from public,anon,authenticated;
grant execute on function private.email_send_verification_gate(uuid,uuid,text) to service_role;

create function public.request_email_verification(p_org uuid,p_contact uuid,p_email text,p_identifier_hash text,p_actor uuid,p_force boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare contact public.contacts; cached public.email_verification_cache; current_job uuid; duplicate_count integer; final_status text; result_id uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and role='admin') then raise exception 'FORBIDDEN'; end if;
 if p_identifier_hash !~ '^[a-f0-9]{64}$' or p_email is null then raise exception 'INVALID_VERIFICATION_REQUEST'; end if;
 perform 1 from public.organizations where id=p_org for update;
 select * into contact from public.contacts where org_id=p_org and id=p_contact for update;
 if not found or contact.email_normalized is null or contact.email_normalized<>lower(trim(p_email)) then raise exception 'CONTACT_EMAIL_CHANGED'; end if;
 if exists(select 1 from public.suppressions where org_id=p_org and channel in ('email','all') and identifier_hash=p_identifier_hash)
   or exists(select 1 from public.consent_records c where c.org_id=p_org and c.contact_id=p_contact and c.channel='email'
     and c.id=(select id from public.consent_records where org_id=p_org and contact_id=p_contact and channel='email' order by recorded_at desc,id desc limit 1)
     and c.state in ('opted_out','unsubscribed','blocked','complained')) then
  insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
  values(p_org,p_contact,contact.email_normalized,'suppressed','{"reason":"contact_suppressed"}'::jsonb,'policy',now()+interval '1 day') returning id into result_id;
  return jsonb_build_object('state','suppressed','record_id',result_id);
 end if;
 select count(*) into duplicate_count from public.contacts where org_id=p_org and email_normalized=contact.email_normalized;
 select * into cached from public.email_verification_cache where org_id=p_org and email_normalized=contact.email_normalized and expires_at>now();
 if found and not p_force then
  final_status:=case when duplicate_count>1 and cached.status='valid' then 'risky' else cached.status end;
  insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,checked_at,expires_at)
  values(p_org,p_contact,contact.email_normalized,final_status,cached.evidence||jsonb_build_object('duplicate_contacts',duplicate_count),cached.provider,cached.checked_at,cached.expires_at)
  returning id into result_id;
  return jsonb_build_object('state','cached','record_id',result_id,'status',final_status);
 end if;
 select id into current_job from public.email_verification_jobs where org_id=p_org and contact_id=p_contact and state in ('queued','leased');
 if found then return jsonb_build_object('state','pending','job_id',current_job); end if;
 if (select count(*) from public.email_verification_jobs where org_id=p_org and created_at>=date_trunc('day',now()))>=100 then raise exception 'VERIFICATION_DAILY_CAP'; end if;
 insert into public.email_verification_jobs(org_id,contact_id,email_normalized) values(p_org,p_contact,contact.email_normalized) returning id into current_job;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,p_actor,'email_verification_requested','email_verification_jobs',current_job);
 return jsonb_build_object('state','queued','job_id',current_job);
end $$;

create function public.lease_email_verification_jobs(p_limit integer default 10)
returns setof public.email_verification_jobs language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 25 then raise exception 'INVALID_BATCH_SIZE'; end if;
 update public.email_verification_jobs set state='queued',lease_token=null,lease_until=null,next_run_at=now()+interval '1 minute',last_error_code='LEASE_EXPIRED',updated_at=now()
  where state='leased' and lease_until<now() and attempts<3;
 update public.email_verification_jobs set state='failed',lease_token=null,lease_until=null,last_error_code='MAX_ATTEMPTS',updated_at=now()
  where state='leased' and lease_until<now() and attempts>=3;
 return query with candidates as (select id from public.email_verification_jobs where state='queued' and attempts<3 and next_run_at<=now()
  order by next_run_at,id for update skip locked limit p_limit)
 update public.email_verification_jobs j set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
 from candidates c where j.id=c.id returning j.*;
end $$;

create function public.finish_email_verification_job(p_job uuid,p_token uuid,p_identifier_hash text,p_result jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare job public.email_verification_jobs; contact public.contacts; status text; final_status text; duplicate_count integer; expiry timestamptz; evidence jsonb; provider text;
begin
 select * into job from public.email_verification_jobs where id=p_job and state='leased' and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'VERIFICATION_LEASE_INVALID'; end if;
 if p_identifier_hash !~ '^[a-f0-9]{64}$' or length(p_result::text)>12000 then raise exception 'INVALID_VERIFICATION_RESULT'; end if;
 status:=p_result->>'status'; evidence:=p_result->'evidence'; provider:=p_result->>'provider';
 if status not in ('valid','invalid','unknown','risky') or jsonb_typeof(evidence)<>'object' or length(coalesce(provider,'')) not between 1 and 80 then raise exception 'INVALID_VERIFICATION_RESULT'; end if;
 select * into contact from public.contacts where org_id=job.org_id and id=job.contact_id for update;
 if not found or contact.email_normalized<>job.email_normalized then
  update public.email_verification_jobs set state='cancelled',lease_token=null,lease_until=null,last_error_code='CONTACT_EMAIL_CHANGED',updated_at=now() where id=p_job;
  return 'cancelled';
 end if;
 expiry:=now()+case when status='valid' then interval '7 days' when status='invalid' then interval '1 day' else interval '12 hours' end;
 insert into public.email_verification_cache(org_id,email_normalized,status,evidence,provider,checked_at,expires_at)
 values(job.org_id,job.email_normalized,status,evidence,provider,now(),expiry)
 on conflict(org_id,email_normalized) do update set status=excluded.status,evidence=excluded.evidence,provider=excluded.provider,checked_at=excluded.checked_at,expires_at=excluded.expires_at;
 select count(*) into duplicate_count from public.contacts where org_id=job.org_id and email_normalized=job.email_normalized;
 final_status:=case when duplicate_count>1 and status='valid' then 'risky' else status end;
 if exists(select 1 from public.suppressions where org_id=job.org_id and channel in ('email','all') and identifier_hash=p_identifier_hash) then final_status:='suppressed'; end if;
 insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
 values(job.org_id,job.contact_id,job.email_normalized,final_status,evidence||jsonb_build_object('duplicate_contacts',duplicate_count),provider,expiry);
 update public.email_verification_jobs set state='completed',lease_token=null,lease_until=null,last_error_code=null,updated_at=now() where id=p_job;
 insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context) values(job.org_id,'email_verification_completed','email_verification_jobs',p_job,jsonb_build_object('status',final_status));
 return final_status;
end $$;

create function public.fail_email_verification_job(p_job uuid,p_token uuid,p_code text)
returns void language plpgsql security definer set search_path='' as $$
declare job public.email_verification_jobs;
begin
 select * into job from public.email_verification_jobs where id=p_job and state='leased' and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'VERIFICATION_LEASE_INVALID'; end if;
 if length(coalesce(p_code,'')) not between 1 and 80 then raise exception 'INVALID_ERROR_CODE'; end if;
 update public.email_verification_jobs set state=case when attempts>=3 then 'failed' else 'queued' end,
  lease_token=null,lease_until=null,next_run_at=now()+make_interval(mins=>attempts*5),last_error_code=p_code,updated_at=now() where id=p_job;
 if job.attempts>=3 then
  insert into public.email_verification_records(org_id,contact_id,email_normalized,status,evidence,provider,expires_at)
  values(job.org_id,job.contact_id,job.email_normalized,'unknown',jsonb_build_object('reason','service_failure','code',p_code),'verification_worker',now()+interval '1 hour');
 end if;
end $$;

create function public.review_email_verification(p_org uuid,p_contact uuid,p_record uuid)
returns void language plpgsql security definer set search_path='' as $$
declare record public.email_verification_records; contact public.contacts;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 select * into record from public.email_verification_records where id=p_record and org_id=p_org and contact_id=p_contact for update;
 select * into contact from public.contacts where id=p_contact and org_id=p_org;
 if not found or record.id is null or record.status not in ('unknown','risky') or record.expires_at<=now()
  or contact.email_normalized<>record.email_normalized or record.id<>(select id from public.email_verification_records where org_id=p_org and contact_id=p_contact order by checked_at desc,id desc limit 1)
  then raise exception 'VERIFICATION_REVIEW_NOT_ALLOWED'; end if;
 update public.email_verification_records set reviewed_by=auth.uid(),reviewed_at=now() where id=p_record;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'email_verification_reviewed','email_verification_records',p_record);
end $$;

create function public.email_verification_summary(p_org uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare summary jsonb;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 with latest as (
  select distinct on (r.contact_id) r.status,r.checked_at from public.email_verification_records r
  join public.contacts c on c.id=r.contact_id and c.org_id=r.org_id and c.email_normalized=r.email_normalized
  where r.org_id=p_org order by r.contact_id,r.checked_at desc,r.id desc
 ) select jsonb_build_object(
  'total_checked',count(*),'valid',count(*) filter(where status='valid'),
  'invalid',count(*) filter(where status='invalid'),'unknown',count(*) filter(where status='unknown'),
  'risky',count(*) filter(where status='risky'),'suppressed',count(*) filter(where status='suppressed'),
  'last_checked_at',max(checked_at),
  'pending',(select count(*) from public.email_verification_jobs where org_id=p_org and state in ('queued','leased')),
  'errors',(select count(*) from public.email_verification_jobs where org_id=p_org and state='failed')
 ) into summary from latest;
 return summary;
end $$;

revoke execute on function public.request_email_verification(uuid,uuid,text,text,uuid,boolean),public.lease_email_verification_jobs(integer),public.finish_email_verification_job(uuid,uuid,text,jsonb),public.fail_email_verification_job(uuid,uuid,text),public.review_email_verification(uuid,uuid,uuid),public.email_verification_summary(uuid) from public,anon,authenticated;
grant execute on function public.request_email_verification(uuid,uuid,text,text,uuid,boolean),public.lease_email_verification_jobs(integer),public.finish_email_verification_job(uuid,uuid,text,jsonb),public.fail_email_verification_job(uuid,uuid,text) to service_role;
grant execute on function public.review_email_verification(uuid,uuid,uuid),public.email_verification_summary(uuid) to authenticated;
