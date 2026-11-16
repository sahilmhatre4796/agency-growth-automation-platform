-- Proposed service guidance, never proof of ChainCraft capability or a prospect gap.
-- Existing owner edits, activation decisions, proof and pricing are preserved.
create table private.service_blueprints(
 service_key text primary key,
 description text not null,
 observable_signal text not null,
 disqualifier text not null,
 potential_benefit text not null
);
insert into private.service_blueprints values
('service_01','A clear, accessible business website with appropriate enquiry paths.','Two independent public searches and owner review found no official website.','A suitable official website is already available.','clearer business information and enquiry paths'),
('service_02','A focused redesign of an existing business website.','A specific usability, accessibility or conversion problem is documented on the current site.','The existing site adequately serves the proposed purpose.','a clearer experience for relevant visitors'),
('service_03','Repair of a confirmed technical website problem.','Repeatable failure or a specific technical fault was checked with dates and redirects.','The issue is temporary, caused by anti-bot controls, or cannot be reproduced.','more reliable access to existing services'),
('service_04','An online storefront for a verified product-selling workflow.','Public product and ordering information shows a specific unmet online purchase need.','An adequate online ordering or commerce flow already exists.','easier product browsing and ordering'),
('service_05','A custom Android application for a validated mobile workflow.','A recurring Android-first customer or staff workflow is documented.','The workflow works adequately through an existing mobile site or app.','simpler repeat use on Android devices'),
('service_06','A custom iOS application for a validated mobile workflow.','A recurring iOS-first customer or staff workflow is documented.','The workflow works adequately through an existing mobile site or app.','simpler repeat use on iOS devices'),
('service_07','A custom web application for a specific business process.','A documented multi-step online process lacks a suitable existing tool.','A current web application already handles the process adequately.','a more consistent digital workflow'),
('service_08','A SaaS product for a validated repeatable market need.','The business publicly describes a repeatable product workflow and an unmet distribution need.','There is no validated recurring product need or an adequate product already exists.','a maintainable recurring product experience'),
('service_09','An AI receptionist for a reviewed inbound enquiry workflow.','Published contact hours or owner evidence show a specific missed-enquiry handling gap.','Current reception coverage meets the stated need or the channel lacks consent.','more consistent handling of permitted enquiries'),
('service_10','An AI-assisted support system with human escalation.','A documented support process has a specific repetitive response or routing gap.','Existing support handles enquiries adequately or safe escalation is unavailable.','faster routing of common support requests'),
('service_11','A website chatbot scoped to reviewed customer questions.','Specific recurring public questions lack an adequate answer path on the site.','An existing assistant or FAQ already answers those questions well.','easier access to routine answers'),
('service_12','A consent-aware WhatsApp bot or official integration.','The business uses an official WhatsApp channel and a reviewed manual workflow needs help.','No approved channel, consent basis or unmet workflow is established.','more consistent handling of permitted WhatsApp requests'),
('service_13','Automation of a confirmed repetitive business process.','A documented handoff or repeated manual task has measurable friction.','The process is already automated adequately or is too variable to automate safely.','less repetitive work for the team'),
('service_14','A bounded AI agent or AI integration with human controls.','A reviewed workflow has suitable inputs, oversight and a specific AI-assisted step.','Unreliable data, absent oversight or an adequate current solution makes the proposal unsuitable.','support for a well-defined internal task'),
('service_15','Online appointment and booking flow for a verified scheduling gap.','Public booking instructions or owner evidence show a manual appointment bottleneck.','A usable booking flow already covers the relevant appointments.','easier appointment requests'),
('service_16','B2B dealer or wholesale ordering system.','Public wholesale/dealer information shows a specific manual ordering need.','An adequate dealer portal or ordering workflow already exists.','clearer repeat ordering for approved buyers'),
('service_17','A CRM tailored to a verified relationship-tracking need.','A documented sales process lacks a suitable shared record or follow-up view.','An existing CRM adequately supports the team.','clearer customer and opportunity records'),
('service_18','Permission-based sales and lead follow-up automation.','A reviewed opt-in workflow has a specific missed follow-up problem.','Consent is absent or the existing follow-up process works adequately.','more consistent permitted follow-up'),
('service_19','A custom admin panel for a validated operational task.','A documented staff workflow needs a controlled interface not served by current tools.','An existing admin interface already supports the workflow.','simpler internal task handling'),
('service_20','An operational dashboard using verified business data.','The team has reliable metrics but a documented visibility or reporting gap.','Existing reporting answers the same decisions adequately or source data is unreliable.','clearer operational decisions'),
('service_21','UI and UX design for a specific product usability problem.','A repeatable usability issue is supported by observation or user feedback.','No specific usability issue is evidenced or the existing experience is adequate.','a more understandable product flow'),
('service_22','Google Business Profile and local visibility assistance.','A reviewed public listing has a specific accuracy or completeness issue.','The listing is accurate and adequate or the business cannot authorize changes.','clearer local business information'),
('service_23','Custom business software for a validated unique workflow.','A documented process cannot be served adequately by available tools.','The need is generic, unverified or already met by suitable software.','a better fit for the documented process'),
('service_24','A custom integration between approved business systems.','A documented data handoff is manual, error-prone and permitted by both systems.','Existing integration is adequate or either system lacks authorized access.','a more reliable approved data handoff');

