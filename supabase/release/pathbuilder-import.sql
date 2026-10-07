select 'pathbuilder-import-table' as id, to_regclass('public.pathbuilder_import') = 'public.pathbuilder_import'::regclass as passed
union all
select 'pathbuilder-import-rls', coalesce((select relrowsecurity from pg_class where oid = 'public.pathbuilder_import'::regclass), false)
union all
select 'pathbuilder-import-user-id', exists (
  select 1 from pg_attribute
  where attrelid = 'public.pathbuilder_import'::regclass
    and attname = 'user_id'
    and not attisdropped
)
union all
select 'pathbuilder-import-character-id', exists (
  select 1 from pg_attribute
  where attrelid = 'public.pathbuilder_import'::regclass
    and attname = 'character_id'
    and not attisdropped
);