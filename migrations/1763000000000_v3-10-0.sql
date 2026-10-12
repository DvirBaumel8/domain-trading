-- Up Migration
-- v3.10.0 (CR-043): the intake topic. The scout's optional `topic`, else `<lane>:<first two content tokens>` (resolved when the name arrives);
-- a topic seen on another name within `intake.topic_window_days` is flagged TOPIC_REUSED. Lower-case, at most 60 characters; null = no topic stored (an old row, or a removed name with no split).
ALTER TABLE public.candidate_intake ADD COLUMN topic text CHECK (topic IS NULL OR (char_length(topic) BETWEEN 1 AND 60 AND topic = lower(topic)));
CREATE INDEX candidate_intake_topic_idx ON public.candidate_intake (topic, received_at) WHERE topic IS NOT NULL;

-- Down Migration
DROP INDEX public.candidate_intake_topic_idx;
ALTER TABLE public.candidate_intake DROP COLUMN topic;
