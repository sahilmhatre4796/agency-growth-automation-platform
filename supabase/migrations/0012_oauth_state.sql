create table private.oauth_states(
 state_hash text primary key,org_id uuid not null,user_id uuid not null,
 profile text not null check(profile in ('mail','calendar')),verifier_ciphertext bytea not null,verifier_iv bytea not null,
 redirect_uri text not null,created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '10 minutes',
 foreign key(org_id,user_id) references public.memberships(org_id,user_id)
);
alter table private.oauth_states enable row level security;
revoke all on private.oauth_states from public,anon,authenticated;
grant all on private.oauth_states to service_role;
create function public.store_oauth_state(p_hash text,p_org uuid,p_user uuid,p_profile text,p_ciphertext bytea,p_iv bytea,p_redirect text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_user and role='admin') then raise exception 'FORBIDDEN';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,5));
 if (select count(*) from private.oauth_states where user_id=p_user and created_at>now()-interval '10 minutes')>=5 then raise exception 'OAUTH_RATE_LIMITED';end if;
 if p_hash!~'^[a-f0-9]{64}$' or octet_length(p_iv)<>12 then raise exception 'INVALID_STATE';end if;
 delete from private.oauth_states where expires_at<now();
 insert into private.oauth_states(state_hash,org_id,user_id,profile,verifier_ciphertext,verifier_iv,redirect_uri) values(p_hash,p_org,p_user,p_profile,p_ciphertext,p_iv,p_redirect);
end $$;
create function public.consume_oauth_state(p_hash text) returns setof private.oauth_states language plpgsql security definer set search_path='' as $$
begin
 return query delete from private.oauth_states s where s.state_hash=p_hash and s.expires_at>now() and exists(select 1 from public.memberships m where m.org_id=s.org_id and m.user_id=s.user_id and m.role='admin') returning s.*;
end $$;
create function public.save_oauth_connection(p_org uuid,p_provider text,p_account text,p_scopes text[],p_ciphertext bytea,p_iv bytea,p_expires timestamptz,p_actor uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare cid uuid;
begin
 if p_provider not in ('gmail','calendar') or not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and role='admin') or octet_length(p_iv)<>12 then raise exception 'FORBIDDEN';end if;
 insert into public.external_connections(org_id,provider,provider_account_id,state,verified_at,scopes) values(p_org,p_provider,p_account,'connected',now(),p_scopes)
 on conflict(provider,provider_account_id) do update set state='connected',verified_at=now(),scopes=excluded.scopes where public.external_connections.org_id=p_org returning id into cid;
 if cid is null then raise exception 'ACCOUNT_ORGANIZATION_CONFLICT';end if;
 insert into private.oauth_secrets(connection_id,ciphertext,iv,expires_at) values(cid,p_ciphertext,p_iv,p_expires) on conflict(connection_id) do update set ciphertext=excluded.ciphertext,iv=excluded.iv,expires_at=excluded.expires_at,updated_at=now();
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,p_actor,'google_connected','external_connections',cid);
 return cid;
end $$;
revoke all on function public.store_oauth_state(text,uuid,uuid,text,bytea,bytea,text) from public;
revoke all on function public.consume_oauth_state(text) from public;
revoke all on function public.save_oauth_connection(uuid,text,text,text[],bytea,bytea,timestamptz,uuid) from public;
grant execute on function public.store_oauth_state(text,uuid,uuid,text,bytea,bytea,text),public.consume_oauth_state(text),public.save_oauth_connection(uuid,text,text,text[],bytea,bytea,timestamptz,uuid) to service_role;
