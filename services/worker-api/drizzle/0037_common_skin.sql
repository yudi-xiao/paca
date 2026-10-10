BEGIN;

-- Versioned immutable projection for PostgreSQL only. Generated columns keep
-- every Task/Document mutation (including Yjs materialization) searchable in
-- the same transaction. Traverse visible BlockNote text, never props/URLs.
-- pg_trgm provides indexed literal ILIKE; very short queries still rely on the
-- project/ID filters and the runtime statement timeout.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE FUNCTION paca_blocknote_search_text(content jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $function$
with recursive search_nodes(value, path) as (
    select coalesce(content, '[]'::jsonb), array[]::integer[]
    union all
    select child.value, parent.path || child.ordinal
    from search_nodes parent cross join lateral (
      select element.value, element.ordinality::integer as ordinal
      from jsonb_array_elements(case when jsonb_typeof(parent.value)='array' then parent.value else '[]'::jsonb end) with ordinality element
      union all
      select property.value, case property.key when 'content' then 0 when 'children' then 1 when 'rows' then 2 else 3 end
      from jsonb_each(case when jsonb_typeof(parent.value)='object' then parent.value else '{}'::jsonb end) property
      where property.key in ('content','children','rows','cells')
    ) child
  ) select coalesce(string_agg(case
    when value->>'type'='text' and jsonb_typeof(value->'text')='string' then value->>'text'
    when jsonb_typeof(value)='object' and value->>'type' is distinct from 'link' and jsonb_typeof(value->'content')='array' then E'\n'
    when jsonb_typeof(value)='array' and cardinality(path)>1 and jsonb_typeof(value->0)='object' and value->0->>'type'='text' and path[cardinality(path)]>0 then E'\n'
    else '' end, '' order by path),'') from search_nodes;
$function$;

ALTER TABLE "paca_document" ADD COLUMN "search_body" text NOT NULL GENERATED ALWAYS AS (paca_blocknote_search_text("content")) STORED;--> statement-breakpoint
ALTER TABLE "paca_task" ADD COLUMN "search_body" text NOT NULL GENERATED ALWAYS AS (paca_blocknote_search_text("description")) STORED;--> statement-breakpoint
CREATE INDEX "paca_document_search_body_idx" ON "paca_document" USING gin ("search_body" gin_trgm_ops) WHERE "paca_document"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "paca_document_search_title_idx" ON "paca_document" USING gin ("title" gin_trgm_ops) WHERE "paca_document"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "paca_task_search_body_idx" ON "paca_task" USING gin ("search_body" gin_trgm_ops) WHERE "paca_task"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "paca_task_search_title_idx" ON "paca_task" USING gin ("title" gin_trgm_ops) WHERE "paca_task"."deleted_at" is null;

INSERT INTO paca_schema_migration (id, checksum) VALUES ('0037_common_skin', 'dff42b04a8fa54074c0a422a19ae725a90ebb32b40c5ac120de43d3f527f53c2');

COMMIT;
