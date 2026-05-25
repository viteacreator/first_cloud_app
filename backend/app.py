import os
import re
import time
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from functools import wraps

import jwt
import psycopg2
from psycopg2.extras import RealDictCursor
from flask import Flask, jsonify, request
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://cloud_user:cloud_pass@localhost:5432/cloud_lab"
)

JWT_SECRET = os.getenv("JWT_SECRET", "change-this-secret")
TOKEN_HOURS = int(os.getenv("TOKEN_HOURS", "12"))

app = Flask(__name__)
CORS(app)


def get_connection():
    return psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor)


def make_json_safe(value):
    if isinstance(value, dict):
        return {key: make_json_safe(item) for key, item in value.items()}

    if isinstance(value, list):
        return [make_json_safe(item) for item in value]

    if isinstance(value, datetime):
        return value.isoformat()

    if isinstance(value, Decimal):
        return float(value)

    return value


def wait_for_database():
    last_error = None

    for _ in range(30):
        try:
            conn = get_connection()
            conn.close()
            return
        except Exception as error:
            last_error = error
            time.sleep(2)

    raise RuntimeError(f"Database is not available: {last_error}")


def normalize_field_key(label):
    key = label.strip().lower()
    key = re.sub(r"[^a-z0-9]+", "_", key)
    key = re.sub(r"_+", "_", key).strip("_")

    if not key:
        key = "field"

    return key[:48]


def parse_timestamp(value):
    if not value:
        return datetime.now(timezone.utc)

    try:
        clean_value = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(clean_value)

        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)

        return parsed
    except Exception:
        return datetime.now(timezone.utc)


def get_cutoff_from_period(period):
    now = datetime.now(timezone.utc)

    if period == "1h":
        return now - timedelta(hours=1)

    if period == "6h":
        return now - timedelta(hours=6)

    if period == "24h":
        return now - timedelta(hours=24)

    if period == "7d":
        return now - timedelta(days=7)

    if period == "30d":
        return now - timedelta(days=30)

    return None


