-- Configuration remains inert until a separate, reviewed live-approval change.
create or replace function public.assign_lead_sender(p_org uuid,p_campaign uuid,p_lead uuid,p_connection uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if not exists(select 1 from public.campaign_sender_policies where org_id=p_org and campaign_id=p_campaign and mode='manual') or not exists(select 1 from public.external_connections where org_id=p_org and id=p_connection and provider='gmail') then raise exception 'INVALID_ASSIGNMENT'; end if;
 if exists(select 1 from public.gmail_threads where org_id=p_org and campaign_id=p_campaign and lead_id=p_lead and connection_id<>p_connection)
   or exists(select 1 from public.email_outbox where org_id=p_org and campaign_id=p_campaign and lead_id=p_lead and sender_connection_id<>p_connection and state in ('queued','leased','uncertain','sent')) then raise exception 'SENDER_PINNED'; end if;
 insert into public.lead_sender_assignments(org_id,campaign_id,lead_id,connection_id,assigned_by) values(p_org,p_campaign,p_lead,p_connection,auth.uid())
 on conflict(campaign_id,lead_id) do update set connection_id=excluded.connection_id,assigned_by=excluded.assigned_by,assigned_at=now();
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'lead_sender_assigned','leads',p_lead);
end $$;

create function public.configure_email_org_limits(p_org uuid,p_daily integer,p_monthly integer,p_timezone text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if p_daily not between 0 and 500 or p_monthly not between 0 and 10000 or
   not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'INVALID_ORG_LIMIT'; end if;
 update public.organizations set email_daily_cap=p_daily,email_monthly_cap=p_monthly,email_timezone=p_timezone where id=p_org;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'email_org_limits_updated','organizations',p_org);
end $$;

create function public.assign_draft_campaign(p_org uuid,p_draft uuid,p_campaign uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 if not exists(select 1 from public.campaigns where id=p_campaign and org_id=p_org and channel='email' and state in ('draft','paused','active')) then raise exception 'CAMPAIGN_NOT_FOUND'; end if;
 update public.outbound_drafts set campaign_id=p_campaign,state='needs_review',
  approval_by=null,approved_at=null,approved_sha256=null,claims_reviewed=false,updated_at=now()
  where id=p_draft and org_id=p_org and channel='email' and state in ('draft','needs_review','approved','rejected');
 if not found then raise exception 'DRAFT_LOCKED_OR_MISSING'; end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'email_draft_campaign_assigned','outbound_drafts',p_draft);
end $$;

revoke execute on function public.configure_email_org_limits(uuid,integer,integer,text),public.assign_draft_campaign(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.configure_email_org_limits(uuid,integer,integer,text),public.assign_draft_campaign(uuid,uuid,uuid) to authenticated;

create function public.gmail_analytics(p_org uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN'; end if;
 select jsonb_build_object(
  'provider_accepted',(select count(*) from public.email_outbox where org_id=p_org and state='sent'),
  'failed_attempts',(select count(*) from public.email_outbox where org_id=p_org and state in ('failed','uncertain')),
  'replies',(select count(*) from public.gmail_messages where org_id=p_org and direction='inbound'),
  'positive_responses',(select count(*) from public.gmail_messages where org_id=p_org and direction='inbound' and classification='interested'),
  'meeting_requests',(select count(*) from public.gmail_messages where org_id=p_org and direction='inbound' and classification='meeting_request'),
  'qualified_linked_leads',(select count(distinct l.id) from public.leads l join public.gmail_threads t on t.org_id=l.org_id and t.lead_id=l.id where l.org_id=p_org and l.status='qualified'),
  'confirmed_linked_appointments',(select count(distinct a.id) from public.appointments a join public.gmail_threads t on t.org_id=a.org_id and t.lead_id=a.lead_id where a.org_id=p_org and a.state='confirmed'),
  'campaigns',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'state',c.state,
    'accepted',(select count(*) from public.email_outbox o where o.campaign_id=c.id and o.org_id=p_org and o.state='sent'),
    'pending',(select count(*) from public.email_outbox o where o.campaign_id=c.id and o.org_id=p_org and o.state in ('queued','held','leased','uncertain'))
  ) order by c.created_at desc) from public.campaigns c where c.org_id=p_org and c.channel='email'),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke execute on function public.gmail_analytics(uuid) from public,anon,authenticated;
grant execute on function public.gmail_analytics(uuid) to authenticated;
