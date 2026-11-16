-- Search absence alone cannot establish that a business lacks a website.
create function public.record_business_website_statement(p_org uuid,p_lead uuid,p_source_url text,p_quote text,p_review_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 if not exists(select 1 from public.leads where org_id=p_org and id=p_lead and not is_demo and website_url is null) then
  raise exception 'LEAD_NOT_ELIGIBLE'; end if;
 if p_source_url is null or length(p_source_url)>500 or p_source_url !~ '^https?://[^ /]+'
   or length(trim(coalesce(p_quote,''))) not between 25 and 300
   or lower(coalesce(p_quote,'')) !~ $pattern$(no (official )?web ?site|not have (a )?web ?site|don't have (a )?web ?site|web ?site (nahi|nahin)|web ?site (coming soon|under construction))$pattern$
   or length(trim(coalesce(p_review_note,''))) not between 20 and 500 then
  raise exception 'BUSINESS_STATEMENT_REVIEW_REQUIRED'; end if;
 insert into public.lead_evidence(org_id,lead_id,source_url,source_type,observed_at,claim,confidence,reviewed_by,kind)
  values(p_org,p_lead,p_source_url,'business_website_statement',now(),trim(p_quote),0.8,auth.uid(),'observation') returning id into result;
 insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
  values(p_org,auth.uid(),'business_website_statement_reviewed','lead_evidence',result,
    jsonb_build_object('review_note',trim(p_review_note)));
 return result;
end $$;
revoke all on function public.record_business_website_statement(uuid,uuid,text,text,text) from public,anon;
grant execute on function public.record_business_website_statement(uuid,uuid,text,text,text) to authenticated;

-- Retain the established target/contact/service evaluation and add a stricter
-- new-website boundary before its result can be used by draft/send gates.
alter function public.evaluate_lead_qualification(uuid,uuid) rename to evaluate_lead_qualification_base;
alter function public.evaluate_lead_qualification_base(uuid,uuid) set schema private;
revoke all on function private.evaluate_lead_qualification_base(uuid,uuid) from public,anon,authenticated;
create function public.evaluate_lead_qualification(p_org uuid,p_lead uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; chosen public.lead_qualifications; assessment public.lead_website_assessments;
begin
 if not private.is_org_admin(p_org) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
 result:=private.evaluate_lead_qualification_base(p_org,p_lead);
 select * into chosen from public.lead_qualifications where org_id=p_org and id=result;
 if chosen.status in ('QUALIFIED','CONTACT_UNVERIFIED')
   and exists(select 1 from public.service_catalog where org_id=p_org and id=chosen.primary_service_id and service_key='service_01') then
  select * into assessment from public.lead_website_assessments
   where org_id=p_org and lead_id=p_lead order by observed_at desc,id desc limit 1;
  if assessment.id is null or assessment.status<>'NO_OFFICIAL_WEBSITE_DISCOVERED'
    or not exists(select 1 from public.lead_evidence e
      where e.org_id=p_org and e.lead_id=p_lead and e.id=any(assessment.evidence_ids)
        and e.source_type='business_website_statement' and e.reviewed_by is not null
        and e.rejected_by is null and e.confidence>=0.8 and e.observed_at>now()-interval '30 days') then
   update public.lead_qualifications set status='RESEARCH_NEEDED',primary_service_id=null,
    score=0,confidence=0,evidence_ids='{}',suggested_angle=null,recommended_cta=null,
    reasons=array_append(reasons,'Search absence is insufficient; cite a reviewed business statement confirming no website.')
    where org_id=p_org and id=result;
   insert into public.audit_events(org_id,actor_id,action,entity_table,entity_id,safe_context)
    values(p_org,auth.uid(),'qualification_downgraded_for_missing_site_evidence','lead_qualifications',result,
      jsonb_build_object('lead_id',p_lead,'status','RESEARCH_NEEDED'));
  end if;
 end if;
 return result;
end $$;
revoke all on function public.evaluate_lead_qualification(uuid,uuid) from public,anon;
grant execute on function public.evaluate_lead_qualification(uuid,uuid) to authenticated;

-- Existing latest qualifications must not retain an older search-only verdict.
with unsafe_latest as (
 select q.id from public.lead_qualifications q
 join public.service_catalog s on s.org_id=q.org_id and s.id=q.primary_service_id and s.service_key='service_01'
 where q.status in ('QUALIFIED','CONTACT_UNVERIFIED')
  and q.id=(select recent.id from public.lead_qualifications recent
    where recent.org_id=q.org_id and recent.lead_id=q.lead_id
    order by recent.evaluated_at desc,recent.id desc limit 1)
  and not exists(select 1 from public.lead_website_assessments a
    join public.lead_evidence e on e.org_id=a.org_id and e.lead_id=a.lead_id and e.id=any(a.evidence_ids)
    where a.org_id=q.org_id and a.lead_id=q.lead_id and a.status='NO_OFFICIAL_WEBSITE_DISCOVERED'
      and a.id=(select latest.id from public.lead_website_assessments latest
        where latest.org_id=q.org_id and latest.lead_id=q.lead_id order by latest.observed_at desc,latest.id desc limit 1)
      and e.source_type='business_website_statement' and e.reviewed_by is not null
      and e.rejected_by is null and e.confidence>=0.8 and e.observed_at>now()-interval '30 days')
), changed as (
 update public.lead_qualifications q set status='RESEARCH_NEEDED',primary_service_id=null,
  score=0,confidence=0,evidence_ids='{}',suggested_angle=null,recommended_cta=null,
  reasons=array_append(reasons,'Previous search-only website qualification requires positive business evidence.')
 from unsafe_latest u where q.id=u.id returning q.org_id,q.id,q.lead_id
)
insert into public.audit_events(org_id,action,entity_table,entity_id,safe_context)
select org_id,'qualification_downgraded_for_missing_site_evidence','lead_qualifications',id,
 jsonb_build_object('lead_id',lead_id,'status','RESEARCH_NEEDED','migration','0047') from changed;
