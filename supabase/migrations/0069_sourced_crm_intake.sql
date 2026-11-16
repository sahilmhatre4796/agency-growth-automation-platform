-- Keep the facts supplied at intake together; none of them imply consent,
-- a verified mailbox, an official-site audit, or a reviewed service gap.
create or replace function public.import_leads(p_org uuid,p_rows jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb; lid uuid; added integer:=0; skipped integer:=0; domain text;
 source_kind text; source_link text; observed timestamptz; country_name text;
 address text; phone text; addresses text[]; phones text[]; created_ids uuid[]:='{}';
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if pg_catalog.jsonb_typeof(p_rows)<>'array' or pg_catalog.jsonb_array_length(p_rows)>500 then raise exception 'INVALID_IMPORT'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org::text,0));
 for item in select value from pg_catalog.jsonb_array_elements(p_rows) loop
  if length(trim(coalesce(item->>'business_name',''))) not between 2 and 160 then raise exception 'INVALID_BUSINESS_NAME'; end if;
  if coalesce(item->>'website_url','')<>'' and (item->>'website_url')!~'^https?://[^ /]+' then raise exception 'INVALID_WEBSITE'; end if;
  source_link:=nullif(trim(coalesce(item->>'source_url','')),'');
  if source_link is not null and (length(source_link)>500 or source_link!~'^https?://[^ /]+') then raise exception 'INVALID_SOURCE_URL'; end if;
  source_kind:=coalesce(nullif(item->>'source_type',''),'csv');
  if source_kind not in ('inbound','referral','manual','csv','approved_source','meta_form') then raise exception 'INVALID_SOURCE_TYPE'; end if;
  if length(coalesce(item->>'city',''))>100 or length(coalesce(item->>'state_region',''))>120
   or length(coalesce(item->>'country',''))>120 or length(coalesce(item->>'business_category',''))>100
   then raise exception 'INVALID_LOCATION'; end if;
  country_name:=nullif(trim(coalesce(item->>'country','')),'');
  if country_name is not null and source_link is null then raise exception 'COUNTRY_SOURCE_REQUIRED'; end if;
  if lower(country_name) in ('usa','us','united states','united states of america') then country_name:='USA'; end if;
  if length(trim(coalesce(item->>'identity_claim','')))>500 or
   (nullif(trim(coalesce(item->>'identity_claim','')),'') is not null and source_link is null)
   then raise exception 'IDENTITY_SOURCE_REQUIRED'; end if;
  observed:=coalesce(nullif(item->>'source_observed_at','')::timestamptz,now());
  if observed>now()+interval '5 minutes' then raise exception 'FUTURE_SOURCE_DATE'; end if;
  addresses:=array_remove(array_append(pg_catalog.regexp_split_to_array(coalesce(item->>'additional_emails',''),'[;,]'),coalesce(item->>'email','')),'');
  phones:=array_remove(pg_catalog.regexp_split_to_array(coalesce(item->>'phones',''),'[;,]'),'');
  if cardinality(addresses)>10 or cardinality(phones)>10 then raise exception 'CONTACT_BATCH_TOO_LARGE'; end if;
  foreach address in array addresses loop
   address:=lower(trim(address));
   if length(address)>254 or address!~'^[^ @[:cntrl:]]+@[^ @[:cntrl:]]+\.[^ @[:cntrl:]]+$'
    then raise exception 'INVALID_EMAIL'; end if;
  end loop;
  foreach phone in array phones loop
   phone:=trim(phone);
   if phone!~'^\+[1-9][0-9]{7,14}$' then raise exception 'INVALID_PHONE'; end if;
  end loop;
  domain:=nullif(lower(pg_catalog.regexp_replace(pg_catalog.split_part(pg_catalog.regexp_replace(coalesce(item->>'website_url',''),'^https?://',''),'/',1),'^www\.','')),'');
  lid:=null;
  insert into public.leads(org_id,business_name,website_url,normalized_domain,source_type,source_url,
   source_observed_at,business_category,city,state_region,country,is_demo)
  values(p_org,trim(item->>'business_name'),nullif(item->>'website_url',''),domain,source_kind,source_link,
   observed,nullif(trim(coalesce(item->>'business_category','')),''),nullif(trim(coalesce(item->>'city','')),''),
   nullif(trim(coalesce(item->>'state_region','')),''),country_name,false)
  on conflict do nothing returning id into lid;
  if lid is null then skipped:=skipped+1; continue; end if;
  created_ids:=array_append(created_ids,lid);
  if source_link is not null then
   insert into public.lead_discovery_sources(org_id,lead_id,source,actual_provider,source_url,observed_at,proposed_category,proposed_website_url)
   values(p_org,lid,case when source_kind in ('approved_source','meta_form') then 'manual' else source_kind end,
    source_kind,source_link,observed,nullif(trim(coalesce(item->>'business_category','')),''),nullif(item->>'website_url',''));
  end if;
  if nullif(trim(coalesce(item->>'identity_claim','')),'') is not null then
   insert into public.lead_evidence(org_id,lead_id,source_url,source_type,observed_at,claim,confidence,kind)
   values(p_org,lid,source_link,source_kind,observed,trim(item->>'identity_claim'),
    case when source_link like 'https://%' and domain is not null and
     lower(pg_catalog.regexp_replace(pg_catalog.split_part(source_link,'/',3),'^www\.',''))=domain
     then 0.8 else 0.5 end,'observation');
  end if;
  foreach address in array addresses loop
   address:=lower(trim(address));
   if exists(select 1 from public.contacts where org_id=p_org and email_normalized=address and lead_id<>lid)
    then raise exception 'CONTACT_OWNERSHIP_CONFLICT'; end if;
   if not exists(select 1 from public.contacts where org_id=p_org and lead_id=lid and email_normalized=address) then
    insert into public.contacts(org_id,lead_id,email,email_normalized,source_url)
    values(p_org,lid,address,address,source_link);
   end if;
  end loop;
  foreach phone in array phones loop
   phone:=trim(phone);
   if not exists(select 1 from public.contacts where org_id=p_org and lead_id=lid and phone_e164=phone) then
    insert into public.contacts(org_id,lead_id,phone_e164,source_url) values(p_org,lid,phone,source_link);
   end if;
  end loop;
  added:=added+1;
 end loop;
 return pg_catalog.jsonb_build_object('added',added,'skipped',skipped,'created_lead_ids',created_ids);
end $$;
revoke all on function public.import_leads(uuid,jsonb) from public,anon;
grant execute on function public.import_leads(uuid,jsonb) to authenticated;