def initialize_database():
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(64) UNIQUE NOT NULL,
            is_admin BOOLEAN NOT NULL DEFAULT FALSE,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    cur.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            id SERIAL PRIMARY KEY,
            owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name VARCHAR(128) NOT NULL,
            type VARCHAR(64) NOT NULL,
            location VARCHAR(128) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    cur.execute("""
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
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS measurement_values (
            id SERIAL PRIMARY KEY,
            device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            field_id INTEGER NOT NULL REFERENCES device_fields(id) ON DELETE CASCADE,
            numeric_value NUMERIC(14, 4) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    """)

    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_measurement_values_device_time
        ON measurement_values(device_id, created_at DESC);
    """)

    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_measurement_values_field_time
        ON measurement_values(field_id, created_at DESC);
    """)

    cur.execute("SELECT id, is_admin FROM users WHERE username = %s;", ("admin",))
    admin = cur.fetchone()

    if admin is None:
        cur.execute(
            """
                INSERT INTO users (username, is_admin, password_hash)
                VALUES (%s, %s, %s)
                RETURNING id;
            """,
            ("admin", True, generate_password_hash("admin123"))
        )
        admin_id = cur.fetchone()["id"]

        cur.execute("""
            INSERT INTO devices (owner_id, name, type, location)
            VALUES
                (%s, 'Battery Tester', 'VMU', 'Lab bench'),
                (%s, 'Banya Sensor', 'Temperature / Light', 'Banya'),
                (%s, 'Solar Monitor', 'Power monitor', 'Workshop');
        """, (admin_id, admin_id, admin_id))
    else:
        admin_id = admin["id"]

        if not admin["is_admin"]:
            cur.execute(
                "UPDATE users SET is_admin = TRUE WHERE id = %s;",
                (admin_id,)
            )

    cur.execute("SELECT id, name FROM devices WHERE owner_id = %s ORDER BY id;", (admin_id,))
    devices = cur.fetchall()

    for device_index, device in enumerate(devices):
        cur.execute("SELECT COUNT(*) AS count FROM device_fields WHERE device_id = %s;", (device["id"],))
        field_count = cur.fetchone()["count"]

        if field_count == 0:
            if "Banya" in device["name"]:
                fields = [
                    ("temperature", "Temperature", "°C", 1),
                    ("light", "Luminosity", "lux", 2)
                ]
            elif "Solar" in device["name"]:
                fields = [
                    ("voltage", "Voltage", "V", 1),
                    ("current", "Current", "A", 2),
                    ("power", "Power", "W", 3)
                ]
            else:
                fields = [
                    ("voltage", "Voltage", "V", 1),
                    ("current", "Current", "A", 2),
                    ("temperature", "Temperature", "°C", 3)
                ]

            for field_key, label, unit, order_index in fields:
                cur.execute("""
                    INSERT INTO device_fields
                        (device_id, field_key, label, unit, display_order)
                    VALUES
                        (%s, %s, %s, %s, %s)
                    ON CONFLICT (device_id, field_key) DO NOTHING;
                """, (device["id"], field_key, label, unit, order_index))

    cur.execute("SELECT COUNT(*) AS count FROM measurement_values;")
    measurement_count = cur.fetchone()["count"]

    if measurement_count == 0:
        cur.execute("""
            SELECT d.id AS device_id, f.id AS field_id, f.field_key
            FROM devices d
            JOIN device_fields f ON f.device_id = d.id
            WHERE d.owner_id = %s
            ORDER BY d.id, f.display_order;
        """, (admin_id,))
        field_rows = cur.fetchall()

        base_time = datetime.now(timezone.utc) - timedelta(hours=3)

        for point_index in range(16):
            timestamp = base_time + timedelta(minutes=point_index * 12)

            for row in field_rows:
                field_key = row["field_key"]

                if field_key == "voltage":
                    value = 12.0 + point_index * 0.08
                elif field_key == "current":
                    value = 1.0 + (point_index % 5) * 0.18
                elif field_key == "temperature":
                    value = 28.0 + point_index * 1.4
                elif field_key == "light":
                    value = 100.0 + point_index * 35.0
                elif field_key == "power":
                    value = 80.0 + point_index * 8.5
                else:
                    value = point_index

                cur.execute("""
                    INSERT INTO measurement_values
                        (device_id, field_id, numeric_value, created_at)
                    VALUES
                        (%s, %s, %s, %s);
                """, (row["device_id"], row["field_id"], value, timestamp))

    conn.commit()
    cur.close()
    conn.close()


def create_token(user):
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_HOURS)
    }

    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def require_auth(route_function):
    @wraps(route_function)
    def wrapper(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")

        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "Missing authorization token"}), 401

        token = auth_header.replace("Bearer ", "", 1)

        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        except Exception:
            return jsonify({"error": "Invalid or expired token"}), 401

        conn = get_connection()
        cur = conn.cursor()
        cur.execute(
            "SELECT id, username, is_admin FROM users WHERE id = %s;",
            (int(payload["sub"]),)
        )
        user = cur.fetchone()
        cur.close()
        conn.close()

        if user is None:
            return jsonify({"error": "Invalid or expired token"}), 401

        request.user_id = user["id"]
        request.username = user["username"]
        request.is_admin = user["is_admin"]

        return route_function(*args, **kwargs)

    return wrapper


def require_admin(route_function):
    @wraps(route_function)
    def wrapper(*args, **kwargs):
        if not getattr(request, "is_admin", False):
            return jsonify({"error": "Admin access is required"}), 403

        return route_function(*args, **kwargs)

    return wrapper


