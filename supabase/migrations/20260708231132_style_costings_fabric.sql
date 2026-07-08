-- Lets the docket-generation automation look up a style's fabrication
-- automatically (style_costings already holds style_no/cmt/price per style)
-- instead of relying on the manual import UI's text input, which defaults
-- to Bengaline. Nullable -- falls back to Bengaline until backfilled.
--
-- Reverted in 20260708231953_style_costings_fabric_revert.sql: the PO PDF
-- itself always carries a per-product-code Fabrication table, which is a
-- more reliable source than a manually backfilled style_costings column.
alter table public.style_costings add column if not exists fabric text;
