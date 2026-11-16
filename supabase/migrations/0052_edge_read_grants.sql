-- Hosted Supabase does not automatically grant service_role table privileges
-- for the base schema. Edge code reads these two tables directly after its
-- own authorization/policy checks; all writes remain behind existing RPCs.
grant select on public.organizations, public.suppressions to service_role;
