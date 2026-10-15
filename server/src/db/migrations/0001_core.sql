-- 0001_core.sql — BigCRM core schema, PostgreSQL 15+.
--
-- Conventions
--   * Primary keys are `uuid` supplied by the application (crypto.randomUUID()).
--   * Money is BIGINT minor units (cents). No floating point for money anywhere.
--   * Timestamps are `timestamptz`. Application code always renders ISO-8601 UTC.
--   * Every tenant-scoped table carries `organization_id uuid NOT NULL` plus an index.
--   * Soft delete via deleted_at / deleted_by where history must be preserved (RULE 74).
--
-- DDL ORDER IS SIGNIFICANT. Tables are created in dependency order and no foreign
-- key may reference a table that does not yet exist. The legacy CRM shipped DDL
-- where `contacts` referenced `companies` before `companies` was created; SQLite
-- accepted it silently and PostgreSQL rejected it at runtime. These migrations run
-- against real PostgreSQL in CI, so that class of defect cannot ship again.

-- ── identity & tenancy ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id             uuid PRIMARY KEY,
  name           text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  slug           text        NOT NULL UNIQUE,
  currency       char(3)     NOT NULL DEFAULT 'USD',
  timezone       text        NOT NULL DEFAULT 'UTC',
  locale         text        NOT NULL DEFAULT 'en',
  data_region    text        NOT NULL DEFAULT 'us-east-1',
  retention_days integer     NOT NULL DEFAULT 730 CHECK (retention_days BETWEEN 30 AND 3650),
  settings       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  deleted_by     uuid
);
CREATE INDEX IF NOT EXISTS idx_org_slug ON organizations (slug) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY,
  email               text        NOT NULL,
  email_normalized    text        NOT NULL UNIQUE,
  name                text        NOT NULL DEFAULT '',
  password_hash       text        NOT NULL,
  avatar_url          text,
  locale              text        NOT NULL DEFAULT 'en',
  timezone            text        NOT NULL DEFAULT 'UTC',
  email_verified_at   timestamptz,
  mfa_enabled         boolean     NOT NULL DEFAULT false,
  mfa_enrolled_at     timestamptz,
  failed_login_count  integer     NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until        timestamptz,
  password_changed_at timestamptz,
  last_login_at       timestamptz,
  last_login_ip       inet,
  default_org_id      uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK (length(email_normalized) <= 320)
);
-- Case-insensitive uniqueness is enforced by storing email_normalized.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_norm ON users (email_normalized) WHERE deleted_at IS NULL;

