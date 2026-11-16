alter table public.leads add constraint website_scheme check(website_url is null or website_url ~ '^https?://[^ /]+');
alter table public.leads add constraint source_scheme check(source_url is null or source_url ~ '^https?://[^ /]+');
alter table public.contacts add constraint email_shape check(email is null or email ~ '^[^ @]+@[^ @]+\.[^ @]+$');
alter table public.lead_evidence add constraint evidence_length check(length(trim(claim)) between 1 and 2000);
alter table public.lead_evidence add constraint evidence_url check(source_url is null or source_url ~ '^https?://[^ /]+');
alter table public.lead_evidence add constraint observed_not_future check(observed_at<=now()+interval '1 minute');
alter table public.tasks add constraint task_title_length check(length(trim(title)) between 1 and 160);

create function private.normalize_lead_domain() returns trigger language plpgsql set search_path='' as $$
begin
 new.normalized_domain:=nullif(lower(regexp_replace(split_part(regexp_replace(coalesce(new.website_url,''),'^https?://',''),'/',1),'^www\.','')),'');
 return new;
end $$;
create trigger leads_domain before insert or update of website_url on public.leads for each row execute function private.normalize_lead_domain();
drop policy evidence_insert on public.lead_evidence;
drop policy evidence_update on public.lead_evidence;
create policy evidence_insert on public.lead_evidence for insert to authenticated with check(private.is_org_admin(org_id) and (reviewed_by is null or reviewed_by=auth.uid()));
create policy evidence_update on public.lead_evidence for update to authenticated using(private.is_org_admin(org_id)) with check(private.is_org_admin(org_id) and (reviewed_by is null or reviewed_by=auth.uid()));

create table public.lead_score_overrides(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),lead_id uuid not null,
 score smallint not null check(score between 0 and 100),reason text not null check(length(trim(reason)) between 10 and 1000),
 actor_id uuid not null default auth.uid() references auth.users(id),created_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id)
);
alter table public.lead_score_overrides enable row level security;
create policy override_read on public.lead_score_overrides for select to authenticated using(private.is_org_member(org_id));
create policy override_insert on public.lead_score_overrides for insert to authenticated with check(private.is_org_admin(org_id) and actor_id=auth.uid());
grant select,insert on public.lead_score_overrides to authenticated;
create trigger override_audit after insert on public.lead_score_overrides for each row execute function private.audit_crm_change();
create trigger tasks_audit after insert or update on public.tasks for each row execute function private.audit_crm_change();

-- Safe partial edits of company/contact records, preserving all consent/suppression.
create function public.edit_lead(p_org uuid,p_lead uuid,p_input jsonb) returns void language plpgsql security invoker set search_path='' as $$
declare cid uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 update public.leads set business_name=p_input->>'business_name',website_url=nullif(p_input->>'website_url',''),city=p_input->>'city',business_category=p_input->>'business_category',source_url=nullif(p_input->>'source_url','') where org_id=p_org and id=p_lead;
 if not found then raise exception 'NOT_FOUND';end if;
 select id into cid from public.contacts where org_id=p_org and lead_id=p_lead order by created_at limit 1;
 if coalesce(p_input->>'email','')<>'' then
  if cid is null then insert into public.contacts(org_id,lead_id,email,email_normalized) values(p_org,p_lead,p_input->>'email',lower(trim(p_input->>'email')));
  else update public.contacts set email=p_input->>'email',email_normalized=lower(trim(p_input->>'email')),verified_at=null where org_id=p_org and id=cid;end if;
 end if;
end $$;
revoke all on function public.edit_lead(uuid,uuid,jsonb) from public;
grant execute on function public.edit_lead(uuid,uuid,jsonb) to authenticated;
