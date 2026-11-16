create table public.draft_approvals(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),draft_id uuid not null,
 actor_id uuid not null default auth.uid() references auth.users(id),subject text,body text not null,content_sha256 text not null,
 decision text not null check(decision in ('approved','rejected')),created_at timestamptz not null default now(),
 foreign key(org_id,draft_id) references public.outbound_drafts(org_id,id)
);
alter table public.draft_approvals enable row level security;
create policy approval_read on public.draft_approvals for select to authenticated using(private.is_org_admin(org_id));
grant select on public.draft_approvals to authenticated;
create function public.review_draft(p_org uuid,p_draft uuid,p_approved boolean,p_claims_reviewed boolean,p_expected_hash text) returns uuid language plpgsql security definer set search_path='' as $$
declare draft public.outbound_drafts;actual text;aid uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501';end if;
 select * into draft from public.outbound_drafts where org_id=p_org and id=p_draft for update;
 if not found or draft.state not in ('draft','needs_review') then raise exception 'DRAFT_LOCKED_OR_MISSING';end if;
 actual:=encode(sha256(convert_to(coalesce(draft.subject,'')||chr(10)||draft.body,'UTF8')),'hex');
 if actual<>p_expected_hash then raise exception 'STALE_REVIEW';end if;
 if p_approved and not p_claims_reviewed then raise exception 'FACTUAL_REVIEW_REQUIRED';end if;
 insert into public.draft_approvals(org_id,draft_id,actor_id,subject,body,content_sha256,decision) values(p_org,p_draft,auth.uid(),draft.subject,draft.body,actual,case when p_approved then 'approved' else 'rejected' end) returning id into aid;
 update public.outbound_drafts set state=case when p_approved then 'approved' else 'rejected' end,approval_by=case when p_approved then auth.uid() else null end,approved_at=case when p_approved then now() else null end,approved_sha256=case when p_approved then actual else null end,claims_reviewed=p_claims_reviewed where id=p_draft and org_id=p_org;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id) values(p_org,auth.uid(),case when p_approved then 'draft_approved' else 'draft_rejected' end,'outbound_drafts',p_draft);
 return aid;
end $$;
revoke all on function public.review_draft(uuid,uuid,boolean,boolean,text) from public;
grant execute on function public.review_draft(uuid,uuid,boolean,boolean,text) to authenticated;
