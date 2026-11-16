-- Contact endpoints carry consent, verification, thread and suppression context.
-- A corrected address is a new contact that must pass those gates independently.
create function private.keep_contact_endpoint_identity() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.email is distinct from old.email or new.email_normalized is distinct from old.email_normalized
   or new.phone_e164 is distinct from old.phone_e164 or new.org_id is distinct from old.org_id
   or new.lead_id is distinct from old.lead_id then
  raise exception 'CONTACT_ENDPOINT_IMMUTABLE';
 end if;
 return new;
end $$;
create trigger contact_endpoint_immutable before update on public.contacts
 for each row execute function private.keep_contact_endpoint_identity();
revoke execute on function private.keep_contact_endpoint_identity() from public,anon,authenticated;

create or replace function public.edit_lead(p_org uuid,p_lead uuid,p_input jsonb)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if p_input ? 'email' or p_input ? 'phone_e164' then raise exception 'CONTACT_ENDPOINT_EDIT_REVIEW_REQUIRED'; end if;
 update public.leads set business_name=p_input->>'business_name',
  website_url=nullif(p_input->>'website_url',''),city=p_input->>'city',
  business_category=p_input->>'business_category',source_url=nullif(p_input->>'source_url','')
  where org_id=p_org and id=p_lead;
 if not found then raise exception 'NOT_FOUND'; end if;
end $$;

create function public.update_contact_profile(p_org uuid,p_lead uuid,p_contact uuid,p_name text,p_role text,p_source_url text)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if length(coalesce(p_name,''))>160 or length(coalesce(p_role,''))>100
   or length(coalesce(p_source_url,''))>500
   or (nullif(p_source_url,'') is not null and p_source_url !~ '^https?://[^ /]+') then
  raise exception 'INVALID_CONTACT_PROFILE';
 end if;
 update public.contacts set contact_name=nullif(trim(p_name),''),role=nullif(trim(p_role),''),
   source_url=nullif(trim(p_source_url),'')
   where org_id=p_org and lead_id=p_lead and id=p_contact;
 if not found then raise exception 'NOT_FOUND'; end if;
end $$;
revoke all on function public.update_contact_profile(uuid,uuid,uuid,text,text,text) from public,anon;
grant execute on function public.update_contact_profile(uuid,uuid,uuid,text,text,text) to authenticated;

create function public.add_reviewed_contact(p_org uuid,p_lead uuid,p_email text,p_source_url text,p_review_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare normalized text; result uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 normalized:=lower(trim(coalesce(p_email,'')));
 if length(normalized)>254 or normalized !~ '^[^ @[:cntrl:]]+@[^ @[:cntrl:]]+\.[^ @[:cntrl:]]+$'
   or p_source_url is null or length(p_source_url)>500 or p_source_url !~ '^https?://[^ /]+'
   or length(trim(coalesce(p_review_note,'')))<15 or length(p_review_note)>1000 then
  raise exception 'CONTACT_REVIEW_REQUIRED';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text||':'||normalized,0));
 perform 1 from public.leads where org_id=p_org and id=p_lead for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if exists(select 1 from public.contacts where org_id=p_org and email_normalized=normalized) then
  raise exception 'CONTACT_DUPLICATE_REVIEW_REQUIRED';
 end if;
 insert into public.contacts(org_id,lead_id,email,email_normalized,source_url)
  values(p_org,p_lead,normalized,normalized,p_source_url) returning id into result;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
  values(p_org,auth.uid(),'contact_added_after_review','contacts',result,
    jsonb_build_object('review_note',trim(p_review_note),'source_url',p_source_url));
 return result;
end $$;
revoke all on function public.add_reviewed_contact(uuid,uuid,text,text,text) from public,anon;
grant execute on function public.add_reviewed_contact(uuid,uuid,text,text,text) to authenticated;
