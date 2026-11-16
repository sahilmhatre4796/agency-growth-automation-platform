-- Scrapling extracts public contacts from pages already fetched on the
-- lead's recorded official domain. It is another evidence source, never a
-- mailbox verification, an official-site audit or outreach permission.
alter table public.vibe_contact_sources drop constraint vibe_contact_sources_source_provider_check;
alter table public.vibe_contact_sources add constraint vibe_contact_sources_source_provider_check check
 (source_provider in ('serper','harvey','vibe','official_website','overture','scrapling'));

create or replace function public.record_vibe_contact_observations(
 p_org uuid,p_lead uuid,p_provider text,p_observations jsonb
) returns integer language plpgsql security definer set search_path='' as $$
declare item jsonb; point_id uuid; point_kind text; raw_value text; normalized text; source_link text;
 observed timestamptz; confidence numeric; added integer:=0; excerpt text;
begin
 if p_provider is null or p_provider not in ('serper','harvey','vibe','official_website','scrapling')
  or jsonb_typeof(p_observations)<>'array' or jsonb_array_length(p_observations)>20
  then raise exception 'INVALID_CONTACT_BATCH'; end if;
 if not exists(select 1 from public.leads where org_id=p_org and id=p_lead and not is_demo)
  then raise exception 'CONTACT_LEAD_NOT_FOUND'; end if;
 if p_provider in ('serper','harvey') and not exists(
  select 1 from public.lead_discovery_sources where org_id=p_org and lead_id=p_lead and source=p_provider)
  then raise exception 'DISCOVERY_SOURCE_NOT_MATCHED'; end if;
 for item in select value from jsonb_array_elements(p_observations) loop
  point_kind:=item->>'kind'; raw_value:=trim(coalesce(item->>'value',''));
  source_link:=item->>'source_url'; excerpt:=trim(coalesce(item->>'evidence_excerpt',''));
  if point_kind not in ('email','phone','whatsapp') or length(raw_value) not between 3 and 254
   or length(excerpt) not between 5 and 320 or position(lower(raw_value) in lower(excerpt))=0
   or source_link !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
   or length(coalesce(item->>'contact_name',''))>160 or length(coalesce(item->>'role',''))>100
   or (item->>'contact_name' is not null and position(lower(item->>'contact_name') in lower(excerpt))=0)
   or (item->>'role' is not null and position(lower(item->>'role') in lower(excerpt))=0)
   then raise exception 'INVALID_CONTACT_EVIDENCE'; end if;
  observed:=(item->>'observed_at')::timestamptz;
  confidence:=(item->>'confidence')::numeric;
  if observed not between now()-interval '30 days' and now()+interval '5 minutes'
   or confidence not between 0 and 1 then raise exception 'STALE_CONTACT_EVIDENCE'; end if;
  if point_kind='email' then
   normalized:=lower(raw_value);
   if normalized !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    or normalized like '%..%' then raise exception 'INVALID_CONTACT_EMAIL'; end if;
  else
   normalized:=regexp_replace(raw_value,'[[:space:]().-]','','g');
   if normalized !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'INVALID_CONTACT_PHONE'; end if;
   if point_kind='whatsapp' and excerpt !~* '(whatsapp|wa\.me|api\.whatsapp)'
    then raise exception 'WHATSAPP_NOT_EXPLICIT'; end if;
  end if;
  -- A provider URL must be connected to the resolved business. An official
  -- website URL may instead match the already recorded business domain.
  if not exists(select 1 from public.lead_discovery_sources d
   where d.org_id=p_org and d.lead_id=p_lead and d.source_url=source_link)
   and not exists(select 1 from public.leads l where l.org_id=p_org and l.id=p_lead and l.website_url=source_link)
   and not exists(select 1 from public.lead_evidence e where e.org_id=p_org and e.lead_id=p_lead
    and e.source_url=source_link and e.source_type in ('serper','serper_website','tavily_website'))
   and not exists(select 1 from public.leads l where l.org_id=p_org and l.id=p_lead
    and l.normalized_domain is not null and
    regexp_replace(lower(split_part(split_part(source_link,'/',3),':',1)),'^www\.','')=l.normalized_domain)
   then raise exception 'CONTACT_SOURCE_IDENTITY_UNCONFIRMED'; end if;
  insert into public.vibe_contact_points(org_id,lead_id,kind,normalized_value,display_value,
   contact_name,role,first_discovered_at,last_cross_checked_at)
   values(p_org,p_lead,point_kind,normalized,raw_value,nullif(item->>'contact_name',''),
    nullif(item->>'role',''),observed,observed)
  on conflict(org_id,lead_id,kind,normalized_value) do update set
    last_cross_checked_at=greatest(public.vibe_contact_points.last_cross_checked_at,excluded.last_cross_checked_at)
   returning id into point_id;
  insert into public.vibe_contact_sources(org_id,lead_id,point_id,source_provider,source_url,
   evidence_excerpt,observed_at,confidence)
   values(p_org,p_lead,point_id,p_provider,source_link,excerpt,observed,confidence)
   on conflict do nothing;
  added:=added+1;
 end loop;
 return added;
end $$;
revoke execute on function public.record_vibe_contact_observations(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.record_vibe_contact_observations(uuid,uuid,text,jsonb) to service_role;
