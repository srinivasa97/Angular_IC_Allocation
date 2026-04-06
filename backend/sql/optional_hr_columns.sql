-- Run once if your `allocation` schema does not yet have HR fields.
-- Adjust database name if needed.

USE allocation;

ALTER TABLE candidates
  ADD COLUMN suggested_ic VARCHAR(255) NULL COMMENT 'HR preferred IC name (soft match to requirements.icname)';

ALTER TABLE candidates
  ADD COLUMN candidate_suitable VARCHAR(255) NULL COMMENT 'HR role suitability; matched to requirements.role_name';

ALTER TABLE requirements
  ADD COLUMN role_name VARCHAR(255) NULL COMMENT 'Required role line for this seat; optional if null';
