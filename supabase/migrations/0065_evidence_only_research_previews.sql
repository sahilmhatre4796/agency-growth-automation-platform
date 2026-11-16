-- Internal previews may use independently sourced CRM facts without a paid
-- research report or a sendable contact. This table has no send transition.
alter table public.research_draft_previews alter column report_id drop not null;
alter table public.research_draft_previews
 add column basis text not null default 'verified_gap'
   check (basis in ('verified_gap','potential_use_case')),
 add column fact_claim text,
 add constraint research_preview_evidence_only_shape check (
   (report_id is not null and basis='verified_gap') or
   (report_id is null and basis='potential_use_case' and
     length(fact_claim) between 25 and 180 and cardinality(evidence_ids)>=2)
 ),
 add constraint research_preview_lead_fk foreign key(org_id,lead_id)
   references public.leads(org_id,id) on delete cascade;
create unique index research_preview_evidence_only_once
 on public.research_draft_previews(org_id,lead_id,service_id,(evidence_ids[1]))
 where report_id is null;
