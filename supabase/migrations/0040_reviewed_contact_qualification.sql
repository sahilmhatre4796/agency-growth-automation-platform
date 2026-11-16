-- DNS-only verification is UNKNOWN. A current owner-reviewed unknown/risky result
-- may support qualification, but consent, suppression and all send-time gates still apply.
create or replace function public.evaluate_lead_qualification(p_org uuid,p_lead uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare lead public.leads; target public.discovery_targeting; match public.lead_service_matches;
 service public.service_catalog; assessment public.lead_website_assessments; result_status text:='RESEARCH_NEEDED';
 reasons text[]:='{}'; score integer:=0; qid uuid; fit_industry boolean; fit_geo boolean; fit_type boolean; contact_ok boolean;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 select * into lead from public.leads where org_id=p_org and id=p_lead and not is_demo for update;
 if not found then raise exception 'LEAD_NOT_FOUND'; end if;
 select * into target from public.discovery_targeting where org_id=p_org;
 select m.* into match from public.lead_service_matches m join public.service_catalog s on s.id=m.service_id and s.org_id=m.org_id
  where m.org_id=p_org and m.lead_id=p_lead and s.status in ('active','custom_quote')
   and m.id=(select id from public.lead_service_matches where org_id=p_org and lead_id=p_lead and service_id=m.service_id order by assessed_at desc,id desc limit 1)
   and m.status='verified_gap' and m.assessed_at>now()-interval '90 days'
  order by m.confidence desc,m.assessed_at desc limit 1;
 if match.id is not null then select * into service from public.service_catalog where id=match.service_id and org_id=p_org; end if;
 fit_industry:=target.org_id is not null and cardinality(target.target_industries)>0 and
  lower(trim(coalesce(lead.business_category,'')))=any(select lower(trim(unnest(target.target_industries)))) and
  lower(trim(coalesce(lead.business_category,'')))<>all(select lower(trim(unnest(target.excluded_industries))));
 fit_geo:=target.org_id is not null and cardinality(target.target_cities)>0 and
  lower(trim(coalesce(lead.city,'')))=any(select lower(trim(unnest(target.target_cities)))) and
  (cardinality(target.target_states)=0 or lower(trim(coalesce(lead.state_region,'')))=any(select lower(trim(unnest(target.target_states))))) and
  (cardinality(target.target_countries)=0 or lower(trim(coalesce(lead.country,'')))=any(select lower(trim(unnest(target.target_countries))))) and
  lower(trim(coalesce(lead.business_name,'')))<>all(select lower(trim(unnest(target.excluded_businesses))));
 fit_type:=target.org_id is not null and (cardinality(target.target_business_types)=0 or
  lower(trim(coalesce(lead.business_type,'')))=any(select lower(trim(unnest(target.target_business_types)))));
 if target.org_id is null then reasons:=array_append(reasons,'Targeting has not been configured.');
 elsif cardinality(target.target_industries)=0 or cardinality(target.target_cities)=0 then reasons:=array_append(reasons,'Target industry and city must be selected.');
 elsif not fit_industry or not fit_geo or not fit_type then result_status:='NOT_QUALIFIED'; reasons:=array_append(reasons,'Business falls outside selected targeting or is excluded.'); end if;
 if match.id is null then reasons:=array_append(reasons,'No current, verified gap for an approved service.'); end if;
 if match.id is not null and service.service_key in ('service_01','service_02','service_03','service_04') then
  select * into assessment from public.lead_website_assessments where org_id=p_org and lead_id=p_lead order by observed_at desc,id desc limit 1;
  if assessment.id is null or assessment.observed_at<now()-interval '30 days' or assessment.status='UNKNOWN'
    or (service.service_key='service_01' and assessment.status<>'NO_OFFICIAL_WEBSITE_DISCOVERED')
    or (service.service_key='service_02' and assessment.status<>'VERIFIED_TECHNICAL_PROBLEM')
    or (service.service_key='service_03' and assessment.status not in ('PERSISTENTLY_BROKEN','VERIFIED_TECHNICAL_PROBLEM')) then
   match.id:=null; reasons:=array_append(reasons,'Website assessment does not support this service.');
  end if;
 end if;
 if match.id is not null and fit_industry and fit_geo and fit_type and result_status<>'NOT_QUALIFIED' then
  score:=least(100,40+15+15+round(match.confidence*20)::integer);
  select exists(select 1 from public.contacts c join public.email_verification_records v on v.org_id=c.org_id and v.contact_id=c.id
   where c.org_id=p_org and c.lead_id=p_lead and c.email_normalized=v.email_normalized and (v.status='valid' or (v.status in ('unknown','risky') and v.reviewed_at is not null)) and v.expires_at>now()
    and exists(select 1 from public.consent_records cr where cr.org_id=p_org and cr.contact_id=c.id and cr.channel='email'
      and cr.id=(select id from public.consent_records where org_id=p_org and contact_id=c.id and channel='email' order by recorded_at desc,id desc limit 1)
      and cr.state in ('permitted','opted_in') and cr.revoked_at is null)
    and v.id=(select id from public.email_verification_records where org_id=p_org and contact_id=c.id order by checked_at desc,id desc limit 1)) into contact_ok;
  if contact_ok then score:=least(100,score+10); result_status:='QUALIFIED';
   reasons:=array_append(reasons,'Reviewed evidence supports an approved service gap and target fit.');
  else result_status:='CONTACT_UNVERIFIED'; reasons:=array_append(reasons,'Contact requires current email verification.'); end if;
 end if;
 if exists(select 1 from public.contacts c join public.consent_records cr on cr.org_id=c.org_id and cr.contact_id=c.id
   where c.org_id=p_org and c.lead_id=p_lead and cr.channel='email' and cr.state in ('opted_out','unsubscribed','blocked','complained')
    and cr.id=(select id from public.consent_records where org_id=p_org and contact_id=c.id and channel='email' order by recorded_at desc,id desc limit 1)) then
  result_status:='SUPPRESSED'; reasons:=array_append(reasons,'Latest contact permission prohibits email outreach.');
 end if;
 insert into public.lead_qualifications(org_id,lead_id,primary_service_id,status,score,confidence,reasons,evidence_ids,suggested_angle,recommended_cta)
 values(p_org,p_lead,case when match.id is not null then service.id else null end,result_status,score,
  case when match.id is not null then match.confidence else 0 end,reasons,
  case when match.id is not null then match.evidence_ids else '{}' end,
  case when match.id is not null then match.reason else null end,
  case when match.id is not null then nullif(service.offer_cta,'') else null end) returning id into qid;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
 values(p_org,auth.uid(),'lead_qualification_evaluated','lead_qualifications',qid,jsonb_build_object('status',result_status,'lead_id',p_lead));
 return qid;
end $$;

