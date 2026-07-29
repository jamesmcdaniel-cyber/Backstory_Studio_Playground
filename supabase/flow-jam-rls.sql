-- Flow jam channel authorization.
--
-- Until now `flow:<id>` was a PUBLIC Supabase Realtime channel: anyone holding
-- the anon key and a flow id could join it, read the entire graph stream, and
-- inject ops — nothing server-side checked that they could access the flow.
-- The jam now rides two PRIVATE topics and Postgres decides who may join and
-- who may write, using exactly the precedence resolveFlowRole() applies over
-- HTTP (src/lib/flows/access.ts):
--
--   flow:<id>      → any role may read and write (presence, cursors, huddle)
--   flow:<id>:ops  → any role may read; only 'edit' may write
--
-- The split is what makes view-only real: a viewer keeps presence, a cursor and
-- a voice, and still receives every edit, but cannot emit one.

create or replace function public.flow_topic_access(topic text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_flow_id text;
  v_suffix  text;
  v_user_id text;
  v_org_id  uuid;
  v_owner   text;
  v_flow_org uuid;
  v_visibility text;
  v_role    text;
begin
  -- Parse `flow:<id>` / `flow:<id>:ops`; anything else is not ours to answer.
  if topic is null or topic !~ '^flow:[^:]+(:ops)?$' then
    return null;
  end if;
  v_flow_id := split_part(topic, ':', 2);
  v_suffix  := split_part(topic, ':', 3);
  if v_flow_id = '' then
    return null;
  end if;
  if v_suffix <> '' and v_suffix <> 'ops' then
    return null;
  end if;

  select id, "organizationId" into v_user_id, v_org_id
  from public.users
  where "supabaseId" = auth.uid() and "isActive" = true;
  if v_user_id is null then
    return null;
  end if;

  select "userId", "organizationId", visibility
    into v_owner, v_flow_org, v_visibility
  from public.flows
  where id = v_flow_id;
  if not found then
    return null;
  end if;

  -- 1. Owner → edit, always.
  if v_owner is not null and v_owner = v_user_id then
    return 'edit';
  end if;

  -- 2. Same workspace → v1 visibility semantics verbatim. Legacy ownerless
  --    'view' rows stay editable by the org rather than by no one.
  if v_flow_org = v_org_id then
    if v_visibility = 'private' then
      return null;
    elsif v_visibility = 'view' then
      return case when v_owner is null then 'edit' else 'view' end;
    else
      return 'edit';
    end if;
  end if;

  -- 3. Cross-workspace → an accepted collaborator row's role.
  select role into v_role
  from public.flow_collaborators
  where "flowId" = v_flow_id and "userId" = v_user_id;
  if v_role in ('edit', 'view') then
    return v_role;
  end if;

  -- 4. Otherwise the flow does not exist for this viewer. Share TOKENS are
  --    deliberately not honored here: a token is redeemed over HTTP, which
  --    writes the collaborator row that case 3 then sees.
  return null;
end;
$$;

revoke all on function public.flow_topic_access(text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.flow_topic_access(text) to authenticated;
  end if;
end
$$;

-- The policies themselves only exist where Realtime does. A plain Postgres
-- (CI, local repro) has no realtime schema and simply skips them; the function
-- above still deploys, so the parity test can check it everywhere. Privilege
-- failures are NOT swallowed — if the migration role can't create these on
-- Supabase, the deploy fails loudly rather than shipping an unauthorized jam.
do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'realtime.messages absent — skipping jam channel policies (expected outside Supabase)';
    return;
  end if;

  drop policy if exists "flow_jam_read" on realtime.messages;
  create policy "flow_jam_read"
    on realtime.messages
    for select
    to authenticated
    using (public.flow_topic_access(realtime.topic()) is not null);

  drop policy if exists "flow_jam_write" on realtime.messages;
  create policy "flow_jam_write"
    on realtime.messages
    for insert
    to authenticated
    with check (
      case
        when realtime.topic() like '%:ops' then public.flow_topic_access(realtime.topic()) = 'edit'
        else public.flow_topic_access(realtime.topic()) is not null
      end
    );
end
$$;