def get_device_or_404(device_id, owner_id):
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT id, owner_id, name, type, location, created_at
        FROM devices
        WHERE id = %s AND owner_id = %s;
    """, (device_id, owner_id))

    device = cur.fetchone()

    cur.close()
    conn.close()

    return device


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "service": "cloud-lab-backend"
    })


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True)

    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    conn = get_connection()
    cur = conn.cursor()

    cur.execute("SELECT * FROM users WHERE username = %s;", (username,))
    user = cur.fetchone()

    cur.close()
    conn.close()

    if user is None or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid username or password"}), 401

    return jsonify({
        "token": create_token(user),
        "username": user["username"],
        "is_admin": user["is_admin"]
    })


@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(force=True)

    username = data.get("username", "").strip()
    password = data.get("password", "")

    if len(username) < 3:
        return jsonify({"error": "Username must have at least 3 characters"}), 400

    if len(password) < 6:
        return jsonify({"error": "Password must have at least 6 characters"}), 400

    conn = get_connection()
    cur = conn.cursor()

    try:
        cur.execute(
            """
                INSERT INTO users (username, password_hash)
                VALUES (%s, %s)
                RETURNING id, username, is_admin;
            """,
            (username, generate_password_hash(password))
        )
        user = cur.fetchone()
        conn.commit()
    except psycopg2.errors.UniqueViolation:
        conn.rollback()
        cur.close()
        conn.close()
        return jsonify({"error": "Username already exists"}), 409

    cur.close()
    conn.close()

    return jsonify({
        "token": create_token(user),
        "username": user["username"],
        "is_admin": user["is_admin"]
    }), 201


@app.route("/api/dashboard", methods=["GET"])
@require_auth
def dashboard():
    conn = get_connection()
    cur = conn.cursor()

    cur.execute(
        "SELECT username, is_admin FROM users WHERE id = %s;",
        (request.user_id,)
    )
    user = cur.fetchone()

    if user is None:
        cur.close()
        conn.close()
        return jsonify({"error": "User not found"}), 404

    cur.execute("""
        SELECT COUNT(*) AS device_count
        FROM devices
        WHERE owner_id = %s;
    """, (request.user_id,))
    device_count = cur.fetchone()["device_count"]

    cur.execute("""
        SELECT COUNT(*) AS field_count
        FROM device_fields f
        JOIN devices d ON d.id = f.device_id
        WHERE d.owner_id = %s;
    """, (request.user_id,))
    field_count = cur.fetchone()["field_count"]

    cur.execute("""
        SELECT COUNT(*) AS measurement_count
        FROM measurement_values mv
        JOIN devices d ON d.id = mv.device_id
        WHERE d.owner_id = %s;
    """, (request.user_id,))
    measurement_count = cur.fetchone()["measurement_count"]

    cur.execute("""
        SELECT MAX(mv.created_at) AS last_measurement_at
        FROM measurement_values mv
        JOIN devices d ON d.id = mv.device_id
        WHERE d.owner_id = %s;
    """, (request.user_id,))
    last_row = cur.fetchone()

    cur.close()
    conn.close()

    return jsonify(make_json_safe({
        "username": user["username"],
        "is_admin": user["is_admin"],
        "device_count": device_count,
        "field_count": field_count,
        "measurement_count": measurement_count,
        "last_measurement_at": last_row["last_measurement_at"]
    }))


@app.route("/api/devices", methods=["GET"])
@require_auth
def get_devices():
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT id, name, type, location, created_at
        FROM devices
        WHERE owner_id = %s
        ORDER BY id DESC;
    """, (request.user_id,))
    devices = cur.fetchall()

    result = []

    for device in devices:
        cur.execute("""
            SELECT id, field_key, label, unit, value_type, display_order
            FROM device_fields
            WHERE device_id = %s
            ORDER BY display_order, id;
        """, (device["id"],))
        fields = cur.fetchall()

        cur.execute("""
            SELECT DISTINCT ON (f.id)
                f.field_key,
                f.label,
                f.unit,
                mv.numeric_value,
                mv.created_at
            FROM device_fields f
            LEFT JOIN measurement_values mv ON mv.field_id = f.id
            WHERE f.device_id = %s
            ORDER BY f.id, mv.created_at DESC;
        """, (device["id"],))
        latest_values = cur.fetchall()

        item = dict(device)
        item["fields"] = fields
        item["latest_values"] = latest_values

        result.append(item)

    cur.close()
    conn.close()

    return jsonify(make_json_safe(result))


