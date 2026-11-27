// Wiki of CeZeOs with rights per community and per page (owner, 26.11).
//
// Modes (on the community, a page may set its own):
//   open    — every member of the community edits (site-wide pages: everyone signed in);
//   trusted — only editors with the right (and moderators);
//   closed  — only the page's author and moderators;
//   suggest — members suggest changes, editors and moderators accept them.
// A protected page is edited by moderators only, whatever the mode.
// Moderators: the community's owner and the moderators it named; for
// site-wide pages the operator's list (CEZEOS_WIKI_MODERATORS).
// Every right is checked here, on the server. History keeps every revision;
// a rollback is a new revision with an old text; every action is logged.

import { randomUUID } from 'node:crypto';

export const MODES = ['open', 'trusted', 'closed', 'suggest'];

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

/// Lines of `a` and `b` as a list of {op: ' ' | '-' | '+', line} (LCS).
export function lineDiff(a, b) {
  const x = String(a).split('\n'), y = String(b).split('\n');
  // Large texts: compare only what differs between a common head and tail.
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail), ys = y.slice(head, y.length - tail);
  const n = xs.length, m = ys.length;
  const out = x.slice(0, head).map(line => ({ op: ' ', line }));
  if (n * m > 4_000_000) {
    // Too big to align line by line: all old out, all new in.
    out.push(...xs.map(line => ({ op: '-', line })), ...ys.map(line => ({ op: '+', line })));
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = xs[i] === ys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (xs[i] === ys[j]) { out.push({ op: ' ', line: xs[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', line: xs[i++] });
      else out.push({ op: '+', line: ys[j++] });
    }
    while (i < n) out.push({ op: '-', line: xs[i++] });
    while (j < m) out.push({ op: '+', line: ys[j++] });
  }
  out.push(...x.slice(x.length - tail).map(line => ({ op: ' ', line })));
  return out;
}

export function createWiki(db, { getGroup, membership, profile, env = process.env }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY, group_id TEXT REFERENCES groups, author TEXT REFERENCES profiles,
      mode TEXT, protected INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wiki_pages_group ON wiki_pages (group_id);
    CREATE TABLE IF NOT EXISTS wiki_settings (
      group_id TEXT PRIMARY KEY REFERENCES groups, mode TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki_roles (
      scope TEXT NOT NULL, member TEXT NOT NULL REFERENCES profiles, role TEXT NOT NULL,
      PRIMARY KEY (scope, member, role)
    );
    CREATE TABLE IF NOT EXISTS wiki_suggestions (
      id TEXT PRIMARY KEY, page TEXT NOT NULL, base INTEGER NOT NULL, title TEXT NOT NULL,
      category TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL REFERENCES profiles,
      status TEXT NOT NULL, created INTEGER NOT NULL, decided_by TEXT, decided INTEGER, revision INTEGER
    );
    CREATE INDEX IF NOT EXISTS wiki_suggestions_page ON wiki_suggestions (page, status);
    CREATE TABLE IF NOT EXISTS wiki_log (
      seq INTEGER PRIMARY KEY, page TEXT, group_id TEXT, actor TEXT NOT NULL,
      action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wiki_log_page ON wiki_log (page, seq);
  `);
  // Migration: every article from before gets its page row — site-wide (no
  // community), the author of its first revision, mode open as before.
  db.exec(`INSERT OR IGNORE INTO wiki_pages (id, group_id, author, mode, protected, created)
    SELECT w.id, NULL, w.author, NULL, 0, w.created FROM wiki w WHERE w.revision =
      (SELECT MIN(revision) FROM wiki WHERE id = w.id)`);

  // A role in a community lasts while its holder is a member: roles of
  // people who left before this rule are dropped once (review of #3).
  db.exec(`DELETE FROM wiki_roles WHERE scope LIKE 'group:%' AND NOT EXISTS (SELECT 1 FROM memberships m
      WHERE m.member = wiki_roles.member AND m.group_id = substr(wiki_roles.scope, 7) AND m.status = 'member');
    DELETE FROM wiki_roles WHERE scope LIKE 'page:%' AND EXISTS (SELECT 1 FROM wiki_pages p
      WHERE p.id = substr(wiki_roles.scope, 6) AND p.group_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memberships m
        WHERE m.member = wiki_roles.member AND m.group_id = p.group_id AND m.status = 'member'))`);

  // The wiki does not grow without bound (review of #3).
  const limit = (name, fallback) => Math.max(1, Number.parseInt(env[name], 10) || fallback);
  const maxRevisions = limit('CEZEOS_WIKI_MAX_REVISIONS', 2000);
  const maxPages = limit('CEZEOS_WIKI_MAX_PAGES', 50000);
  const PAGE_SIZE = 50;

  // Every change — revision, suggestion status, log — is written whole or not
  // at all, inside the server's transaction or on its own.
  let depth = 0;
  function atomic(action) {
    const name = 'wiki_' + (++depth);
    db.exec('SAVEPOINT ' + name);
    try {
      const result = action();
      db.exec('RELEASE ' + name);
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO ' + name);
      db.exec('RELEASE ' + name);
      throw error;
    } finally { depth--; }
  }

  const siteModerators = new Set((env.CEZEOS_WIKI_MODERATORS || '').split(',').map(s => s.trim()).filter(Boolean));
  const scopeOf = group => group ? 'group:' + group : 'site';
  const hasRole = (scope, member, role) => Boolean(member && db.prepare(
    'SELECT 1 FROM wiki_roles WHERE scope = ? AND member = ? AND role = ?').get(scope, member, role));
  const log = (page, group, actor, action, detail = '') => db.prepare(
    'INSERT INTO wiki_log (page, group_id, actor, action, detail, created) VALUES (?, ?, ?, ?, ?, ?)')
    .run(page, group, actor, action, String(detail).slice(0, 300), Date.now());

  function pageRow(id) { return db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id); }
  function latest(id) { return db.prepare('SELECT * FROM wiki WHERE id = ? ORDER BY revision DESC LIMIT 1').get(id); }
  function groupMode(group) {
    return (group && db.prepare('SELECT mode FROM wiki_settings WHERE group_id = ?').get(group)?.mode) || 'open';
  }

  /// Who is `member` for pages of `group` (null: site-wide)?
  function standing(member, group) {
    const g = group ? getGroup(group) : null;
    const inCommunity = Boolean(member) && (group ? membership(member, group) === 'member' : true);
    // A role given in a community lasts only while its holder is a member:
    // someone who left keeps no right there (review: they could still edit
    // as a moderator or accept suggestions as an editor).
    const moderator = Boolean(member) && (group
      ? (g?.owner === member || (inCommunity && hasRole(scopeOf(group), member, 'moderator')))
      : siteModerators.has(member));
    return { g, moderator, inCommunity };
  }

  /// Rights of `member` on page row `p` (or, for a new page, `{group_id}`).
  function rights(member, p) {
    const group = p.group_id || null;
    const { g, moderator, inCommunity } = standing(member, group);
    const readable = !g?.closed || inCommunity || moderator;
    const mode = p.mode || groupMode(group);
    const editor = moderator || (inCommunity && (hasRole(scopeOf(group), member, 'editor') || Boolean(p.id && hasRole('page:' + p.id, member, 'editor'))));
    const author = Boolean(member) && p.author === member;
    let edit = false, suggest = false;
    if (member && readable && inCommunity) {
      if (p.protected) edit = moderator;
      else if (mode === 'open') edit = true;
      else if (mode === 'trusted') edit = editor;
      else if (mode === 'closed') edit = moderator || author;
      else if (mode === 'suggest') { edit = editor; suggest = !editor; }
    } else if (member && moderator) edit = true;
    return {
      read: readable, edit, suggest: suggest && !p.protected,
      // Accepting a suggestion changes the page: on a protected page only a
      // moderator does it (review: an editor accepted into a protected page).
      review: Boolean(member) && readable && (moderator || (editor && mode === 'suggest' && !p.protected)),
      moderate: moderator, mode, inherited: !p.mode,
    };
  }

  function needPage(id, member) {
    const p = pageRow(id);
    if (!p) fail(404, 'Статья не найдена.');
    const r = rights(member, p);
    if (!r.read) fail(404, 'Статья не найдена.');
    return { p, r };
  }

  function clean(value, limit) { return typeof value === 'string' ? value.trim().slice(0, limit) : ''; }
  function content(input) {
    const title = clean(input.title, 120), body = clean(input.body, 12000);
    const category = clean(input.category, 60) || 'Без категории';
    if (!title || !body) fail(400, 'Укажите название и текст статьи.');
    return { title, body, category };
  }
  function write(id, c, member) {
    const last = latest(id);
    const next = (last?.revision || 0) + 1;
    if (next > maxRevisions) fail(507, 'У статьи слишком много версий. Создайте новую статью.');
    db.prepare('INSERT INTO wiki VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, next, c.title, c.category, c.body, member, Date.now());
    return next;
  }
  function memberOrFail(member) { if (!member) fail(401, 'Войдите, чтобы выполнить это действие.'); return member; }

  const api = {
    rights,
    /// Latest revisions the reader may see (of one community, or all).
    list(member, group) {
      // What the reader may see is chosen in the query: pages of closed
      // communities no longer push readable ones out of a fixed window.
      const rows = db.prepare(`SELECT w.*, p.group_id, p.mode, p.protected, p.author page_author FROM wiki w
        JOIN wiki_pages p ON p.id = w.id LEFT JOIN groups g ON g.id = p.group_id
        WHERE w.revision = (SELECT MAX(revision) FROM wiki WHERE id = w.id) AND (? IS NULL OR p.group_id = ?)
          AND (p.group_id IS NULL OR g.closed = 0 OR g.owner = ? OR EXISTS (SELECT 1 FROM memberships m
            WHERE m.group_id = p.group_id AND m.member = ? AND m.status = 'member'))
        ORDER BY w.created DESC LIMIT 60`).all(group || null, group || null, member || '', member || '');
      return rows.filter(row => rights(member, { ...row, author: row.page_author }).read)
        .map(({ page_author, ...row }) => row);
    },
    /// A page: its revisions, settings and what the reader may do.
    page(member, id) {
      const { p, r } = needPage(id, member);
      const { versions, more } = this.history(member, id, {});
      const pending = r.review || member ? db.prepare(`SELECT id, base, title, author, created FROM wiki_suggestions
        WHERE page = ? AND status = 'pending' AND (? OR author = ?) ORDER BY created`).all(id, r.review ? 1 : 0, member || '')
        .map(s => ({ ...s, profile: profile(s.author) })) : [];
      return { page: { id: p.id, group: p.group_id, author: p.author, mode: p.mode, protected: Boolean(p.protected) }, rights: r, versions, more, suggestions: pending };
    },
    /// Revisions newest first, PAGE_SIZE at a time, older than `before`.
    history(member, id, { before } = {}) {
      needPage(id, member);
      const upTo = Number.isInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER;
      const rows = db.prepare('SELECT * FROM wiki WHERE id = ? AND revision < ? ORDER BY revision DESC LIMIT ?')
        .all(id, upTo, PAGE_SIZE + 1);
      return { versions: rows.slice(0, PAGE_SIZE).map(item => ({ ...item, profile: profile(item.author) })), more: rows.length > PAGE_SIZE };
    },
    version(member, id, revision) {
      needPage(id, member);
      const v = db.prepare('SELECT * FROM wiki WHERE id = ? AND revision = ?').get(id, revision);
      if (!v) fail(404, 'Версия не найдена.');
      return { ...v, profile: profile(v.author), latest: latest(id).revision };
    },
    /// `member` left `group` (or was removed): their roles there end, and
    /// suggestions still waiting are withdrawn — joining again starts afresh.
    left(member, group) {
      if (!member || !group) return;
      atomic(() => {
        db.prepare(`DELETE FROM wiki_roles WHERE member = ? AND (scope = ? OR scope IN
          (SELECT 'page:' || id FROM wiki_pages WHERE group_id = ?))`).run(member, scopeOf(group), group);
        db.prepare(`UPDATE wiki_suggestions SET status = 'withdrawn', decided = ? WHERE author = ? AND status = 'pending'
          AND page IN (SELECT id FROM wiki_pages WHERE group_id = ?)`).run(Date.now(), member, group);
        log(null, group, member, 'left');
      });
    },
    create(member, input) {
      memberOrFail(member);
      const group = typeof input.group === 'string' && input.group ? input.group : null;
      if (group && !getGroup(group)) fail(404, 'Сообщество не найдено.');
      const r = rights(member, { id: null, group_id: group, author: member, mode: null, protected: 0 });
      // A new page in "closed": the author's own page; "trusted" and
      // "suggest": editors and moderators make pages.
      const mayCreate = r.read && (r.moderate || (standing(member, group).inCommunity && (r.mode === 'open' || r.mode === 'closed' || r.edit)));
      if (!mayCreate) fail(403, 'В этом сообществе статьи создают редакторы и модераторы.');
      const c = content(input);
      if (db.prepare('SELECT count(*) n FROM wiki_pages').get().n >= maxPages) fail(507, 'В вики слишком много статей.');
      const id = randomUUID();
      db.prepare('INSERT INTO wiki_pages (id, group_id, author, mode, protected, created) VALUES (?, ?, ?, NULL, 0, ?)').run(id, group, member, Date.now());
      const revision = write(id, c, member);
      log(id, group, member, 'create', c.title);
      return { id, revision };
    },
    edit(member, id, input) {
      memberOrFail(member);
      const { p, r } = needPage(id, member);
      if (!r.edit) fail(403, r.suggest ? 'Здесь правки предлагаются: отправьте предложение.' : 'Нет прав на правку этой статьи.');
      const last = latest(id);
      if (input.revision !== last.revision) fail(409, 'Статья обновилась. Откройте её заново.');
      const c = content(input);
      const revision = write(id, c, member);
      log(id, p.group_id, member, 'edit', 'r' + revision);
      return { id, revision };
    },
    suggest(member, id, input) {
      memberOrFail(member);
      const { p, r } = needPage(id, member);
      if (!r.suggest && !r.edit) fail(403, 'Нет прав предлагать правки этой статьи.');
      const last = latest(id);
      if (input.revision !== last.revision) fail(409, 'Статья обновилась. Откройте её заново.');
      if (db.prepare("SELECT count(*) n FROM wiki_suggestions WHERE page = ? AND author = ? AND status = 'pending'").get(id, member).n >= 3) {
        fail(429, 'У вас уже есть предложения к этой статье — дождитесь решения.');
      }
      const c = content(input);
      const sid = randomUUID();
      db.prepare(`INSERT INTO wiki_suggestions (id, page, base, title, category, body, author, status, created)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(sid, id, last.revision, c.title, c.category, c.body, member, Date.now());
      log(id, p.group_id, member, 'suggest', sid);
      return { id: sid };
    },
    suggestion(member, id, sid) {
      const { r } = needPage(id, member);
      const s = db.prepare('SELECT * FROM wiki_suggestions WHERE id = ? AND page = ?').get(sid, id);
      if (!s || (!r.review && s.author !== member)) fail(404, 'Предложение не найдено.');
      const base = db.prepare('SELECT * FROM wiki WHERE id = ? AND revision = ?').get(id, s.base);
      return { ...s, profile: profile(s.author), diff: lineDiff(base?.body || '', s.body) };
    },
    decide(member, id, sid, accept) {
      memberOrFail(member);
      const { p, r } = needPage(id, member);
      if (!r.review) fail(403, 'Предложения принимают редакторы и модераторы.');
      const s = db.prepare("SELECT * FROM wiki_suggestions WHERE id = ? AND page = ? AND status = 'pending'").get(sid, id);
      if (!s) fail(404, 'Предложение не найдено или уже решено.');
      if (s.author === member && !r.moderate) fail(403, 'Своё предложение принимает другой редактор.');
      let revision = null;
      if (accept) {
        // Made against an older text: the editor looks again (no silent overwrite).
        if (s.base !== latest(id).revision) fail(409, 'Статья изменилась после предложения. Сравните и предложите заново.');
        // Its author must still be able to take part (review: suggestions of
        // people who left were accepted under their name).
        if (!standing(s.author, p.group_id || null).inCommunity) fail(409, 'Автор предложения больше не участник сообщества.');
        revision = write(id, s, s.author);
      }
      db.prepare('UPDATE wiki_suggestions SET status = ?, decided_by = ?, decided = ?, revision = ? WHERE id = ?')
        .run(accept ? 'accepted' : 'rejected', member, Date.now(), revision, sid);
      log(id, p.group_id, member, accept ? 'accept' : 'reject', sid + (revision ? ' r' + revision : ''));
      return { id, revision };
    },
    diff(member, id, from, to) {
      needPage(id, member);
      const a = db.prepare('SELECT * FROM wiki WHERE id = ? AND revision = ?').get(id, from);
      const b = db.prepare('SELECT * FROM wiki WHERE id = ? AND revision = ?').get(id, to);
      if (!a || !b) fail(404, 'Версия не найдена.');
      return { from: a.revision, to: b.revision, title: [a.title, b.title], diff: lineDiff(a.body, b.body) };
    },
    rollback(member, id, input) {
      memberOrFail(member);
      const { p, r } = needPage(id, member);
      if (!r.edit) fail(403, 'Нет прав на правку этой статьи.');
      const last = latest(id);
      if (input.current !== last.revision) fail(409, 'Статья обновилась. Откройте её заново.');
      const old = db.prepare('SELECT * FROM wiki WHERE id = ? AND revision = ?').get(id, input.revision);
      if (!old || old.revision === last.revision) fail(400, 'Выберите прежнюю версию.');
      const revision = write(id, old, member);
      log(id, p.group_id, member, 'rollback', 'r' + old.revision + ' → r' + revision);
      return { id, revision };
    },
    settings(member, id, input) {
      memberOrFail(member);
      const { p, r } = needPage(id, member);
      if (!r.moderate) fail(403, 'Настройки статьи меняют модераторы.');
      if ('mode' in input) {
        if (input.mode !== null && !MODES.includes(input.mode)) fail(400, 'Неизвестный режим.');
        db.prepare('UPDATE wiki_pages SET mode = ? WHERE id = ?').run(input.mode, id);
        log(id, p.group_id, member, 'mode', input.mode ?? 'inherit');
      }
      if ('protected' in input) {
        db.prepare('UPDATE wiki_pages SET protected = ? WHERE id = ?').run(input.protected ? 1 : 0, id);
        log(id, p.group_id, member, input.protected ? 'protect' : 'unprotect');
      }
      return this.page(member, id);
    },
    /// Community settings: its mode, and who are editors / moderators.
    groupSettings(member, group, input) {
      memberOrFail(member);
      const g = getGroup(group);
      if (!g) fail(404, 'Сообщество не найдено.');
      const { moderator } = standing(member, group);
      if (!moderator) fail(403, 'Настройки вики меняют модераторы сообщества.');
      if ('mode' in input) {
        if (!MODES.includes(input.mode)) fail(400, 'Неизвестный режим.');
        db.prepare('INSERT INTO wiki_settings (group_id, mode) VALUES (?, ?) ON CONFLICT(group_id) DO UPDATE SET mode = excluded.mode').run(group, input.mode);
        log(null, group, member, 'group-mode', input.mode);
      }
      if (typeof input.member === 'string' && ['editor', 'moderator'].includes(input.role)) {
        // Moderators are named by the owner only.
        if (input.role === 'moderator' && g.owner !== member) fail(403, 'Модераторов назначает владелец сообщества.');
        // By ID or by @handle.
        const named = input.member.trim().replace(/^@/, '');
        const who = db.prepare('SELECT id FROM profiles WHERE id = ? OR handle = ?').get(named, named)?.id;
        if (!who) fail(404, 'Участник не найден.');
        if (input.add && membership(who, group) !== 'member') fail(400, 'Права даются участникам сообщества.');
        if (input.add) db.prepare('INSERT OR IGNORE INTO wiki_roles (scope, member, role) VALUES (?, ?, ?)').run(scopeOf(group), who, input.role);
        else db.prepare('DELETE FROM wiki_roles WHERE scope = ? AND member = ? AND role = ?').run(scopeOf(group), who, input.role);
        log(null, group, member, (input.add ? 'grant-' : 'revoke-') + input.role, who);
      }
      return this.groupView(member, group);
    },
    groupView(member, group) {
      const g = getGroup(group);
      if (!g) fail(404, 'Сообщество не найдено.');
      const { moderator, inCommunity } = standing(member, group);
      // A closed community shows nothing of itself to outsiders.
      if (g.closed && !inCommunity && !moderator) fail(404, 'Сообщество не найдено.');
      const roles = db.prepare('SELECT member, role FROM wiki_roles WHERE scope = ? ORDER BY role, member').all(scopeOf(group))
        .map(x => ({ ...x, profile: profile(x.member) }));
      return { group, mode: groupMode(group), moderator, member: inCommunity, roles: moderator ? roles : roles.filter(x => x.role === 'moderator') };
    },
    log(member, id) {
      needPage(id, member);
      return db.prepare('SELECT seq, actor, action, detail, created FROM wiki_log WHERE page = ? ORDER BY seq DESC LIMIT 200').all(id)
        .map(x => ({ ...x, profile: profile(x.actor) }));
    },
    groupLog(member, group) {
      const { moderator } = standing(member, group);
      if (!moderator) fail(403, 'Журнал вики сообщества видят модераторы.');
      return db.prepare('SELECT seq, page, actor, action, detail, created FROM wiki_log WHERE group_id = ? ORDER BY seq DESC LIMIT 300').all(group)
        .map(x => ({ ...x, profile: profile(x.actor) }));
    },
  };
  for (const name of ['create', 'edit', 'suggest', 'decide', 'rollback', 'settings', 'groupSettings']) {
    const action = api[name];
    api[name] = (...args) => atomic(() => action.apply(api, args));
  }
  return api;
}
