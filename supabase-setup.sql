-- Ebike Trasy: tabuľka na uložené trasy používateľov.
-- Spusti raz v Supabase: SQL Editor -> New query -> vlož celý text -> Run.

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  km numeric,
  up integer,
  hash text,
  gpx text,
  created_at timestamptz not null default now()
);

create index if not exists routes_user_idx on public.routes (user_id, created_at desc);

alter table public.routes enable row level security;

-- Každý vidí a mení len svoje trasy.
drop policy if exists "routes_select_own" on public.routes;
create policy "routes_select_own" on public.routes for select to authenticated using (auth.uid() = user_id);
drop policy if exists "routes_insert_own" on public.routes;
create policy "routes_insert_own" on public.routes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "routes_update_own" on public.routes;
create policy "routes_update_own" on public.routes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "routes_delete_own" on public.routes;
create policy "routes_delete_own" on public.routes for delete to authenticated using (auth.uid() = user_id);

grant select, insert, update, delete on public.routes to authenticated;
