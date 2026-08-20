-- TestFlight status columns on the builds table. Run once in the Supabase SQL editor (idempotent).
-- Tracks a build's App Store Connect upload so the app can show "processing → ready on your phone".
alter table public.builds add column if not exists tf_status    text;   -- preparing|registering app|archiving|uploading|processing|error
alter table public.builds add column if not exists tf_error     text;   -- human-readable failure reason (null on success)
alter table public.builds add column if not exists tf_bundle_id text;   -- com.MuhamadKrad.spark.<slug>
alter table public.builds add column if not exists tf_build     text;   -- CFBundleVersion used for this upload (timestamp)
