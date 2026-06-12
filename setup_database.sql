-- Run this SQL in Supabase's SQL editor to create the reports table
-- Go to: your Supabase project → SQL Editor → paste this → click Run

create table if not exists reports (
  id            bigserial primary key,
  location_code text not null,
  location_name text not null,
  city          text,
  facility_type text,
  country       text,
  report_date   text,
  week_label    text,
  report_json   jsonb not null,
  sources_cited text[],
  data_gaps     text[],
  created_at    timestamptz default now()
);

-- Index for fast lookups by location and date
create index if not exists idx_reports_location on reports(location_code);
create index if not exists idx_reports_created  on reports(created_at desc);
create index if not exists idx_reports_country  on reports(country);

-- Allow the website (anonymous users) to READ reports
-- The website never writes — only the GitHub Action writes (using the service key)
alter table reports enable row level security;

create policy "Public read access"
  on reports for select
  to anon
  using (true);

-- Confirm setup
select 'Database setup complete. Table created with ' || count(*) || ' rows.' as status
from reports;
