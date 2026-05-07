-- 001_init.sql
-- Initial schema for ds-survey-bridge.
-- Run this in the Supabase SQL editor (or via the CLI) against a fresh project.

create extension if not exists "pgcrypto";

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  droptop_location_id text unique not null,
  name text not null,
  google_review_url text not null,
  created_at timestamptz not null default now()
);

create table if not exists surveys (
  id uuid primary key default gen_random_uuid(),
  order_id text unique not null,
  location_id text not null,
  customer_phone text,
  customer_name text,
  services jsonb,
  rating int check (rating between 1 and 5),
  comment text,
  sent_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists surveys_location_id_idx on surveys (location_id);