@app.route("/api/devices", methods=["POST"])
@require_auth
def create_device():
    data = request.get_json(force=True)

    name = data.get("name", "").strip()
    device_type = data.get("type", "").strip()
    location = data.get("location", "").strip()
    fields = data.get("fields", [])

    if not name or not device_type or not location:
        return jsonify({"error": "Name, type and location are required"}), 400

    if not isinstance(fields, list) or len(fields) == 0:
        return jsonify({"error": "At least one data field is required"}), 400

    clean_fields = []

    for index, field in enumerate(fields):
        label = str(field.get("label", "")).strip()
        unit = str(field.get("unit", "")).strip()

        if not label:
            return jsonify({"error": "Each field must have a label"}), 400

        clean_fields.append({
            "label": label[:128],
            "unit": unit[:32],
            "display_order": index + 1
        })

    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        INSERT INTO devices (owner_id, name, type, location)
        VALUES (%s, %s, %s, %s)
        RETURNING id, name, type, location, created_at;
    """, (request.user_id, name, device_type, location))
    device = cur.fetchone()

    used_keys = set()

    for field in clean_fields:
        base_key = normalize_field_key(field["label"])
        field_key = base_key
        suffix = 2

        while field_key in used_keys:
            field_key = f"{base_key}_{suffix}"
            suffix += 1

        used_keys.add(field_key)

        cur.execute("""
            INSERT INTO device_fields
                (device_id, field_key, label, unit, display_order)
            VALUES
                (%s, %s, %s, %s, %s);
        """, (
            device["id"],
            field_key,
            field["label"],
            field["unit"],
            field["display_order"]
        ))

    conn.commit()
    cur.close()
    conn.close()

    return jsonify(make_json_safe(device)), 201


@app.route("/api/devices/<int:device_id>", methods=["DELETE"])
@require_auth
def delete_device(device_id):
    device = get_device_or_404(device_id, request.user_id)

    if device is None:
        return jsonify({"error": "Device not found"}), 404

    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM devices WHERE id = %s AND owner_id = %s;",
        (device_id, request.user_id)
    )
    conn.commit()
    cur.close()
    conn.close()

    return jsonify({
        "message": "Device deleted",
        "device": make_json_safe(device)
    })


@app.route("/api/measurements", methods=["GET"])
@require_auth
def get_measurements():
    device_id = request.args.get("device_id", type=int)
    field_key = request.args.get("field_key")
    period = request.args.get("period", "24h")
    limit = min(request.args.get("limit", 1000, type=int), 3000)

    if not device_id:
        return jsonify({"error": "device_id is required"}), 400

    device = get_device_or_404(device_id, request.user_id)

    if device is None:
        return jsonify({"error": "Device not found"}), 404

    cutoff = get_cutoff_from_period(period)

    conn = get_connection()
    cur = conn.cursor()

    query = """
        SELECT
            mv.id,
            mv.device_id,
            f.id AS field_id,
            f.field_key,
            f.label,
            f.unit,
            mv.numeric_value,
            mv.created_at
        FROM measurement_values mv
        JOIN device_fields f ON f.id = mv.field_id
        WHERE mv.device_id = %s
    """

    params = [device_id]

    if field_key:
        query += " AND f.field_key = %s"
        params.append(field_key)

    if cutoff is not None:
        query += " AND mv.created_at >= %s"
        params.append(cutoff)

    query += " ORDER BY mv.created_at DESC LIMIT %s;"
    params.append(limit)

    cur.execute(query, params)
    rows = cur.fetchall()

    cur.close()
    conn.close()

    return jsonify(make_json_safe({
        "device": device,
        "period": period,
        "measurements": rows
    }))


@app.route("/api/measurements", methods=["POST"])
@require_auth
def create_measurement():
    data = request.get_json(force=True)

    device_id = data.get("device_id")
    values = data.get("values", {})
    timestamp = parse_timestamp(data.get("timestamp"))

    if not device_id:
        return jsonify({"error": "device_id is required"}), 400

    if not isinstance(values, dict) or len(values) == 0:
        return jsonify({"error": "At least one measurement value is required"}), 400

    device = get_device_or_404(device_id, request.user_id)

    if device is None:
        return jsonify({"error": "Device not found"}), 404

    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT id, field_key, label, unit
        FROM device_fields
        WHERE device_id = %s;
    """, (device_id,))
    fields = cur.fetchall()

    field_map = {field["field_key"]: field for field in fields}

    inserted = []

    for field_key, raw_value in values.items():
        if field_key not in field_map:
            continue

        try:
            numeric_value = float(raw_value)
        except Exception:
            continue

        field = field_map[field_key]

        cur.execute("""
            INSERT INTO measurement_values
                (device_id, field_id, numeric_value, created_at)
            VALUES
                (%s, %s, %s, %s)
            RETURNING id, device_id, field_id, numeric_value, created_at;
        """, (device_id, field["id"], numeric_value, timestamp))

        inserted_row = cur.fetchone()
        inserted_row["field_key"] = field["field_key"]
        inserted_row["label"] = field["label"]
        inserted_row["unit"] = field["unit"]

        inserted.append(inserted_row)

    if len(inserted) == 0:
        conn.rollback()
        cur.close()
        conn.close()
        return jsonify({"error": "No valid measurement values were provided"}), 400

    conn.commit()
    cur.close()
    conn.close()

    return jsonify(make_json_safe({
        "inserted": inserted,
        "timestamp": timestamp
    })), 201


