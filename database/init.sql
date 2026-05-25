-- Database schema for Cloud Device Monitor V2.
-- The backend also creates these tables automatically at startup.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(128) NOT NULL,
    type VARCHAR(64) NOT NULL,
    location VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_fields (
    id SERIAL PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    field_key VARCHAR(64) NOT NULL,
    label VARCHAR(128) NOT NULL,
    unit VARCHAR(32) NOT NULL DEFAULT '',
    value_type VARCHAR(16) NOT NULL DEFAULT 'number',
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(device_id, field_key)
);

CREATE TABLE IF NOT EXISTS measurement_values (
    id SERIAL PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    field_id INTEGER NOT NULL REFERENCES device_fields(id) ON DELETE CASCADE,
    numeric_value NUMERIC(14, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_measurement_values_device_time
ON measurement_values(device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_measurement_values_field_time
ON measurement_values(field_id, created_at DESC);
