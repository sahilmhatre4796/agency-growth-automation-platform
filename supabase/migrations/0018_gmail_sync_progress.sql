-- Each mailbox advances independently; a crash resumes at the last committed page.
alter table public.gmail_sync_cursors
 add column bootstrap_history_id text,
 add column inbox_page_token text,
 add column sent_page_token text,
 add column history_page_token text,
 add column initial_inbox_complete boolean not null default false,
 add column initial_sent_complete boolean not null default false,
 add column lease_token uuid,
 add column lease_until timestamptz;

create function public.lease_gmail_sync(p_limit integer default 2)
returns setof public.gmail_sync_cursors language plpgsql security definer set search_path='' as $$
begin
 if p_limit not between 1 and 5 then raise exception 'INVALID_BATCH_SIZE'; end if;
 return query with candidates as (
  select s.connection_id from public.gmail_sync_cursors s
   join public.external_connections c on c.id=s.connection_id and c.org_id=s.org_id
  where c.provider='gmail' and c.state='connected'
   and 'https://www.googleapis.com/auth/gmail.readonly'=any(c.scopes)
   and (s.next_run_at is null or s.next_run_at<=now())
   and (s.lease_until is null or s.lease_until<now())
  order by s.last_success_at nulls first,s.connection_id for update of s skip locked limit p_limit
 ) update public.gmail_sync_cursors s set lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes'
 from candidates c where s.connection_id=c.connection_id returning s.*;
end $$;

create function public.advance_gmail_sync(p_connection uuid,p_token uuid,p_kind text,p_next_page text,p_history text,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
declare s public.gmail_sync_cursors;
begin
 select * into s from public.gmail_sync_cursors where connection_id=p_connection and lease_token=p_token and lease_until>now() for update;
 if not found then raise exception 'SYNC_LEASE_INVALID'; end if;
 if p_kind not in ('inbox','sent','history','bootstrap','error','reset') or length(coalesce(p_next_page,''))>1000
   or length(coalesce(p_history,''))>100 or length(coalesce(p_error,''))>80 then raise exception 'INVALID_SYNC_PROGRESS'; end if;
 update public.gmail_sync_cursors set
  bootstrap_history_id=case when p_kind='bootstrap' then p_history when p_kind='reset' then null else bootstrap_history_id end,
  inbox_page_token=case when p_kind='inbox' then p_next_page when p_kind='reset' then null else inbox_page_token end,
  sent_page_token=case when p_kind='sent' then p_next_page when p_kind='reset' then null else sent_page_token end,
  history_page_token=case when p_kind='history' then p_next_page when p_kind='reset' then null else history_page_token end,
  initial_inbox_complete=case when p_kind='reset' then false when p_kind='inbox' and p_next_page is null then true else initial_inbox_complete end,
  initial_sent_complete=case when p_kind='reset' then false when p_kind='sent' and p_next_page is null then true else initial_sent_complete end,
  history_id=case when p_kind='reset' then null when p_kind='history' and p_next_page is null then p_history else history_id end,
  last_inbox_sync_at=case when p_kind='inbox' and p_next_page is null then now() else last_inbox_sync_at end,
  last_sent_sync_at=case when p_kind='sent' and p_next_page is null then now() else last_sent_sync_at end,
  last_success_at=case when p_kind in ('inbox','sent','history') and p_error is null then now() else last_success_at end,
  last_error_code=p_error,
  next_run_at=case when p_error is not null then now()+interval '15 minutes' when p_next_page is null then now()+interval '5 minutes' else now() end,
  lease_token=null,lease_until=null
 where connection_id=p_connection;
 if p_kind='sent' and p_next_page is null then
  update public.gmail_sync_cursors set history_id=coalesce(history_id,bootstrap_history_id)
  where connection_id=p_connection and initial_inbox_complete and initial_sent_complete;
 end if;
 if p_kind='inbox' and p_next_page is null then
  update public.gmail_sync_cursors set history_id=coalesce(history_id,bootstrap_history_id)
  where connection_id=p_connection and initial_inbox_complete and initial_sent_complete;
 end if;
end $$;

revoke execute on function public.lease_gmail_sync(integer),public.advance_gmail_sync(uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.lease_gmail_sync(integer),public.advance_gmail_sync(uuid,uuid,text,text,text,text) to service_role;
