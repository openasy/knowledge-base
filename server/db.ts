import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- An article: its topic (a slug from the file), who may read it, and where it is between writing and the help center.
   -- It is live while published_at is set: readers see the published words of each language while a new draft waits.
   CREATE TABLE articles (
     id TEXT PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     topic TEXT,
     -- Plan ids from the file, as JSON; [] is everyone.
     plans TEXT NOT NULL DEFAULT '[]',
     state TEXT NOT NULL CHECK (state IN ('draft', 'review', 'published')),
     owner_id TEXT,
     owner_name TEXT NOT NULL,
     submitted_id TEXT,
     submitted_name TEXT,
     submitted_at TEXT,
     reviewed_id TEXT,
     reviewed_name TEXT,
     -- Why the reviewer sent it back.
     note TEXT,
     -- The search with no answer it was written for, as JSON { query, lang }.
     gap TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     published_at TEXT
   );
   CREATE INDEX articles_topic ON articles (topic);
   -- One language of an article: the words being written, and the ones readers see.
   CREATE TABLE translations (
     article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
     lang TEXT NOT NULL,
     title TEXT NOT NULL,
     format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
     source TEXT NOT NULL,
     html TEXT NOT NULL,
     pub_title TEXT,
     pub_html TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (article_id, lang)
   );
   -- The published words, folded (lowercase, no accents), for the search and the suggestions.
   CREATE VIRTUAL TABLE search_index USING fts5(article_id UNINDEXED, lang UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
   -- Article views a day, by the language shown and where the reader came from.
   CREATE TABLE views (
     article_id TEXT NOT NULL,
     lang TEXT NOT NULL,
     day TEXT NOT NULL,
     source TEXT NOT NULL,
     n INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (article_id, lang, day, source)
   ) WITHOUT ROWID;
   CREATE INDEX views_day ON views (day);
   -- "Did this help?" answers.
   CREATE TABLE votes (
     id INTEGER PRIMARY KEY,
     article_id TEXT NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
     lang TEXT NOT NULL,
     helpful INTEGER NOT NULL CHECK (helpful IN (0, 1)),
     at TEXT NOT NULL
   );
   CREATE INDEX votes_article ON votes (article_id, at);
   CREATE INDEX votes_at ON votes (at);
   -- A search in the help center, or what someone typed in a ticket form or chat window (its last words), how many
   -- articles it found, which one was opened, and whether a ticket was sent or the form closed after it.
   CREATE TABLE searches (
     id TEXT PRIMARY KEY,
     place TEXT NOT NULL,
     lang TEXT NOT NULL,
     query TEXT NOT NULL,
     results INTEGER NOT NULL,
     at TEXT NOT NULL,
     opened TEXT,
     outcome TEXT CHECK (outcome IN ('ticket', 'closed'))
   );
   CREATE INDEX searches_at ON searches (at);
   CREATE INDEX searches_gap ON searches (query, lang) WHERE results = 0;
   CREATE INDEX searches_opened ON searches (opened) WHERE opened IS NOT NULL;
   -- A search with no answer that is dealt with: an article was started for it, or it was set aside.
   CREATE TABLE gap_links (
     query TEXT NOT NULL,
     lang TEXT NOT NULL,
     article_id TEXT REFERENCES articles (id) ON DELETE CASCADE,
     dismissed_at TEXT,
     PRIMARY KEY (query, lang)
   ) WITHOUT ROWID;`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
