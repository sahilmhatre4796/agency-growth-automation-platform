-- The staging preview worker uses a server-side service-role key and
-- tenant-scoped queries. Base CRM tables require explicit read grants.
grant select on public.leads, public.lead_evidence to service_role;
