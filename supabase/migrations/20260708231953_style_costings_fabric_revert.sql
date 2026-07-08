-- Reverting 20260708231132_style_costings_fabric.sql: fabrication is read
-- straight out of the PO PDF's "Product Code / Fabrication" table by
-- generate-docket.mjs instead (always present there, unlike style_costings
-- which would need manual backfilling per style).
alter table public.style_costings drop column if exists fabric;
