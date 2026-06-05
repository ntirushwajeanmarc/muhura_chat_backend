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
        surname VARCHAR(50),
        email VARCHAR(100) UNIQUE NOT NULL,
        phone VARCHAR(20),
        password_hash VARCHAR(255) NOT NULL,
        avatar_color VARCHAR(7) DEFAULT '#6366f1',
        avatar_url VARCHAR(500),
        bio VARCHAR(200),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS surname VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(500);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(200);

      CREATE TABLE IF NOT EXISTS rooms (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100),
        description VARCHAR(255),
        type VARCHAR(20) DEFAULT 'public',
        created_by UUID REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE rooms ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'public';
      ALTER TABLE rooms ALTER COLUMN name DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS room_members (
        room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (room_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url VARCHAR(500);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name VARCHAR(255);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_mime VARCHAR(100);

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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
      ON users (phone) WHERE phone IS NOT NULL AND phone <> ''
    `);

    await client.query(`UPDATE rooms SET type = 'public' WHERE type IS NULL`);

    await client.query(`DROP INDEX IF EXISTS idx_rooms_name_unique`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_public_name
      ON rooms (name) WHERE type = 'public' AND name IS NOT NULL
    `);

    // Seed default public rooms (partial unique index — no ON CONFLICT on name alone)
    const defaultRooms = [
      ['general', 'General discussion for everyone'],
      ['study-help', 'Ask questions and get help'],
      ['off-topic', 'Chat about anything'],
    ];
    for (const [name, description] of defaultRooms) {
      await client.query(
        `INSERT INTO rooms (name, description, type)
         SELECT $1, $2, 'public'
         WHERE NOT EXISTS (
           SELECT 1 FROM rooms WHERE name = $1 AND type = 'public'
         )`,
        [name, description]
      );
    }

    console.log('✅ Database initialized');
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };
