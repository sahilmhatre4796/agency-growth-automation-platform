-- Resolving an ambiguous identity must preserve a listing's unconfirmed URL
-- on the new provenance record, never on the lead's official website field.
create function private.preserve_candidate_website_proposal()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='resolved' and old.state='review_needed' and new.resolved_lead_id is not null
  and new.website_url is not null then
  update public.lead_discovery_sources set proposed_website_url=new.website_url
   where org_id=new.org_id and lead_id=new.resolved_lead_id
    and discovery_run_id=new.discovery_run_id and source=new.source
    and source_url=new.source_url
    and (new.provider_record_id is null or provider_record_id=new.provider_record_id);
 end if;
 return new;
end $$;
create trigger discovery_candidate_proposal_after_resolution
after update of state on public.discovery_candidates
for each row execute function private.preserve_candidate_website_proposal();