@app.route("/api/measurements/<int:measurement_id>", methods=["DELETE"])
@require_auth
def delete_measurement(measurement_id):
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT
            mv.id,
            mv.device_id,
            f.field_key,
            f.label,
            f.unit,
            mv.numeric_value,
            mv.created_at
        FROM measurement_values mv
        JOIN devices d ON d.id = mv.device_id
        JOIN device_fields f ON f.id = mv.field_id
        WHERE mv.id = %s AND d.owner_id = %s;
    """, (measurement_id, request.user_id))
    measurement = cur.fetchone()

    if measurement is None:
        cur.close()
        conn.close()
        return jsonify({"error": "Measurement not found"}), 404

    cur.execute(
        "DELETE FROM measurement_values WHERE id = %s;",
        (measurement_id,)
    )
    conn.commit()
    cur.close()
    conn.close()

    return jsonify({
        "message": "Measurement deleted",
        "measurement": make_json_safe(measurement)
    })


@app.route("/api/users", methods=["GET"])
@require_auth
@require_admin
def get_users():
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT
            u.id,
            u.username,
            u.is_admin,
            u.created_at,
            COUNT(DISTINCT d.id) AS device_count,
            COUNT(mv.id) AS measurement_count
        FROM users u
        LEFT JOIN devices d ON d.owner_id = u.id
        LEFT JOIN measurement_values mv ON mv.device_id = d.id
        GROUP BY u.id
        ORDER BY u.is_admin DESC, u.username ASC;
    """)
    users = cur.fetchall()

    cur.close()
    conn.close()

    return jsonify(make_json_safe(users))


@app.route("/api/users/<int:user_id>", methods=["DELETE"])
@require_auth
@require_admin
def delete_user(user_id):
    if user_id == request.user_id:
        return jsonify({"error": "Admin cannot delete the current account"}), 400

    conn = get_connection()
    cur = conn.cursor()

    cur.execute("""
        SELECT id, username, is_admin, created_at
        FROM users
        WHERE id = %s;
    """, (user_id,))
    user = cur.fetchone()

    if user is None:
        cur.close()
        conn.close()
        return jsonify({"error": "User not found"}), 404

    if user["is_admin"]:
        cur.execute("SELECT COUNT(*) AS admin_count FROM users WHERE is_admin = TRUE;")
        admin_count = cur.fetchone()["admin_count"]

        if admin_count <= 1:
            cur.close()
            conn.close()
            return jsonify({"error": "The last admin account cannot be deleted"}), 400

    cur.execute("DELETE FROM users WHERE id = %s;", (user_id,))
    conn.commit()
    cur.close()
    conn.close()

    return jsonify({
        "message": "User deleted",
        "user": make_json_safe(user)
    })


wait_for_database()
initialize_database()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
