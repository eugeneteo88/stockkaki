-- StockKaki — alert subscribers (Phase 1: email ex-date alerts)
-- Run this once in the Supabase SQL editor for your StockKaki project.

create extension if not exists pgcrypto;

create table if not exists public.subscribers (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  tickers       text[] not null default '{}',        -- followed tickers ([] = weekly digest of all)
  confirmed     boolean not null default false,
  confirm_token uuid not null default gen_random_uuid(),
  unsub_token   uuid not null default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  confirmed_at  timestamptz,
  last_sent_at  timestamptz
);

-- Lock the table down: no direct access for the public/anon role.
-- Writes happen via the `subscribe` edge function (service role) and the two
-- SECURITY DEFINER functions below.
alter table public.subscribers enable row level security;

-- Confirm a subscriber (called from the /confirm/ page using the anon key).
create or replace function public.confirm_subscriber(p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  update public.subscribers set confirmed = true, confirmed_at = now()
  where confirm_token = p_token and confirmed = false
  returning email into v_email;
  return v_email is not null;
end $$;

-- Unsubscribe (called from the /unsubscribe/ page or the email footer link).
create or replace function public.unsubscribe(p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  delete from public.subscribers where unsub_token = p_token returning email into v_email;
  return v_email is not null;
end $$;

grant execute on function public.confirm_subscriber(uuid) to anon;
grant execute on function public.unsubscribe(uuid) to anon;
