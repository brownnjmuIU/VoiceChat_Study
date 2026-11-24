-- =============================================================================
-- Voice vs Text privacy-policy chatbot study. Run once in a NEW Supabase project
-- (Supabase > SQL Editor > New query > paste > Run). Safe to re-run.
--
-- Write path: only this app's server writes, with the service key. RLS is ON
-- with NO policies on purpose: the public anon key can read and write nothing.
-- Supabase's "RLS enabled, no policies" notice is expected; do not add a policy.
--
-- Join to the Qualtrics export on response_id (= Qualtrics ResponseID).
-- =============================================================================

-- One row per page load. A reload inside the survey = same response_id, new session_id.
create table if not exists public.participants (
  id              bigint generated always as identity primary key,
  response_id     text not null,
  session_id      text not null,
  condition       text not null check (condition in ('text', 'voice')),
  in_qualtrics    boolean not null default false,
  show_transcript boolean not null default false,
  tts_backend     text,
  user_agent      text,
  app_version     text,
  created_at      timestamptz not null default now(),
  unique (response_id, session_id)
);

-- Full transcript. role 'error' = the model failed on that turn (message kept).
create table if not exists public.chat_turns (
  id            bigint generated always as identity primary key,
  response_id   text not null,
  session_id    text not null,
  condition     text not null check (condition in ('text', 'voice')),
  client_msg_id text not null,
  turn_index    integer not null,
  role          text not null check (role in ('user', 'assistant', 'error')),
  content       text not null,
  model         text,
  latency_ms    integer,
  chunk_count   integer,
  created_at    timestamptz not null default now(),
  -- Idempotency: a retried request can never store the same message twice.
  unique (response_id, session_id, client_msg_id, role)
);

-- UI events from the page: voice_used, audio_start/replay/stop/end, tab hidden, ...
create table if not exists public.client_events (
  id          bigint generated always as identity primary key,
  response_id text not null,
  session_id  text not null,
  condition   text not null check (condition in ('text', 'voice')),
  seq         integer not null,
  type        text not null,
  client_ts   timestamptz,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (response_id, session_id, seq)
);

create index if not exists chat_turns_response_idx on public.chat_turns (response_id, created_at);
create index if not exists client_events_response_idx on public.client_events (response_id, created_at);

alter table public.participants  enable row level security;
alter table public.chat_turns    enable row level security;
alter table public.client_events enable row level security;

-- Supabase no longer auto-grants new public tables to the API roles (changelog
-- #45329, default for new projects since 2026-05-30). Grant ONLY the server's
-- role, and only what the app does: insert rows and the ping's select.
-- anon / authenticated get nothing.
grant select, insert on public.participants, public.chat_turns, public.client_events to service_role;

-- -----------------------------------------------------------------------------
-- Export views for analysis (Table Editor > view > Export to CSV).
-- security_invoker = the view obeys the same RLS as its tables, so the anon key
-- still sees nothing through it.
-- -----------------------------------------------------------------------------

-- Readable transcript, in order.
create or replace view public.transcript_export with (security_invoker = true) as
select response_id, condition, session_id, turn_index, role, content, latency_ms, created_at
from public.chat_turns
order by response_id, created_at, turn_index, role desc;

-- One row per participant: how much they used the chatbot and how.
create or replace view public.participant_summary with (security_invoker = true) as
with t as (
  select response_id,
         count(*) filter (where role = 'user')      as user_messages,
         count(*) filter (where role = 'assistant') as assistant_messages,
         count(*) filter (where role = 'error')     as errors,
         sum(length(content)) filter (where role = 'user') as user_chars,
         min(created_at) as first_message_at,
         max(created_at) as last_message_at
  from public.chat_turns group by response_id
), e as (
  select response_id,
         count(*) filter (where type = 'audio_replay') as replays,
         count(*) filter (where type = 'audio_stop')   as stops,
         count(*) filter (where type = 'visibility_hidden') as tab_hidden,
         max(detail->>'name') filter (where type = 'voice_used') as voice_name
  from public.client_events group by response_id
), p as (
  select response_id,
         min(condition) as condition,
         count(*) as page_loads,
         bool_or(in_qualtrics) as in_qualtrics,
         min(created_at) as first_load_at,
         min(user_agent) as user_agent
  from public.participants group by response_id
)
select p.response_id, p.condition, p.page_loads, p.in_qualtrics, p.first_load_at,
       coalesce(t.user_messages, 0) as user_messages,
       coalesce(t.assistant_messages, 0) as assistant_messages,
       coalesce(t.errors, 0) as errors,
       coalesce(t.user_chars, 0) as user_chars,
       t.first_message_at, t.last_message_at,
       extract(epoch from (t.last_message_at - t.first_message_at))::int as chat_seconds,
       coalesce(e.replays, 0) as replays,
       coalesce(e.stops, 0) as stops,
       coalesce(e.tab_hidden, 0) as tab_hidden,
       e.voice_name, p.user_agent
from p
left join t using (response_id)
left join e using (response_id);

grant select on public.transcript_export, public.participant_summary to service_role;
