-- Up Migration
-- v2.12.0 (CR-011 part A through Buffer): our own record of the company's X posts, their images, the pause switch and the burst days.
-- The service never posts by itself; a post exists only through POST /posts (WRITE). Business data in the nightly export,
-- except post_images.data (the image bytes stay out of the export).

CREATE TABLE public.posts (
  id text PRIMARY KEY CHECK (id ~ '^pst_[0-9a-f]{12}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  audit_id text,
  idempotency_key text,
  text text NOT NULL,
  thread jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('posted', 'failed', 'removed')),
  buffer_post_id text,
  external_link text,
  sent_at timestamptz,
  error text,
  removed_at timestamptz,
  removed_reason text,
  idt_day date NOT NULL,
  CONSTRAINT posts_removed_fields CHECK ((status = 'removed') = (removed_at IS NOT NULL AND removed_reason IS NOT NULL)),
  CONSTRAINT posts_failed_error CHECK (status <> 'failed' OR error IS NOT NULL)
);
CREATE INDEX posts_day_idx ON public.posts (idt_day);
CREATE INDEX posts_created_idx ON public.posts (created_at DESC);

-- A row never changes, except: external_link, sent_at and error are filled in once on a posted row (null -> value), and a posted row
-- becomes removed (status, removed_at, removed_reason). No delete, no truncate.
CREATE FUNCTION public.posts_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
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
  RAISE EXCEPTION 'append-only table %: % is not allowed (only fill-ins on a posted row and posted -> removed)', TG_TABLE_NAME, TG_OP;
END
$$;
CREATE TRIGGER posts_guard BEFORE DELETE OR UPDATE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.posts_guard();
CREATE TRIGGER posts_no_truncate BEFORE TRUNCATE ON public.posts FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

-- The images are stored before Buffer is called (Buffer fetches them from /media/<token>), so the post row does not exist yet:
-- post_id has no foreign key. `data` is null in a restored database (the export leaves the bytes out).
CREATE TABLE public.post_images (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id text NOT NULL CHECK (post_id ~ '^pst_[0-9a-f]{12}$'),
  part integer NOT NULL CHECK (part BETWEEN 1 AND 3),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 4),
  mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
  bytes integer NOT NULL CHECK (bytes > 0),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  alt text NOT NULL CHECK (length(alt) BETWEEN 1 AND 1000),
  data bytea,
  media_token text NOT NULL UNIQUE CHECK (media_token ~ '^[0-9a-f]{32}$'),
  media_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, part, position)
);

-- The pause switch: the newest row is the state; no row = not paused.
CREATE TABLE public.posting_switches (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  "by" text NOT NULL,
  audit_id text,
  paused boolean NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300)
);

-- A burst allowance for one IDT day; the newest row of a day wins. It ends by itself after that day.
CREATE TABLE public.posting_bursts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day date NOT NULL,
  cap integer NOT NULL CHECK (cap BETWEEN 2 AND 5),
  at timestamptz NOT NULL DEFAULT now(),
  "by" text NOT NULL,
  audit_id text
);
CREATE INDEX posting_bursts_day_idx ON public.posting_bursts (day);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['post_images', 'posting_switches', 'posting_bursts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.reject_mutation()', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation()', t || '_no_truncate', t);
  END LOOP;
END $$;

-- Down Migration
DROP TABLE public.posting_bursts;
DROP TABLE public.posting_switches;
DROP TABLE public.post_images;
DROP TABLE public.posts;
DROP FUNCTION public.posts_guard();
