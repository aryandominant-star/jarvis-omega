-- Reusable, long-lived enrollment codes so a pre-configured installer can be built once and shared.
-- A reusable code is never marked "used" and can pair many devices until it expires or is revoked.
ALTER TABLE pairing_codes ADD COLUMN reusable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pairing_codes ADD COLUMN label TEXT;
