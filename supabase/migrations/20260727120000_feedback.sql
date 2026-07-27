-- StockKaki reader feedback: public site can INSERT only; nobody can read others' rows.
-- Read via the Supabase dashboard or the daily growth email (service-role key bypasses RLS).
create table if not exists public.feedback (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  message    text not null,
  email      text,
  page       text
);
alter table public.feedback enable row level security;

drop policy if exists "fb_insert" on public.feedback;

-- anon = the public site's key; char_length guard is a server-side backstop against junk/spam.
create policy "fb_insert" on public.feedback for insert
  to anon, authenticated
  with check ( char_length(message) between 1 and 4000 );
