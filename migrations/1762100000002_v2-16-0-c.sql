-- Up Migration
-- v2.16.0 (tech-debt C): a post row is written BEFORE Buffer is called, so a crash or a lost answer can never lead to a second post.
--   pending = about to be sent (counts toward the daily cap), unknown = the send may have gone through (counts toward the cap too).
ALTER TABLE public.posts DROP CONSTRAINT posts_status_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_status_check CHECK (status IN ('pending', 'posted', 'failed', 'removed', 'unknown'));

CREATE OR REPLACE FUNCTION public.posts_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('pending', 'unknown') THEN
    -- pending -> posted | failed | unknown, unknown -> posted | failed: status and the Buffer fill-in fields only.
    IF ((OLD.status = 'pending' AND NEW.status IN ('posted', 'failed', 'unknown')) OR (OLD.status = 'unknown' AND NEW.status IN ('posted', 'failed')))
       AND (to_jsonb(NEW) - 'status' - 'buffer_post_id' - 'external_link' - 'sent_at' - 'error') = (to_jsonb(OLD) - 'status' - 'buffer_post_id' - 'external_link' - 'sent_at' - 'error') THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'posted' THEN
    IF NEW.status = 'posted'
       AND (to_jsonb(NEW) - 'external_link' - 'sent_at' - 'error') = (to_jsonb(OLD) - 'external_link' - 'sent_at' - 'error')
       AND (OLD.external_link IS NULL OR NEW.external_link IS NOT DISTINCT FROM OLD.external_link)
       AND (OLD.sent_at IS NULL OR NEW.sent_at IS NOT DISTINCT FROM OLD.sent_at)
       AND (OLD.error IS NULL OR NEW.error IS NOT DISTINCT FROM OLD.error) THEN
      RETURN NEW;
    END IF;
    IF NEW.status = 'removed' AND OLD.removed_at IS NULL
       AND (to_jsonb(NEW) - 'status' - 'removed_at' - 'removed_reason') = (to_jsonb(OLD) - 'status' - 'removed_at' - 'removed_reason') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'append-only table %: % is not allowed (only pending/unknown resolution, fill-ins on a posted row and posted -> removed)', TG_TABLE_NAME, TG_OP;
END
$$;

-- Down Migration
ALTER TABLE public.posts DROP CONSTRAINT posts_status_check;
ALTER TABLE public.posts ADD CONSTRAINT posts_status_check CHECK (status IN ('posted', 'failed', 'removed'));