create or replace function public.ensure_service_catalog(p_org uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare added integer;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 insert into public.service_catalog(org_id,service_key,name)
 select p_org,'service_'||lpad(ordinality::text,2,'0'),name from unnest(array[
  'Premium business websites','Website redesign and modernization','Website repair and technical improvements','E-commerce websites',
  'Android applications','iOS applications','Custom web applications','SaaS applications','AI receptionists',
  'AI customer support systems','AI chatbots','WhatsApp bots and integrations','Business process automation',
  'AI agents and custom AI integrations','Appointment and booking systems','B2B wholesale/dealer ordering platforms',
  'CRM systems','Sales and lead follow-up automation','Custom admin panels','Operational dashboards',
  'UI/UX design','Google Business Profile and local-visibility services','Custom business software',
  'Custom integrations and digital solutions']) with ordinality as offerings(name,ordinality)
 on conflict(org_id,service_key) do nothing;
 get diagnostics added=row_count;
 update public.service_catalog s set
  description=case when trim(s.description)='' then b.description else s.description end,
  ideal_customer_profile=case when trim(s.ideal_customer_profile)='' then 'A business with a reviewed, evidenced need for this specific service.' else s.ideal_customer_profile end,
  problems_solved=case when cardinality(s.problems_solved)=0 then array[b.description] else s.problems_solved end,
  observable_signals=case when cardinality(s.observable_signals)=0 then array[b.observable_signal] else s.observable_signals end,
  disqualification_criteria=case when cardinality(s.disqualification_criteria)=0 then array[b.disqualifier] else s.disqualification_criteria end,
  evidence_requirements=case when cardinality(s.evidence_requirements)=0 then array['Current, dated and owner-reviewed source evidence of the specific gap; a missing search result is insufficient.'] else s.evidence_requirements end,
  potential_benefits=case when cardinality(s.potential_benefits)=0 then array[b.potential_benefit] else s.potential_benefits end,
  offer_cta=case when trim(s.offer_cta)='' then 'Would a brief, specific idea be useful?' else s.offer_cta end
 from private.service_blueprints b where s.org_id=p_org and s.service_key=b.service_key
  and (trim(s.description)='' or trim(s.ideal_customer_profile)='' or cardinality(s.problems_solved)=0
   or cardinality(s.observable_signals)=0 or cardinality(s.disqualification_criteria)=0
   or cardinality(s.evidence_requirements)=0 or cardinality(s.potential_benefits)=0 or trim(s.offer_cta)='');
 return added;
end $$;
