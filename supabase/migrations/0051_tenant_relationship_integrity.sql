-- Bind service-written child records to the same organization as their parent.
-- The existing ID-only references still provide their original cascade behavior.
alter table public.business_research_jobs
 add constraint business_research_jobs_org_id_id_key unique (org_id,id);
alter table public.business_research_reports
 add constraint business_research_reports_org_id_id_key unique (org_id,id);
alter table public.gmail_messages
 add constraint gmail_messages_org_id_id_key unique (org_id,id);
alter table public.website_audit_jobs
 add constraint website_audit_jobs_org_id_id_key unique (org_id,id);

alter table public.research_credit_reservations
 add constraint research_credit_reservations_org_job_fk
 foreign key (org_id,job_id) references public.business_research_jobs(org_id,id);
alter table public.business_research_reports
 add constraint business_research_reports_org_job_fk
 foreign key (org_id,job_id) references public.business_research_jobs(org_id,id);
alter table public.personalized_email_drafts
 add constraint personalized_email_drafts_org_report_fk
 foreign key (org_id,report_id) references public.business_research_reports(org_id,id);
alter table public.gmail_message_reviews
 add constraint gmail_message_reviews_org_message_fk
 foreign key (org_id,message_id) references public.gmail_messages(org_id,id);
alter table public.website_audit_observations
 add constraint website_audit_observations_org_job_fk
 foreign key (org_id,job_id) references public.website_audit_jobs(org_id,id);

-- A private trigger function is not callable directly, but should not retain
-- the default PUBLIC function privilege either.
revoke execute on function private.preserve_candidate_website_proposal()
 from public,anon,authenticated;
