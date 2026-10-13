-- Ebike Trasy: doplnenie databázy pre novú verziu appky
-- (poznámky a hodnotenie pri trasách, bicykle uložené v účte).
-- Spusti raz v Supabase: SQL Editor -> New query -> vlož celý text -> Run.
-- Dá sa spustiť aj viackrát, nič sa nezmaže.

-- Poznámka, hodnotenie (1 až 5 hviezdičiek) a stav trasy (chcem ísť / jazdené).
alter table public.routes add column if not exists note text;
alter table public.routes add column if not exists rating smallint;
alter table public.routes add column if not exists status text;

-- Bicykle a nastavenia každého používateľa.
create table if not exists public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  bikes jsonb not null default '[]'::jsonb,
  prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

-- Každý vidí a mení len svoje nastavenia.
drop policy if exists "settings_select_own" on public.user_settings;
create policy "settings_select_own" on public.user_settings for select to authenticated using (auth.uid() = user_id);
drop policy if exists "settings_insert_own" on public.user_settings;
create policy "settings_insert_own" on public.user_settings for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "settings_update_own" on public.user_settings;
create policy "settings_update_own" on public.user_settings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update on public.user_settings to authenticated;
