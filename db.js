const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        avatar_color VARCHAR(7) DEFAULT '#6366f1',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        description VARCHAR(255),
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);
    `);

    // Merge duplicate rooms (keeps oldest per name, moves messages to kept room)
    await client.query(`
      WITH keepers AS (
        SELECT DISTINCT ON (name) id AS keep_id, name
        FROM rooms
        ORDER BY name, created_at ASC
      ),
      dupes AS (
        SELECT r.id AS dupe_id, k.keep_id
        FROM rooms r
        JOIN keepers k ON r.name = k.name AND r.id <> k.keep_id
      )
      UPDATE messages m
      SET room_id = d.keep_id
      FROM dupes d
      WHERE m.room_id = d.dupe_id
    `);
    await client.query(`
      DELETE FROM rooms r
      USING (
        SELECT DISTINCT ON (name) id AS keep_id, name
        FROM rooms
        ORDER BY name, created_at ASC
      ) k
      WHERE r.name = k.name AND r.id <> k.keep_id
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_name_unique ON rooms (name)
    `);

    // Seed default rooms (safe after unique index)
    await client.query(`
      INSERT INTO rooms (name, description) VALUES
        ('general', 'General discussion for everyone'),
        ('study-help', 'Ask questions and get help'),
        ('off-topic', 'Chat about anything')
      ON CONFLICT (name) DO NOTHING
    `);

    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };
