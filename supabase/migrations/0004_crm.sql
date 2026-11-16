alter table public.leads add column city text;
alter table public.leads add constraint business_name_length check(length(trim(business_name)) between 2 and 160);
create unique index leads_identity_unique on public.leads(org_id,lower(trim(business_name)),coalesce(normalized_domain,''));
alter table public.lead_evidence add column kind text not null default 'observation' check(kind in ('intent','relevance','quality','contactability','urgency','observation'));

create table public.lead_notes (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.organizations(id),
 lead_id uuid not null,
 body text not null check(length(trim(body)) between 1 and 5000),
 created_by uuid not null default auth.uid() references auth.users(id),
 created_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id) on delete cascade
);
alter table public.lead_notes enable row level security;
create policy notes_read on public.lead_notes for select to authenticated using(private.is_org_member(org_id));
create policy notes_write on public.lead_notes for insert to authenticated with check(private.is_org_admin(org_id) and created_by=auth.uid());
grant select,insert on public.lead_notes to authenticated;
create trigger notes_audit after insert on public.lead_notes for each row execute function private.audit_crm_change();

-- Atomic import, serialized per organization. Never replaces consent or suppression.
create function public.import_leads(p_org uuid,p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare item jsonb; lid uuid; added integer:=0; skipped integer:=0; domain text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>500 then raise exception 'INVALID_IMPORT'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,0));
 for item in select value from jsonb_array_elements(p_rows) loop
  if length(trim(item->>'business_name')) not between 2 and 160 then raise exception 'INVALID_BUSINESS_NAME'; end if;
  if coalesce(item->>'website_url','')<>'' and (item->>'website_url')!~'^https?://[^ /]+' then raise exception 'INVALID_WEBSITE'; end if;
  if coalesce(item->>'email','')<>'' and (item->>'email')!~'^[^ @]+@[^ @]+\.[^ @]+$' then raise exception 'INVALID_EMAIL'; end if;
  domain:=nullif(lower(regexp_replace(split_part(regexp_replace(coalesce(item->>'website_url',''),'^https?://',''),'/',1),'^www\.','')),'');
  lid:=null;
  insert into public.leads(org_id,business_name,website_url,normalized_domain,source_type,source_url,source_observed_at,business_category,city,is_demo)
  values(p_org,trim(item->>'business_name'),nullif(item->>'website_url',''),domain,coalesce(nullif(item->>'source_type',''),'csv'),nullif(item->>'source_url',''),now(),item->>'business_category',item->>'city',false)
  on conflict do nothing returning id into lid;
  if lid is null then skipped:=skipped+1; continue; end if;
  if coalesce(item->>'email','')<>'' then
   insert into public.contacts(org_id,lead_id,email,email_normalized,source_url) values(p_org,lid,item->>'email',lower(trim(item->>'email')),item->>'source_url');
  end if;
  added:=added+1;
 end loop;
 return jsonb_build_object('added',added,'skipped',skipped);
end $$;
revoke all on function public.import_leads(uuid,jsonb) from public;
grant execute on function public.import_leads(uuid,jsonb) to authenticated;

-- Compute scores server-side; browser cannot invent scores or referenced evidence.
drop policy scores_insert on public.lead_scores;
revoke insert on public.lead_scores from authenticated;
create function public.score_lead(p_org uuid,p_lead uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare factors jsonb; total integer; n integer; ids uuid[]; sid uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if not exists(select 1 from public.leads where id=p_lead and org_id=p_org) then raise exception 'NOT_FOUND'; end if;
 select jsonb_build_object('intent',case when bool_or(kind='intent') then 30 else 0 end,'relevance',case when bool_or(kind='relevance') then 25 else 0 end,'quality',case when count(*)>0 then 20 else 0 end,'contactability',case when bool_or(kind='contactability') then 15 else 0 end,'urgency',case when bool_or(kind='urgency') then 10 else 0 end),count(*),coalesce(array_agg(id),'{}'::uuid[])
 into factors,n,ids from public.lead_evidence where org_id=p_org and lead_id=p_lead and reviewed_by is not null and confidence>=0.7 and observed_at between now()-interval '90 days' and now() and source_url ~ '^https?://';
 select sum(value::integer) into total from jsonb_each_text(factors);
 insert into public.lead_scores(org_id,lead_id,score,confidence,score_version,breakdown,evidence_ids) values(p_org,p_lead,total,least(1,n::numeric/5),'rules-v1',factors,ids) returning id into sid;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'score_calculated','lead_scores',sid);
 return sid;
end $$;
revoke all on function public.score_lead(uuid,uuid) from public;
grant execute on function public.score_lead(uuid,uuid) to authenticated;
