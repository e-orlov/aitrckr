-- Luna Flex billing incident tracking: locks Luna queries after service_tier contract violation
-- Reset only via explicit operator action after incident investigation

create table public.luna_flex_incidents (
  id uuid primary key default gen_random_uuid(),
  generation_id text unique,
  requested_tier text not null default 'flex',
  response_tier text,
  error_code numeric,
  error_type text,
  error_provider_code text,
  usage_snapshot jsonb,
  created_at timestamp with time zone not null default now(),
  status text not null default 'active' check (status in ('active', 'resolved')),
  operator_notes text
);

create index luna_flex_incidents_status_idx on public.luna_flex_incidents(status);
comment on table public.luna_flex_incidents is 'Incident log for Luna service_tier contract violations. Active incidents halt all automatic Luna queries. Reset only by operator.';