-- Roles are a closed set with an explicit rank, so hierarchy is a data property
-- rather than an assumption scattered across permission checks (RULE 27).
CREATE TABLE IF NOT EXISTS organization_members (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner','admin','manager','sales','viewer')),
  team_id         uuid,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','suspended')),
  title           text,
  joined_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_org  ON organization_members (organization_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON organization_members (user_id);

CREATE TABLE IF NOT EXISTS teams (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams (organization_id) WHERE deleted_at IS NULL;

-- team_id is added by 0002 because teams is created after members in this file order.
CREATE TABLE IF NOT EXISTS team_members (
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_org ON team_members (organization_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

-- ── CRM core ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS companies (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  name_normalized  text   NOT NULL,
  domain           text,
  industry         text,
  website          text,
  email            text,
  phone            text,
  employee_count   integer CHECK (employee_count IS NULL OR employee_count >= 0),
  annual_revenue_c bigint  CHECK (annual_revenue_c IS NULL OR annual_revenue_c >= 0),
  owner_id         uuid   REFERENCES users(id) ON DELETE SET NULL,
  status           text   NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  description      text,
  address_line1    text, address_line2 text, city text, region text,
  postal_code      text, country_code char(2),
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid   REFERENCES users(id) ON DELETE SET NULL,
  updated_by       uuid   REFERENCES users(id) ON DELETE SET NULL,
  deleted_at       timestamptz,
  deleted_by       uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_org_name_norm
  ON companies (organization_id, name_normalized) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_org        ON companies (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_org_domain ON companies (organization_id, domain) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_owner      ON companies (organization_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_updated    ON companies (organization_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS contacts (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name       text NOT NULL DEFAULT '',
  last_name        text NOT NULL DEFAULT '',
  email            text,
  email_normalized text,
  secondary_email  text,
  phone            text,
  phone_normalized text,
  mobile_phone     text,
  job_title        text,
  department       text,
  company_id       uuid REFERENCES companies(id) ON DELETE SET NULL,
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  source           text,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  lifecycle_stage  text NOT NULL DEFAULT 'lead'
                     CHECK (lifecycle_stage IN ('lead','prospect','customer','churned')),
  address_line1    text, city text, region text, postal_code text, country_code char(2),
  website          text, linkedin_url text, birthday date,
  description      text,
  last_contacted_at timestamptz,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at       timestamptz,
  deleted_by       uuid
);
-- Duplicate prevention is a database constraint, not an application check (RULE 72/177).
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_org_email_norm
  ON contacts (organization_id, email_normalized)
  WHERE deleted_at IS NULL AND email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_org         ON contacts (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_org_updated ON contacts (organization_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_owner       ON contacts (organization_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_company     ON contacts (organization_id, company_id) WHERE deleted_at IS NULL AND company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_stage       ON contacts (organization_id, lifecycle_stage) WHERE deleted_at IS NULL;
-- trigram-capable search index; the extension is optional and guarded below.
CREATE INDEX IF NOT EXISTS idx_contacts_search_lower
  ON contacts (organization_id, lower(first_name || ' ' || last_name)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS leads (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name       text NOT NULL DEFAULT '',
  last_name        text NOT NULL DEFAULT '',
  company_name     text,
  email            text,
  email_normalized text,
  phone            text,
  title            text,
  source           text,
  status           text NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','contacted','qualified','unqualified','nurturing','converted','lost')),
  score            integer NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  rating           text CHECK (rating IN ('hot','warm','cold')),
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  company_id       uuid REFERENCES companies(id) ON DELETE SET NULL,
  converted_at     timestamptz,
  converted_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  converted_deal_id    uuid,
  description      text,
  lost_reason      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at       timestamptz,
  deleted_by       uuid
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_org_email_norm
  ON leads (organization_id, email_normalized)
  WHERE deleted_at IS NULL AND email_normalized IS NOT NULL AND status <> 'converted';
CREATE INDEX IF NOT EXISTS idx_leads_org      ON leads (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_org_sort ON leads (organization_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_owner   ON leads (organization_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads (organization_id, status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pipelines (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description     text,
  is_default      boolean NOT NULL DEFAULT false,
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (organization_id, name)
);
CREATE INDEX IF NOT EXISTS idx_pipelines_org ON pipelines (organization_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id             uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id    uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name           text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  position       integer NOT NULL CHECK (position >= 0),
  probability    integer NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  is_won         boolean NOT NULL DEFAULT false,
  is_lost        boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (pipeline_id, position),
  UNIQUE (pipeline_id, name)
);
-- The composite unique key that the deals -> stages composite FK below requires.
-- It must exist before `deals` is created: PostgreSQL rejects a foreign key whose
-- referenced columns are not backed by a unique constraint (SQLSTATE 42830).
ALTER TABLE pipeline_stages ADD CONSTRAINT uq_stages_pipeline_id UNIQUE (pipeline_id, id);
CREATE INDEX IF NOT EXISTS idx_stages_pipeline ON pipeline_stages (pipeline_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS deals (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  value_c            bigint CHECK (value_c IS NULL OR value_c >= 0),
  currency           char(3) NOT NULL DEFAULT 'USD',
  pipeline_id        uuid NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
  stage_id           uuid NOT NULL REFERENCES pipeline_stages(id) ON DELETE RESTRICT,
  probability        integer CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
  expected_close_date date,
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  company_id         uuid REFERENCES companies(id) ON DELETE SET NULL,
  owner_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  source             text,
  status             text   NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  lost_reason        text,
  closed_at          timestamptz,
  description        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_at         timestamptz,
  deleted_by         uuid,
  -- A stage must belong to the deal's pipeline. Enforced in the database, not the app.
  CONSTRAINT deals_stage_matches_pipeline
    FOREIGN KEY (pipeline_id, stage_id) REFERENCES pipeline_stages (pipeline_id, id) DEFERRABLE INITIALLY DEFERRED
);
-- The composite FK above needs a matching unique constraint.
CREATE INDEX IF NOT EXISTS idx_deals_org      ON deals (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_org_sort ON deals (organization_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_stage    ON deals (organization_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_owner    ON deals (organization_id, owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_close    ON deals (organization_id, expected_close_date) WHERE deleted_at IS NULL;

ALTER TABLE leads ADD CONSTRAINT leads_converted_deal_fk
  FOREIGN KEY (converted_deal_id) REFERENCES deals(id) ON DELETE SET NULL;

-- ── activities, tasks, notes ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activities (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type             text   NOT NULL CHECK (type IN
                   ('call','email','meeting','task','note','status_change','created','assignment',
                    'comment','upload','deal_created','deal_won','deal_lost','lead_converted')),
  actor_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  entity_type      text   NOT NULL CHECK (entity_type IN ('contact','company','lead','deal','task','note','organization','user')),
  entity_id        uuid   NOT NULL,
  subject          text,
  description      text,
  metadata         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activities_org    ON activities (organization_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activities_entity ON activities (organization_id, entity_type, entity_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title            text   NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  description      text   NOT NULL DEFAULT '',
  status           text   NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','blocked','completed','cancelled')),
  priority         text   NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  assignee_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  creator_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  due_date         timestamptz,
  completed_at     timestamptz,
  related_type     text   CHECK (related_type IN ('contact','company','lead','deal')),
  related_id       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  deleted_by       uuid,
  CONSTRAINT tasks_completed_consistent CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tasks_org       ON tasks (organization_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_org_sort  ON tasks (organization_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_assignee  ON tasks (organization_id, assignee_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_due       ON tasks (organization_id, due_date) WHERE deleted_at IS NULL AND due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_related   ON tasks (organization_id, related_type, related_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS notes (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type      text   NOT NULL CHECK (entity_type IN ('contact','company','lead','deal')),
  entity_id        uuid   NOT NULL,
  body_html        text   NOT NULL DEFAULT '',
  body_text        text   NOT NULL DEFAULT '',
  author_id        uuid   REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  deleted_by       uuid
);
CREATE INDEX IF NOT EXISTS idx_notes_entity ON notes (organization_id, entity_type, entity_id, created_at DESC) WHERE deleted_at IS NULL;

-- ── tags ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tags (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  name_normalized text   NOT NULL,
  color           text   NOT NULL DEFAULT '#6b7280' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Race-proof creation (RULE 146): the unique index is the arbiter, and callers
  -- upsert on conflict rather than SELECT-then-INSERT.
  UNIQUE (organization_id, name_normalized)
);
CREATE INDEX IF NOT EXISTS idx_tags_org ON tags (organization_id);

CREATE TABLE IF NOT EXISTS contact_tags (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id          uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags (organization_id, tag_id);

CREATE TABLE IF NOT EXISTS company_tags (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tag_id          uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_company_tags_tag ON company_tags (organization_id, tag_id);

CREATE TABLE IF NOT EXISTS lead_tags (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id          uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, tag_id)
);

CREATE TABLE IF NOT EXISTS deal_tags (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id         uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  tag_id          uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, tag_id)
);

-- ── custom fields ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS custom_fields (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type      text   NOT NULL CHECK (entity_type IN ('contact','company','lead','deal','task')),
  key              text   NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label            text   NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  field_type       text   NOT NULL CHECK (field_type IN
                   ('text','long_text','number','currency','date','datetime','boolean','select','multi_select','email','phone','url')),
  options          jsonb  NOT NULL DEFAULT '[]'::jsonb,
  default_value    jsonb,
  is_required      boolean NOT NULL DEFAULT false,
  is_searchable    boolean NOT NULL DEFAULT false,
  position         integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, entity_type, key)
);
CREATE INDEX IF NOT EXISTS idx_custom_fields_org ON custom_fields (organization_id) WHERE deleted_at IS NULL;

-- Values are keyed by (field, entity) with no entity table reference: generic by
-- design so adding an entity type does not need a schema migration. Values are
-- validated against the field definition in the service layer (RULE 147).
CREATE TABLE IF NOT EXISTS custom_field_values (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  field_id        uuid NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  entity_type     text   NOT NULL,
  entity_id       uuid   NOT NULL,
  value_text      text,
  value_number    numeric,
  value_date      timestamptz,
  value_bool      boolean,
  value_json      jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (field_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_cfv_entity ON custom_field_values (organization_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_cfv_text   ON custom_field_values (organization_id, field_id) WHERE value_text IS NOT NULL;

-- ── attachments & comments ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS attachments (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type     text   NOT NULL CHECK (entity_type IN ('contact','company','lead','deal','task','note')),
  entity_id       uuid   NOT NULL,
  file_id         uuid   NOT NULL,
  file_name       text   NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type    text   NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key     text   NOT NULL,
  checksum_sha256 char(64) NOT NULL,
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  uploaded_by     uuid   REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  deleted_by      uuid
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments (organization_id, entity_type, entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_attachments_file    ON attachments (file_id);

CREATE TABLE IF NOT EXISTS comments (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type     text   NOT NULL,
  entity_id       uuid   NOT NULL,
  author_id       uuid   REFERENCES users(id) ON DELETE SET NULL,
  body_html       text   NOT NULL,
  body_text       text   NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments (organization_id, entity_type, entity_id, created_at DESC) WHERE deleted_at IS NULL;

-- ── notifications ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text   NOT NULL,
  title           text   NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body            text   NOT NULL DEFAULT '',
  link            text,
  entity_type     text,
  entity_id       uuid,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

-- ── audit & security telemetry ───────────────────────────────────────────────

-- Append-only. There is no code path that updates or deletes these rows; a
-- trigger raises if anyone tries, so tampering fails even at the SQL layer.
CREATE TABLE IF NOT EXISTS audit_logs (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role       text,
  action           text   NOT NULL,
  entity_type      text   NOT NULL,
  entity_id        uuid,
  outcome          text   NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure','denied')),
  before_json      jsonb,
  after_json       jsonb,
  changed_fields   text[],
  ip               inet,
  user_agent       text,
  request_id       text,
  metadata         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org   ON audit_logs (organization_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs (actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (organization_id, entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (attempted %)', TG_OP
    USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

CREATE TABLE IF NOT EXISTS security_events (
  id              uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  event           text   NOT NULL,
  severity        text   NOT NULL DEFAULT 'info' CHECK (severity IN ('info','low','medium','high','critical')),
  outcome         text   NOT NULL DEFAULT 'success',
  ip              inet,
  user_agent      text,
  request_id      text,
  details         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_security_events_org ON security_events (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_sev ON security_events (severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ── sessions, tokens, invitations ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  role             text,
  family_id        uuid   NOT NULL,
  refresh_jti      text   NOT NULL,
  refresh_hash     text   NOT NULL,
  used_at          timestamptz,
  rotated_at       timestamptz,
  ip               inet,
  user_agent       text,
  device_label     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_reason   text
);
CREATE INDEX IF NOT EXISTS idx_sessions_user   ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_family ON sessions (family_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions (last_seen_at) WHERE revoked_at IS NULL;

-- One live refresh token per family. This single constraint is what makes
-- refresh-token reuse detectable as a race rather than a heuristic.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_refresh_jti ON sessions (refresh_jti);

CREATE TABLE IF NOT EXISTS password_resets (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       char(64) NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  requested_ip     inet,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_verifications (
  id               uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       char(64) NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  used_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emailverif_user ON email_verifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invitations (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email_normalized text   NOT NULL,
  role             text   NOT NULL CHECK (role IN ('owner','admin','manager','sales','viewer')),
  team_id          uuid REFERENCES teams(id) ON DELETE SET NULL,
  token_hash       char(64) NOT NULL UNIQUE,
  invited_by       uuid   REFERENCES users(id) ON DELETE SET NULL,
  expires_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invitations_org   ON invitations (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (email_normalized) WHERE accepted_at IS NULL;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   char(64) NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON mfa_recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS api_tokens (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  token_hash       char(64) NOT NULL UNIQUE,
  prefix           text   NOT NULL,
  scopes           text[] NOT NULL DEFAULT '{}',
  last_used_at     timestamptz,
  last_used_ip     inet,
  expires_at       timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_org ON api_tokens (organization_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS saved_views (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  owner_id        uuid   REFERENCES users(id) ON DELETE CASCADE,
  name            text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  entity_type     text   NOT NULL,
  filters         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  sort            jsonb  NOT NULL DEFAULT '{}'::jsonb,
  columns         text[] NOT NULL DEFAULT '{}',
  is_shared       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_saved_views_owner ON saved_views (organization_id, owner_id) WHERE deleted_at IS NULL;

-- ── jobs: imports, exports, webhooks ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS import_jobs (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type      text   NOT NULL,
  created_by       uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           text   NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','validating','processing','completed','failed','cancelled')),
  storage_key      text,
  original_name    text,
  total_rows       integer NOT NULL DEFAULT 0,
  processed_rows   integer NOT NULL DEFAULT 0,
  created_count    integer NOT NULL DEFAULT 0,
  updated_count    integer NOT NULL DEFAULT 0,
  skipped_count    integer NOT NULL DEFAULT 0,
  error_count      integer NOT NULL DEFAULT 0,
  error_report_key text,
  idempotency_key  text,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_org ON import_jobs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS export_jobs (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type      text   NOT NULL,
  created_by       uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status           text   NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','processing','completed','failed','expired')),
  filters          jsonb  NOT NULL DEFAULT '{}'::jsonb,
  storage_key      text,
  row_count        integer,
  byte_size        bigint,
  idempotency_key  text,
  expires_at       timestamptz NOT NULL,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_org ON export_jobs (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id               uuid PRIMARY KEY,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url              text   NOT NULL,
  secret_hash      text   NOT NULL,
  events           text[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  failure_count    integer NOT NULL DEFAULT 0,
  last_success_at  timestamptz,
  last_failure_at  timestamptz,
  created_by       uuid   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhook_endpoints (organization_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  endpoint_id     uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event           text   NOT NULL,
  payload         jsonb  NOT NULL,
  attempt         integer NOT NULL DEFAULT 1,
  status          text   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','delivered','failed','dropped')),
  response_status integer,
  response_body   text,
  next_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_ep ON webhook_deliveries (organization_id, endpoint_id, created_at DESC);

-- ── idempotency ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS idempotency_keys (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key             text   NOT NULL,
  endpoint        text   NOT NULL,
  request_hash    char(64) NOT NULL,
  response_status integer,
  response_body   jsonb,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (organization_id, key, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys (expires_at);