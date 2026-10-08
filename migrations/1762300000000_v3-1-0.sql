-- Up Migration
-- v3.1.0 (CR-016 B R-1): how many Google calls one review took (a 503 / UNAVAILABLE is retried in the call, up to 3 tries). Null on older rows and on feedback a bot sent.
ALTER TABLE public.review_feedback ADD COLUMN attempts integer CHECK (attempts IS NULL OR attempts BETWEEN 1 AND 3);

-- Down Migration
ALTER TABLE public.review_feedback DROP COLUMN attempts;
