-- Supabase may grant anon/authenticated explicit default privileges in addition
-- to PUBLIC. Revoking PUBLIC alone does NOT remove those role-specific grants.
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.import_leads(uuid,jsonb),public.score_lead(uuid,uuid),public.edit_lead(uuid,uuid,jsonb),public.edit_draft(uuid,uuid,text,text),public.review_draft(uuid,uuid,boolean,boolean,text),public.acknowledge_notification(uuid,uuid),public.pause_outbound(uuid),public.workspace_metrics(uuid),public.record_export(uuid,integer) to authenticated;

revoke all on all tables in schema public from anon,authenticated;
grant select on public.organizations,public.memberships,public.leads,public.contacts,public.lead_evidence,public.lead_scores,public.consent_records,public.suppressions,public.campaigns,public.outbound_drafts,public.message_events,public.jobs,public.tasks,public.appointments,public.audit_events,public.lead_notes,public.lead_score_overrides,public.ai_budgets,public.ai_usage,public.draft_approvals,public.notifications,public.external_connections,public.provider_webhook_events,public.communication_messages,public.sequence_enrollments to authenticated;
grant insert,update,delete on public.leads,public.contacts,public.lead_evidence to authenticated;
grant insert on public.lead_notes,public.lead_score_overrides,public.outbound_drafts to authenticated;
grant insert,update on public.tasks to authenticated;

revoke execute on all functions in schema private from public,anon,authenticated;
grant execute on function private.is_org_member(uuid),private.is_org_admin(uuid) to authenticated;
-- Future migrations must explicitly grant their intended callers after creation.
alter default privileges in schema public revoke execute on functions from public,anon,authenticated;
alter default privileges in schema public revoke all on tables from anon,authenticated;
