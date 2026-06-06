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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_image BYTEA;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime VARCHAR(50);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(200);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_wallpaper VARCHAR(50) DEFAULT 'default';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_data TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wallpaper_mime VARCHAR(50);

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
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_data TEXT;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS room_read_state (
        room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (room_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS profile_likes (
        liker_id UUID REFERENCES users(id) ON DELETE CASCADE,
        liked_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (liker_id, liked_user_id),
        CHECK (liker_id <> liked_user_id)
      );

      CREATE TABLE IF NOT EXISTS message_likes (
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_message_likes_message ON message_likes(message_id);
      CREATE INDEX IF NOT EXISTS idx_profile_likes_user ON profile_likes(liked_user_id);

      CREATE TABLE IF NOT EXISTS follows (
        follower_id UUID REFERENCES users(id) ON DELETE CASCADE,
        following_id UUID REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (follower_id, following_id),
        CHECK (follower_id <> following_id)
      );

      CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
      CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

      CREATE TABLE IF NOT EXISTS stars (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        content TEXT,
        image_data TEXT,
        image_mime VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
      );

      CREATE INDEX IF NOT EXISTS idx_stars_user_created ON stars(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_stars_expires ON stars(expires_at);

      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, endpoint)
      );

      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

      CREATE TABLE IF NOT EXISTS fcm_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        platform VARCHAR(20) DEFAULT 'android',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, token)
      );

      CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user ON fcm_tokens(user_id);
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
