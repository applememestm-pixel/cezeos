import { DatabaseSync } from 'node:sqlite';

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE,
      bio TEXT NOT NULL DEFAULT '', color TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, member TEXT NOT NULL REFERENCES profiles, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES profiles,
      name TEXT NOT NULL, bio TEXT NOT NULL, color TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS memberships (
      member TEXT REFERENCES profiles, group_id TEXT REFERENCES groups,
      status TEXT NOT NULL DEFAULT 'member', PRIMARY KEY (member, group_id)
    );
    CREATE TABLE IF NOT EXISTS follows (
      member TEXT REFERENCES profiles, target TEXT REFERENCES profiles, PRIMARY KEY (member, target)
    );
    CREATE TABLE IF NOT EXISTS friendships (
      requester TEXT REFERENCES profiles, recipient TEXT REFERENCES profiles,
      status TEXT NOT NULL, PRIMARY KEY (requester, recipient)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, author TEXT NOT NULL REFERENCES profiles, group_id TEXT REFERENCES groups,
      body TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', title TEXT NOT NULL DEFAULT '',
      credit TEXT NOT NULL DEFAULT '', work_type TEXT NOT NULL DEFAULT 'Оригинал',
      media_path TEXT, media_mime TEXT, visibility TEXT NOT NULL DEFAULT 'public',
      created INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reactions (
      member TEXT REFERENCES profiles, post TEXT REFERENCES posts ON DELETE CASCADE, PRIMARY KEY (member, post)
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      member TEXT NOT NULL REFERENCES profiles, post TEXT NOT NULL REFERENCES posts ON DELETE CASCADE,
      saved INTEGER NOT NULL, PRIMARY KEY (member,post)
    );
    CREATE INDEX IF NOT EXISTS bookmarks_member_time ON bookmarks (member,saved DESC);
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, post TEXT REFERENCES posts ON DELETE CASCADE,
      author TEXT REFERENCES profiles, body TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki (
      id TEXT NOT NULL, revision INTEGER NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
      body TEXT NOT NULL, author TEXT REFERENCES profiles, created INTEGER NOT NULL, PRIMARY KEY (id, revision)
    );
    CREATE INDEX IF NOT EXISTS posts_chronology ON posts (created DESC);
    CREATE INDEX IF NOT EXISTS comments_post ON comments (post, created);
  `);
  if (!db.prepare('SELECT 1 FROM profiles WHERE id = ?').get('liza')) seed(db);
  return db;
}

function seed(db) {
  db.exec('BEGIN');
  try {
    const profile = db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?)');
    profile.run('liza', 'Лиза Мороз', 'liza.moroz', 'Фотография и прогулки без маршрута.', 'blue');
    profile.run('misha', 'Миша Норд', 'nord', 'Пишу эмбиент и собираю полевые записи.', 'violet');
    profile.run('anya', 'Аня Ветрова', 'vetrova', 'Куратор «Тихого кадра».', 'amber');
    const group = db.prepare('INSERT INTO groups VALUES (?, ?, ?, ?, ?, ?)');
    group.run('quiet-frame', 'anya', 'Тихий кадр', 'Фотография, тишина и внимание к деталям.', 'blue', 0);
    group.run('low-frequency', 'misha', 'Низкая частота', 'Эмбиент, экспериментальная музыка и полевые записи.', 'violet', 0);
    group.run('archive', 'liza', 'Архив среды', 'Заметки о городе и визуальной культуре.', 'amber', 0);
    const member = db.prepare('INSERT INTO memberships (member, group_id) VALUES (?, ?)');
    member.run('anya', 'quiet-frame');
    member.run('liza', 'quiet-frame');
    member.run('misha', 'low-frequency');
    member.run('liza', 'archive');
    const now = Date.now();
    const post = db.prepare(`INSERT INTO posts (id, author, group_id, body, kind, title, credit, media_path, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    post.run('after-rain', 'liza', 'quiet-frame', 'После дождя город на несколько минут становится совсем другим.\nВчерашний кадр из серии «Тишина между домами».', 'photo', 'Тишина между домами', 'Лиза Мороз', '/assets/after-rain.png', now - 3600000);
    post.run('nord-track', 'misha', 'low-frequency', 'Собрал короткую зарисовку из полевых записей и синтезатора.', 'audio', 'Между станциями', 'Миша Норд', '/assets/between-stations.wav', now - 7200000);
    post.run('archive-note', 'anya', null, 'Какие небольшие независимые фотопроекты вы читаете? Собираю список для энциклопедии CeZeOs.', 'text', '', '', null, now - 10800000);
    db.prepare('INSERT INTO reactions VALUES (?, ?)').run('misha', 'after-rain');
    db.prepare('INSERT INTO reactions VALUES (?, ?)').run('anya', 'after-rain');
    db.prepare('INSERT INTO comments VALUES (?, ?, ?, ?, ?)').run('sample-comment', 'after-rain', 'anya', 'Свет в окнах очень живой.', now - 3000000);
    db.prepare('INSERT INTO wiki VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'cezeos', 1, 'CeZeOs', 'Сообщество',
      'CeZeOs объединяет людей, которые создают, публикуют и сохраняют произведения.\n\nСвобода искусства — свобода души.', 'anya', now - 86400000);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
