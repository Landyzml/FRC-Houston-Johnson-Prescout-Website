create table if not exists public.app_settings (
  key text primary key,
  value text not null
);

alter table public.app_settings enable row level security;

drop policy if exists "public read app settings" on public.app_settings;
create policy "public read app settings"
on public.app_settings
for select
to anon
using (true);

drop policy if exists "public write app settings" on public.app_settings;
create policy "public write app settings"
on public.app_settings
for insert
to anon
with check (true);

drop policy if exists "public update app settings" on public.app_settings;
create policy "public update app settings"
on public.app_settings
for update
to anon
using (true)
with check (true);

create table if not exists public.prescout_datasets (
  name text primary key,
  cols jsonb not null default '[]'::jsonb,
  rows jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.prescout_datasets enable row level security;

drop policy if exists "public read prescout datasets" on public.prescout_datasets;
create policy "public read prescout datasets"
on public.prescout_datasets
for select
to anon
using (true);

drop policy if exists "public write prescout datasets" on public.prescout_datasets;
create policy "public write prescout datasets"
on public.prescout_datasets
for insert
to anon
with check (true);

drop policy if exists "public update prescout datasets" on public.prescout_datasets;
create policy "public update prescout datasets"
on public.prescout_datasets
for update
to anon
using (true)
with check (true);
