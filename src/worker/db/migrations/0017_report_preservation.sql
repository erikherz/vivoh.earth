-- Report categories that name what the payment rules actually prohibit, and a preservation
-- clock for the one category that carries a statutory duty.
--
-- Read migrations 0012 and 0016 first. 0012 built the report table as a SENSOR for an
-- operator who cannot decrypt anything; 0016 added the single still frame that made a report
-- checkable rather than merely asserted. This migration adds the two columns that let the
-- gravest category behave differently from the rest, and it changes nothing about the others.
--
-- ── Why the CSAM category needs its own clock ────────────────────────────────────────────
--
-- 18 U.S.C. 2258A obliges a provider to report apparent child sexual abuse material to NCMEC
-- as soon as reasonably possible after obtaining ACTUAL KNOWLEDGE of it, and then to preserve
-- the contents of that report. The REPORT Act (signed 7 May 2024) amended 2258A(h) by
-- striking "90 days" and inserting "1 year".
--
-- We are end-to-end encrypted, so we never obtain actual knowledge by looking. 2258A(f) says
-- plainly that no provider is required to monitor, scan or search, so that is not a gap — it
-- is the arrangement the statute contemplates. The report queue IS our knowledge channel.
-- Which means the moment a frame arrives under this category, the preservation duty attaches
-- to it, and REPORT_FRAME_RETENTION_DAYS would have destroyed the evidence at day 30 with no
-- human involved. That is the hole this migration closes.
--
-- The duty attaches to reports actually submitted to NCMEC, not to every complaint in the
-- queue, so `preserve_until` is set at INTAKE as a conservative floor and re-based from the
-- filing date when an operator records the submission. Everything else still expires on the
-- ordinary 30-day clock, which is the right default: holding a stranger's living room for a
-- year because somebody misfiled a report is its own harm.
--
-- ── Why the new categories are shaped the way they are ───────────────────────────────────
--
-- Stripe's Prohibited Businesses list forbids adult content in five bullets, and a platform
-- that hosts third-party content is expected to monitor for compliance. The bullets are
-- written as BUSINESS TYPES ("adult video stores", "gentleman's clubs") because they were
-- written for merchant underwriting. A viewer holding a share link cannot report a business
-- type; they can only report what they are looking at. So the categories added here are the
-- observable form of each bullet, and the mapping is recorded in the Worker beside the
-- constant rather than pasted into anything a user reads — Stripe revises that list without
-- notice, and a copy in our UI would go quietly stale.

-- Set on intake for the CSAM category, and re-based when a submission to NCMEC is recorded.
-- The frame reaper and both operator-facing removal levers refuse to act while this is in the
-- future. NULL means the ordinary retention clock applies, which is the case for every other
-- category and for every row that existed before this migration.
ALTER TABLE reports ADD COLUMN preserve_until TEXT;

-- When an operator recorded a CyberTipline submission for this report. Nothing automated
-- writes here: filing requires credentials and a judgement this database has no business
-- making. It exists so the queue can show what has and has not been filed, and so the
-- preservation window can be measured from the date that actually starts it.
ALTER TABLE reports ADD COLUMN ncmec_reported_at TEXT;

-- ── Releasing a hold ─────────────────────────────────────────────────────────────────────
--
-- A hold that can never be lifted is the wrong shape, and noticing why is worth writing down.
-- Filing a report costs a viewer nothing but a share link, and the severe category is one
-- click away from the ordinary ones. So a hold with no release means any hostile invitee can
-- permanently pin a still of somebody's living room in this database, under the worst
-- available accusation, and no operator could ever remove it. The accused broadcaster would
-- have no recourse and we would have no way to clean up after a misfire.
--
-- The duty attaches to APPARENT child sexual abuse material. An operator who has looked and
-- found something that plainly is not that has no duty in the first place, and therefore
-- nothing to preserve. So a release exists — but it is a deliberate, recorded act with a
-- reason attached, not the ordinary delete button wearing a different label.
--
-- It refuses once ncmec_reported_at is set. After a submission the statutory year is running
-- on a real filing, and no judgement made here can stop it.
ALTER TABLE reports ADD COLUMN hold_released_at TEXT;
ALTER TABLE reports ADD COLUMN hold_release_reason TEXT;

-- The reaper now filters on preserve_until, and the queue sorts unfiled severe reports first.
CREATE INDEX IF NOT EXISTS idx_reports_preserve ON reports (preserve_until);
