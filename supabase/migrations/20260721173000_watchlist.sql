-- StockKaki accounts: per-user watchlist (each user sees only their own rows via RLS)
create table if not exists public.watchlist (
  user_id uuid not null references auth.users(id) on delete cascade,
  slug text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, slug)
);
alter table public.watchlist enable row level security;

drop policy if exists "wl_select" on public.watchlist;
drop policy if exists "wl_insert" on public.watchlist;
drop policy if exists "wl_delete" on public.watchlist;

create policy "wl_select" on public.watchlist for select using (auth.uid() = user_id);
create policy "wl_insert" on public.watchlist for insert with check (auth.uid() = user_id);
create policy "wl_delete" on public.watchlist for delete using (auth.uid() = user_id);
