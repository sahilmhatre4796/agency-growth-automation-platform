-- OSM and search listings can name a website without proving ownership or
-- reachability. Preserve the proposal, never promote it into the lead URL.
alter table public.lead_discovery_sources add column proposed_website_url text;
alter function public.ingest_discovered_business(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz) set schema private;
revoke all on function private.ingest_discovered_business(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz) from public,anon,authenticated;

create function public.ingest_discovered_business(p_org uuid,p_run uuid,p_source text,p_provider text,p_name text,p_website text,p_city text,p_state text,p_country text,p_source_url text,p_provider_record_id text,p_observed_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; proposed_host text;
begin
 if p_website is not null then
  proposed_host:=lower(split_part(split_part(p_website,'/',3),':',1));
  if p_website !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(/[^ ]*)?$'
   or proposed_host ~ '(^|\.)(localhost|local|internal)$'
   or length(p_website)>2000 then raise exception 'INVALID_PROPOSED_WEBSITE'; end if;
 end if;
 -- Passing null prevents a provider assertion from becoming a confirmed
 -- website or a deduplication key. Existing name/location/provider-ID checks
 -- still apply, and ambiguous identities remain in review.
 result:=private.ingest_discovered_business(p_org,p_run,p_source,p_provider,p_name,null,
  p_city,p_state,p_country,p_source_url,p_provider_record_id,p_observed_at);
 if p_website is not null and result->>'state' in ('created','matched') then
  update public.lead_discovery_sources set proposed_website_url=p_website
   where org_id=p_org and discovery_run_id=p_run and lead_id=(result->>'lead_id')::uuid
    and source=p_source and source_url=p_source_url;
 elsif p_website is not null and result->>'state'='review_needed' then
  update public.discovery_candidates set website_url=p_website
   where org_id=p_org and id=(result->>'candidate_id')::uuid;
 end if;
 return result;
end $$;
revoke execute on function public.ingest_discovered_business(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz)
 from public,anon,authenticated;
grant execute on function public.ingest_discovered_business(uuid,uuid,text,text,text,text,text,text,text,text,text,timestamptz)
 to service_role;
