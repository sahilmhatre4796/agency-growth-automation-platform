-- Groq may select evidence and approved wording for internal research copy.
-- The preview remains owner-only, non-sendable, and evidence-bound.
alter table public.research_draft_previews
  drop constraint research_draft_previews_generator_check,
  add constraint research_draft_previews_generator_check
    check (generator in ('grounded_template','groq_selected_template'));
