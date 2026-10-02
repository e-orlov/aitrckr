-- Luna Flex Retry-After tracking: persist retry-until timestamps across worker restarts
-- Prevents hammering Flex endpoint when temporarily unavailable

create table public.luna_retry_state (
  id uuid primary key default gen_random_uuid(),
  prompt_id text not null,
  retry_until_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint luna_retry_state_prompt_id_unique unique (prompt_id)
);

create index luna_retry_state_retry_until_at_idx on public.luna_retry_state(retry_until_at);
comment on table public.luna_retry_state is 'Persist Luna Flex Retry-After times across worker restarts. Single row per prompt.';
