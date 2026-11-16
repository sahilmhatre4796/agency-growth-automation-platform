create table public.ai_budgets(
 org_id uuid primary key references public.organizations(id), enabled boolean not null default false,
 daily_requests integer not null default 0 check(daily_requests between 0 and 10000),daily_tokens integer not null default 0 check(daily_tokens between 0 and 1000000),
 provider text not null default 'groq' check(provider in ('groq','gemini')),model text not null default '',free_tier_approved boolean not null default false
);
create table public.ai_usage(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),
 provider text not null,model text not null,reserved_tokens integer not null check(reserved_tokens>0),input_tokens integer,output_tokens integer,
 state text not null default 'reserved' check(state in ('reserved','completed','failed')),created_at timestamptz not null default now()
);
alter table public.ai_budgets enable row level security;
alter table public.ai_usage enable row level security;
create policy ai_budget_read on public.ai_budgets for select to authenticated using(private.is_org_admin(org_id));
create policy ai_usage_read on public.ai_usage for select to authenticated using(private.is_org_admin(org_id));
grant select on public.ai_budgets,public.ai_usage to authenticated;
create function public.reserve_ai_usage(p_org uuid,p_tokens integer) returns uuid language plpgsql security definer set search_path='' as $$
declare budget public.ai_budgets;reqs integer;tokens bigint;rid uuid;
begin
 select * into budget from public.ai_budgets where org_id=p_org for update;
 if not found or not budget.enabled or not budget.free_tier_approved or p_tokens<1 then raise exception 'AI_NOT_CONFIGURED';end if;
 select count(*),coalesce(sum(reserved_tokens),0) into reqs,tokens from public.ai_usage where org_id=p_org and created_at>=date_trunc('day',now());
 if reqs>=budget.daily_requests or tokens+p_tokens>budget.daily_tokens then raise exception 'QUOTA_EXHAUSTED';end if;
 insert into public.ai_usage(org_id,provider,model,reserved_tokens) values(p_org,budget.provider,budget.model,p_tokens) returning id into rid;
 return rid;
end $$;
revoke all on function public.reserve_ai_usage(uuid,integer) from public;
-- Supabase creates service_role. Embedded tests create the same role explicitly.
grant execute on function public.reserve_ai_usage(uuid,integer) to service_role;
grant all on public.ai_budgets,public.ai_usage to service_role;
alter table public.outbound_drafts add column language text not null default 'en' check(language in ('en','hi','hinglish'));
alter table public.outbound_drafts add column prompt_version text;
alter table public.outbound_drafts add column model_id text;
alter table public.outbound_drafts add column claims_reviewed boolean not null default false;
alter table public.outbound_drafts add constraint draft_body_length check(length(body) between 1 and 3000);
alter table public.outbound_drafts add constraint draft_subject_length check(subject is null or length(subject) between 1 and 160);
create function public.edit_draft(p_org uuid,p_draft uuid,p_subject text,p_body text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 update public.outbound_drafts set subject=p_subject,body=p_body,state='needs_review',approval_by=null,approved_at=null,approved_sha256=null,claims_reviewed=false,updated_at=now() where org_id=p_org and id=p_draft and state in ('draft','needs_review','approved','rejected');
 if not found then raise exception 'DRAFT_LOCKED_OR_MISSING';end if;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),'draft_edited','outbound_drafts',p_draft);
end $$;
revoke all on function public.edit_draft(uuid,uuid,text,text) from public;
grant execute on function public.edit_draft(uuid,uuid,text,text) to authenticated;
