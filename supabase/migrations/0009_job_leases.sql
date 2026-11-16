alter table public.jobs add column lease_token uuid;
alter table public.jobs add column policy_version text not null default 'policy-v1';
create function public.lease_jobs(p_limit integer default 10) returns setof public.jobs language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 25 then raise exception 'INVALID_BATCH_SIZE';end if;
 update public.jobs set state='failed',last_error_code='MAX_ATTEMPTS',lease_token=null,lease_until=null where attempts>=max_attempts and (state='queued' or state='leased' and lease_until<now());
 return query with candidates as (
  select id from public.jobs where attempts<max_attempts and next_run_at<=now() and (state='queued' or state='leased' and lease_until<now()) order by next_run_at,id for update skip locked limit p_limit
 ) update public.jobs j set state='leased',attempts=attempts+1,lease_until=now()+interval '60 seconds',lease_token=gen_random_uuid(),updated_at=now() from candidates c where j.id=c.id returning j.*;
end $$;
revoke all on function public.lease_jobs(integer) from public;
grant execute on function public.lease_jobs(integer) to service_role;
create function public.finish_job(p_id uuid,p_token uuid,p_state text,p_error text default null) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_state not in ('completed','failed','suppressed','queued') then raise exception 'INVALID_JOB_STATE';end if;
 update public.jobs set state=case when p_state='queued' and attempts>=max_attempts then 'failed' else p_state end,last_error_code=left(p_error,80),lease_until=null,lease_token=null,next_run_at=case when p_state='queued' then now()+make_interval(secs=>least(3600,power(2,attempts)::integer*30)) else next_run_at end,updated_at=now() where id=p_id and lease_token=p_token and state='leased' and lease_until>now();
 return found;
end $$;
revoke all on function public.finish_job(uuid,uuid,text,text) from public;
grant execute on function public.finish_job(uuid,uuid,text,text) to service_role;
alter table public.jobs add unique(org_id,id);
alter table public.notifications add column job_id uuid;
alter table public.notifications add foreign key(org_id,job_id) references public.jobs(org_id,id);
create unique index notification_job_unique on public.notifications(job_id) where job_id is not null;
create function public.create_job_notification(p_id uuid,p_token uuid) returns void language plpgsql security definer set search_path='' as $$
declare job public.jobs; nid uuid;
begin
 select * into job from public.jobs where id=p_id and lease_token=p_token and state='leased' and lease_until>now() for update;
 if not found or job.kind<>'notification.create' or length(coalesce(job.payload->>'title','')) not between 1 and 160 then raise exception 'INVALID_JOB';end if;
 insert into public.notifications(org_id,title,kind,job_id) values(job.org_id,job.payload->>'title','workflow',job.id) on conflict do nothing returning id into nid;
 if nid is not null then insert into public.audit_events(org_id,action,entity_table,entity_id) values(job.org_id,'notification_created','notifications',nid);end if;
end $$;
revoke all on function public.create_job_notification(uuid,uuid) from public;
grant execute on function public.create_job_notification(uuid,uuid) to service_role;
