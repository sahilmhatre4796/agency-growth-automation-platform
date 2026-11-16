create table public.notifications(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),
 title text not null,kind text not null,lead_id uuid,acknowledged_at timestamptz,created_at timestamptz not null default now(),
 foreign key(org_id,lead_id) references public.leads(org_id,id)
);
alter table public.notifications enable row level security;
create policy notifications_read on public.notifications for select to authenticated using(private.is_org_member(org_id));
grant select on public.notifications to authenticated;
create function public.acknowledge_notification(p_org uuid,p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_member(p_org) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 update public.notifications set acknowledged_at=now() where org_id=p_org and id=p_id;
end $$;
revoke all on function public.acknowledge_notification(uuid,uuid) from public;
grant execute on function public.acknowledge_notification(uuid,uuid) to authenticated;
create function public.pause_outbound(p_org uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 update public.organizations set outbound_paused=true where id=p_org;
 update public.campaigns set state='paused' where org_id=p_org and state='active';
 update public.jobs set state='suppressed',last_error_code='WORKSPACE_PAUSED',updated_at=now() where org_id=p_org and kind in ('email.send','whatsapp.send','calendar.book','voice.call') and state in ('queued','leased');
 insert into public.audit_events(org_id,actor_id,action) values(p_org,auth.uid(),'outbound_paused');
end $$;
revoke all on function public.pause_outbound(uuid) from public;
grant execute on function public.pause_outbound(uuid) to authenticated;

create function private.qualified_notification() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='qualified' and old.status is distinct from new.status and not new.is_demo then
  insert into public.notifications(org_id,lead_id,title,kind) values(new.org_id,new.id,'Lead marked qualified — review source evidence','qualified_lead');
 end if;return new;
end $$;
revoke all on function private.qualified_notification() from public;
create trigger lead_qualified_notification after update on public.leads for each row execute function private.qualified_notification();

create function public.workspace_metrics(p_org uuid) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare result jsonb;
begin
 if not private.is_org_member(p_org) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 select jsonb_build_object('total_leads',count(*),'new_leads',count(*) filter(where status='new'),'qualified',count(*) filter(where status='qualified'),'won',count(*) filter(where status='won'),'revenue_paise',coalesce(sum(deal_value_paise) filter(where status='won'),0)) into result from public.leads where org_id=p_org and not is_demo;
 return result||jsonb_build_object('meetings_held',(select count(*) from public.appointments a join public.leads l on a.lead_id=l.id and a.org_id=l.org_id where a.org_id=p_org and a.state='completed' and not l.is_demo),'drafts',(select count(*) from public.outbound_drafts d join public.leads l on d.lead_id=l.id and d.org_id=l.org_id where d.org_id=p_org and not l.is_demo),'confirmed_outbound_events',(select count(*) from public.message_events e join public.leads l on e.lead_id=l.id and e.org_id=l.org_id where e.org_id=p_org and e.direction='outbound' and e.provider_message_id is not null and not l.is_demo));
end $$;
revoke all on function public.workspace_metrics(uuid) from public;
grant execute on function public.workspace_metrics(uuid) to authenticated;
create function public.record_export(p_org uuid,p_count integer) returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) or p_count<0 or p_count>1000 then raise exception 'FORBIDDEN' using errcode='42501';end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,safe_context) values(p_org,auth.uid(),'leads_exported','leads',jsonb_build_object('reported_row_count',p_count));
end $$;
revoke all on function public.record_export(uuid,integer) from public;
grant execute on function public.record_export(uuid,integer) to authenticated;
