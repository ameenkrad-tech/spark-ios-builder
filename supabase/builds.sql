-- Spark native iOS CLOUD builds. Each row is one build job, coordinated between the backend
-- (inserts a 'queued' job + triggers a GitHub Actions macOS runner) and the runner
-- (generate → compile → run in the simulator → screenshot → fix → retry, then writes the
-- result back to this row). The iOS/web client polls /api/build-status for the outcome.
-- RLS ON, no policies → only the server's service-role key touches it (matches app_config/agents).

create table if not exists public.builds (
  id          uuid primary key default gen_random_uuid(),
  device_id   text,                              -- who asked (iOS app has no login yet); nullable
  prompt      text not null,                     -- the app request
  label       text,                              -- human name for the app
  icon        text,                              -- brand logo as a data URL (reserved; not yet baked in the cloud)
  status      text not null default 'queued',    -- queued | running | done | failed
  phase       text,                              -- on failure: generate|typecheck|compile|run|timeout|dispatch|error
  errors      text,                              -- compiler / infra error text
  screenshot  text,                              -- on success: data:image/png;base64,… of the running app
  swift       text,                              -- the final generated Swift source
  rounds      int not null default 0,            -- how many fix rounds it took
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists builds_device_idx on public.builds (device_id, created_at desc);
create index if not exists builds_status_idx on public.builds (status);

alter table public.builds enable row level security;
-- No public policies → anon/authenticated clients get nothing; only service_role bypasses RLS.
