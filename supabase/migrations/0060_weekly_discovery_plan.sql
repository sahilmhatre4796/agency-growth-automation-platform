-- Owner-editable planning settings only. No scheduler, provider or outbound is enabled.
alter table public.discovery_targeting
 add column weekly_countries text[] not null default array[
  'United States','New Zealand','United Arab Emirates','Australia',
  'United Kingdom','United States','Australia']::text[],
 add column weekly_timezone text not null default 'Asia/Kolkata',
 add column weekly_fallback_enabled boolean not null default false,
 add column daily_website_target smallint not null default 350,
 add column daily_automation_target smallint not null default 150,
 add column daily_india_manual_target smallint not null default 100;

alter table public.discovery_targeting
 add constraint weekly_countries_seven_approved check (
  cardinality(weekly_countries)=7 and weekly_countries <@ array[
   'United States','Australia','New Zealand','United Arab Emirates','United Kingdom']::text[]),
 add constraint weekly_timezone_nonempty check (length(trim(weekly_timezone)) between 3 and 64),
 add constraint daily_website_target_range check (daily_website_target between 0 and 500),
 add constraint daily_automation_target_range check (daily_automation_target between 0 and 500),
 add constraint daily_india_manual_target_range check (daily_india_manual_target between 0 and 500),
 add constraint daily_international_target_bound check (daily_website_target+daily_automation_target between 1 and 500);
