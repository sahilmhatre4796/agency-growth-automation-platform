-- Owner-reviewed Overture export intake. An export is a source observation,
-- never an official-site audit, mailbox verification, or outreach permission.
alter table public.leads drop constraint leads_source_type_check;
alter table public.leads add constraint leads_source_type_check check
 (source_type in ('inbound','referral','manual','csv','approved_source','meta_form','serper','harvey','overture'));
alter table public.lead_discovery_sources drop constraint lead_discovery_sources_source_check;
alter table public.lead_discovery_sources add constraint lead_discovery_sources_source_check check
 (source in ('serper','harvey','manual','csv','referral','inbound','meta_form','overture'));
alter table public.vibe_contact_sources drop constraint vibe_contact_sources_source_provider_check;
alter table public.vibe_contact_sources add constraint vibe_contact_sources_source_provider_check check
 (source_provider in ('serper','harvey','vibe','official_website','overture'));
alter table public.lead_discovery_sources add column source_metadata jsonb not null default '{}'::jsonb
 check (jsonb_typeof(source_metadata)='object');

create function public.promote_reviewed_overture_place(p_org uuid,p_place jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare place_id text; release_id text; place_name text; category text; target_city text; target_region text;
 country_name text; website text; owner_review_note text; identity_claim text; observed timestamptz;
 source_link text:='https://explore.overturemaps.org/'; source_item jsonb;
 clean_sources jsonb:='[]'::jsonb;
 emails text[]; phones text[]; item text; duplicates uuid[]; existing_lead uuid;
 imported jsonb; saved_lead_id uuid; source_id uuid; evidence_id uuid; point_id uuid;
 pending_count integer:=0; source_excerpt text;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if jsonb_typeof(p_place)<>'object' then raise exception 'INVALID_OVERTURE_PLACE'; end if;
 place_id:=lower(trim(coalesce(p_place->>'id','')));
 release_id:=trim(coalesce(p_place->>'release',''));
 place_name:=trim(regexp_replace(coalesce(p_place->>'name',''),'\s+',' ','g'));
 category:=trim(coalesce(p_place->>'category',''));
 target_city:=trim(coalesce(p_place->>'city',''));
 target_region:=trim(coalesce(p_place->>'state_region',''));
 country_name:=trim(coalesce(p_place->>'country',''));
 owner_review_note:=trim(coalesce(p_place->>'review_note',''));
 website:=nullif(trim(coalesce(p_place->>'website_url','')),'');
 if place_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or release_id !~ '^20[0-9]{2}-(0[1-9]|1[0-2])-[0-3][0-9]\.[0-9]+$'
  or length(place_name) not between 2 and 100 or length(category) not between 2 and 100
  or length(target_city) not between 2 and 100 or length(target_region) not between 2 and 120
  or length(country_name) not between 2 and 120 or length(owner_review_note) not between 20 and 500
  or coalesce(p_place->>'source_url','')<>source_link
  or (website is not null and (length(website)>2000 or website !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'))
  then raise exception 'INVALID_OVERTURE_PLACE'; end if;
 if lower(country_name) in ('us','usa','united states','united states of america') then country_name:='USA'; end if;
 if lower(target_region) in ('ca','california') and country_name='USA' then target_region:='California'; end if;
 if jsonb_typeof(p_place->'sources')<>'array' or jsonb_array_length(p_place->'sources') not between 1 and 20
  or length((p_place->'sources')::text)>6000
  or jsonb_typeof(p_place->'emails')<>'array' or jsonb_array_length(p_place->'emails')>10
  or jsonb_typeof(p_place->'phones')<>'array' or jsonb_array_length(p_place->'phones')>10
  then raise exception 'INVALID_OVERTURE_SOURCE'; end if;
 for source_item in select value from jsonb_array_elements(p_place->'sources') loop
  if jsonb_typeof(source_item)<>'object' or length(trim(coalesce(source_item->>'dataset',''))) not between 2 and 80
   or length(trim(coalesce(source_item->>'record_id',source_item->>'recordId',''))) not between 1 and 300
   or length(coalesce(source_item->>'property',''))>120
   or length(coalesce(source_item->>'license',''))>120
   or length(coalesce(source_item->>'update_time',''))>80
   then raise exception 'INVALID_OVERTURE_SOURCE'; end if;
  clean_sources:=clean_sources||jsonb_build_array(jsonb_build_object(
   'dataset',trim(source_item->>'dataset'),
   'record_id',trim(coalesce(source_item->>'record_id',source_item->>'recordId')),
   'property',nullif(trim(coalesce(source_item->>'property','')),''),
   'license',nullif(trim(coalesce(source_item->>'license','')),''),
   'update_time',nullif(trim(coalesce(source_item->>'update_time','')),'')));
 end loop;
 observed:=coalesce(nullif(p_place->>'observed_at','')::timestamptz,now());
 if observed<now()-interval '30 days' or observed>now()+interval '5 minutes' then
  raise exception 'STALE_OVERTURE_EXPORT'; end if;
 select coalesce(array_agg(distinct lower(trim(value))),'{}'::text[]) into emails
  from jsonb_array_elements_text(p_place->'emails') entry(value);
 select coalesce(array_agg(distinct trim(value)),'{}'::text[]) into phones
  from jsonb_array_elements_text(p_place->'phones') entry(value);
 foreach item in array emails loop
  if length(item) not between 6 and 254 or item !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$'
   or item like '%..%' then raise exception 'INVALID_OVERTURE_CONTACT'; end if;
 end loop;
 foreach item in array phones loop
  if item !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'INVALID_OVERTURE_CONTACT'; end if;
 end loop;
 identity_claim:=format('Overture Places %s lists %s in %s, %s.',release_id,place_name,target_city,target_region);
 if length(identity_claim)>180 then raise exception 'OVERTURE_CLAIM_TOO_LONG'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org::text,0));
 select s.lead_id into existing_lead from public.lead_discovery_sources s
  where s.org_id=p_org and s.source='overture' and s.provider_record_id=place_id;
 if found then return jsonb_build_object('state','already_recorded','lead_id',existing_lead); end if;
 select coalesce(array_agg(id),'{}'::uuid[]) into duplicates from (
  select l.id from public.leads l where l.org_id=p_org and not l.is_demo and (
   (lower(trim(regexp_replace(l.business_name,'\s+',' ','g')))=lower(place_name)
    and lower(coalesce(l.city,''))=lower(target_city)
    and (lower(coalesce(l.state_region,''))=lower(target_region)
      or (country_name='USA' and lower(coalesce(l.state_region,'')) in ('ca','california') and target_region='California'))
    and (lower(coalesce(l.country,''))=lower(country_name)
      or (country_name='USA' and lower(coalesce(l.country,'')) in ('us','united states','united states of america'))))
   or exists(select 1 from public.contacts c where c.org_id=p_org and c.lead_id=l.id
     and (c.email_normalized=any(emails) or c.phone_e164=any(phones)))
   or exists(select 1 from public.vibe_contact_points v where v.org_id=p_org and v.lead_id=l.id
     and ((v.kind='email' and v.normalized_value=any(emails))
       or (v.kind='phone' and v.normalized_value=any(phones))))
  ) order by l.id limit 20
 ) possible;
 if cardinality(duplicates)>0 then return jsonb_build_object('state','review_needed','possible_lead_ids',to_jsonb(duplicates)); end if;
 imported:=public.import_leads(p_org,jsonb_build_array(jsonb_build_object(
  'business_name',place_name,'source_type','approved_source','source_url',source_link,
  'source_observed_at',observed,'business_category',category,'city',target_city,
  'state_region',target_region,'country',country_name,'identity_claim',identity_claim)));
 if imported->>'added'<>'1' then raise exception 'OVERTURE_IMPORT_CONFLICT'; end if;
 saved_lead_id:=(imported->'created_lead_ids'->>0)::uuid;
 update public.leads set source_type='overture',status='researching',
  needs=case when website is null then
   'Conditional professional website opportunity; no website listed in Overture, independent checks pending.'
   else null end where org_id=p_org and id=saved_lead_id;
 update public.lead_discovery_sources set source='overture',actual_provider='overture_user_export',
  provider_record_id=place_id,proposed_website_url=website,
  source_metadata=jsonb_build_object('release',release_id,'sources',clean_sources,
   'attribution','Overture Maps Foundation; source datasets retained')
  where org_id=p_org and lead_id=saved_lead_id and source='manual' and actual_provider='approved_source'
   and source_url=source_link returning id into source_id;
 if source_id is null then raise exception 'OVERTURE_SOURCE_NOT_SAVED'; end if;
 update public.lead_evidence set source_type='overture',review_note=owner_review_note
  where org_id=p_org and lead_id=saved_lead_id
  and source_url=source_link and claim=identity_claim returning id into evidence_id;
 if evidence_id is null then raise exception 'OVERTURE_EVIDENCE_NOT_SAVED'; end if;
 insert into public.lead_website_assessments(org_id,lead_id,status,official_url,checks,evidence_ids,reason,confidence,observed_at)
 values(p_org,saved_lead_id,'UNKNOWN',null,'[]'::jsonb,array[evidence_id],
  case when website is null then 'Overture export has no website field; independent official-site checks are still required.'
   else 'Overture lists a website URL; ownership and reachability have not been independently checked.' end,
  0.3,observed);
 for item in select unnest(emails) loop
  insert into public.vibe_contact_points(org_id,lead_id,kind,normalized_value,display_value,first_discovered_at,last_cross_checked_at)
   values(p_org,saved_lead_id,'email',item,item,observed,observed) returning id into point_id;
  source_excerpt:='Overture Places '||place_id||' lists email '||item||'; source IDs retained in discovery metadata';
  insert into public.vibe_contact_sources(org_id,lead_id,point_id,source_provider,source_url,evidence_excerpt,observed_at,confidence)
   values(p_org,saved_lead_id,point_id,'overture',source_link,source_excerpt,observed,0.45);
  pending_count:=pending_count+1;
 end loop;
 for item in select unnest(phones) loop
  insert into public.vibe_contact_points(org_id,lead_id,kind,normalized_value,display_value,first_discovered_at,last_cross_checked_at)
   values(p_org,saved_lead_id,'phone',item,item,observed,observed) returning id into point_id;
  source_excerpt:='Overture Places '||place_id||' lists phone '||item||'; source IDs retained in discovery metadata';
  insert into public.vibe_contact_sources(org_id,lead_id,point_id,source_provider,source_url,evidence_excerpt,observed_at,confidence)
   values(p_org,saved_lead_id,point_id,'overture',source_link,source_excerpt,observed,0.45);
  pending_count:=pending_count+1;
 end loop;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'overture_reviewed_import','leads',saved_lead_id,
  jsonb_build_object('provider_record_id',place_id,'release',release_id,'pending_contacts',pending_count));
 return jsonb_build_object('state','created','lead_id',saved_lead_id,'pending_contacts',pending_count);
end $$;
revoke execute on function public.promote_reviewed_overture_place(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.promote_reviewed_overture_place(uuid,jsonb) to authenticated;
