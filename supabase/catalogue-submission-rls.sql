-- Catalogue submissions: a member reads and writes only their own workspace's
-- submissions. Reviewers (users.platformRole = 'reviewer') read every row —
-- the queue is cross-org by design, and this is the one place that is true.
--
-- Mirrors the posture of flow-jam-rls.sql: Postgres enforces the org boundary
-- independently of the Prisma tenant guard, so a missed `where` in application
-- code cannot leak another workspace's submissions.

alter table public.catalogue_submissions enable row level security;

create policy catalogue_submissions_own_org
  on public.catalogue_submissions
  for all
  using (
    "organizationId" in (
      select "organizationId" from public.users
      where "supabaseId" = auth.uid() and "isActive" = true
    )
  )
  with check (
    "organizationId" in (
      select "organizationId" from public.users
      where "supabaseId" = auth.uid() and "isActive" = true
    )
  );

create policy catalogue_submissions_reviewer_read
  on public.catalogue_submissions
  for select
  using (
    exists (
      select 1 from public.users
      where "supabaseId" = auth.uid() and "isActive" = true and "platformRole" = 'reviewer'
    )
  );
