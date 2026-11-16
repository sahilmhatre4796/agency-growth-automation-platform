alter table public.leads add foreign key(org_id,owner_user_id) references public.memberships(org_id,user_id);
alter table public.tasks add foreign key(org_id,assigned_to) references public.memberships(org_id,user_id);
alter table public.lead_evidence add foreign key(org_id,reviewed_by) references public.memberships(org_id,user_id);
alter table public.campaigns add foreign key(org_id,created_by) references public.memberships(org_id,user_id);
alter table public.outbound_drafts add foreign key(org_id,approval_by) references public.memberships(org_id,user_id);
alter table public.lead_notes add foreign key(org_id,created_by) references public.memberships(org_id,user_id);
alter table public.lead_score_overrides add foreign key(org_id,actor_id) references public.memberships(org_id,user_id);
alter table public.draft_approvals add foreign key(org_id,actor_id) references public.memberships(org_id,user_id);
