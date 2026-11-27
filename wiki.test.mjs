// Wiki rights checked on the module itself (review of #3, 27.11): every test
// here failed before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { createWiki } from './wiki.mjs';

function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cezeos-wiki-'));
  const db = openStore(join(dir, 'w.sqlite'));
  const wiki = createWiki(db, {
    getGroup: id => db.prepare('SELECT * FROM groups WHERE id = ?').get(id),
    membership: (m, g) => db.prepare('SELECT status FROM memberships WHERE member = ? AND group_id = ?').get(m, g)?.status,
    profile: id => db.prepare('SELECT id, name FROM profiles WHERE id = ?').get(id),
    env,
  });
  let n = 0;
  const person = name => {
    const id = 'p' + (++n);
    db.prepare("INSERT INTO profiles (id, name, handle, color) VALUES (?, ?, ?, '#000')").run(id, name, 'h' + id);
    return id;
  };
  const group = (owner, closed = false) => {
    const id = 'g' + (++n);
    db.prepare("INSERT INTO groups (id, owner, name, bio, color, closed) VALUES (?, ?, 'G', '', '#000', ?)").run(id, owner, closed ? 1 : 0);
    db.prepare("INSERT INTO memberships (member, group_id, status) VALUES (?, ?, 'member')").run(owner, id);
    return id;
  };
  const join_ = (m, g) => db.prepare("INSERT OR IGNORE INTO memberships (member, group_id, status) VALUES (?, ?, 'member')").run(m, g);
  const leave = (m, g) => { db.prepare('DELETE FROM memberships WHERE member = ? AND group_id = ?').run(m, g); wiki.left(m, g); };
  const status = fn => { try { fn(); return 200; } catch (e) { if (!e.status) throw e; return e.status; } };
  return { db, wiki, person, group, join: join_, leave, status, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const text = (body, revision) => ({ title: 'Статья', body, revision });

test('a protected page is not changed by accepting a suggestion made before protection', () => {
  const t = setup();
  const owner = t.person('owner'), ed = t.person('editor'), m = t.person('member');
  const g = t.group(owner); t.join(ed, g); t.join(m, g);
  t.wiki.groupSettings(owner, g, { mode: 'suggest' });
  t.wiki.groupSettings(owner, g, { member: ed, role: 'editor', add: true });
  const { id } = t.wiki.create(owner, { title: 'Статья', body: 'v1', group: g });
  const { id: sid } = t.wiki.suggest(m, id, text('v2', 1));
  t.wiki.settings(owner, id, { protected: true });
  assert.equal(t.wiki.page(ed, id).rights.review, false);
  assert.equal(t.status(() => t.wiki.decide(ed, id, sid, true)), 403);
  assert.equal(t.wiki.page(owner, id).versions[0].body, 'v1');
  // A moderator still decides.
  t.wiki.decide(owner, id, sid, true);
  assert.equal(t.wiki.page(owner, id).versions[0].body, 'v2');
  t.done();
});

test('a suggestion of someone who left is not accepted, and their pending ones are withdrawn', () => {
  const t = setup();
  const owner = t.person('owner'), ed = t.person('editor'), m = t.person('member');
  const g = t.group(owner); t.join(ed, g); t.join(m, g);
  t.wiki.groupSettings(owner, g, { mode: 'suggest' });
  t.wiki.groupSettings(owner, g, { member: ed, role: 'editor', add: true });
  const { id } = t.wiki.create(owner, { title: 'Статья', body: 'v1', group: g });
  const { id: sid } = t.wiki.suggest(m, id, text('от ушедшего', 1));
  t.db.prepare('DELETE FROM memberships WHERE member = ? AND group_id = ?').run(m, g);
  // Even without the leave hook, accepting checks the author's rights now.
  assert.equal(t.status(() => t.wiki.decide(ed, id, sid, true)), 409);
  assert.equal(t.wiki.page(owner, id).versions.length, 1);
  t.join(m, g);
  const { id: sid2 } = t.wiki.suggest(m, id, text('ещё', 1));
  t.leave(m, g);
  assert.equal(t.status(() => t.wiki.decide(ed, id, sid2, true)), 404);
  assert.equal(t.wiki.page(owner, id).suggestions.length, 0);
  t.done();
});

test('leaving drops every wiki role; joining again does not bring it back', () => {
  const t = setup();
  const owner = t.person('owner'), mod = t.person('mod');
  const g = t.group(owner); t.join(mod, g);
  t.wiki.groupSettings(owner, g, { member: mod, role: 'moderator', add: true });
  t.wiki.groupSettings(owner, g, { member: mod, role: 'editor', add: true });
  const { id } = t.wiki.create(owner, { title: 'Статья', body: 'v1', group: g });
  t.db.prepare("INSERT INTO wiki_roles (scope, member, role) VALUES (?, ?, 'editor')").run('page:' + id, mod);
  t.leave(mod, g);
  t.join(mod, g);
  assert.equal(t.wiki.page(mod, id).rights.moderate, false);
  assert.equal(t.db.prepare('SELECT count(*) n FROM wiki_roles WHERE member = ?').get(mod).n, 0);
  t.done();
});

test('accepting a suggestion is one transaction: a failure leaves no revision behind', () => {
  const t = setup();
  const owner = t.person('owner'), m = t.person('member');
  const g = t.group(owner); t.join(m, g);
  t.wiki.groupSettings(owner, g, { mode: 'suggest' });
  const { id } = t.wiki.create(owner, { title: 'Статья', body: 'v1', group: g });
  const { id: sid } = t.wiki.suggest(m, id, text('v2', 1));
  // The log write fails after the revision is written.
  t.db.exec("CREATE TRIGGER no_log BEFORE INSERT ON wiki_log WHEN NEW.action = 'accept' BEGIN SELECT RAISE(ABORT, 'disk'); END");
  assert.throws(() => t.wiki.decide(owner, id, sid, true), /disk/);
  assert.equal(t.wiki.page(owner, id).versions.length, 1);
  assert.equal(t.db.prepare('SELECT status FROM wiki_suggestions WHERE id = ?').get(sid).status, 'pending');
  t.db.exec('DROP TRIGGER no_log');
  t.wiki.decide(owner, id, sid, true);
  assert.equal(t.wiki.page(owner, id).versions.length, 2);
  t.done();
});

test('a closed community\'s wiki settings and roles stay inside it', () => {
  const t = setup();
  const owner = t.person('owner'), out = t.person('outsider'), mod = t.person('mod');
  const g = t.group(owner, true); t.join(mod, g);
  t.wiki.groupSettings(owner, g, { member: mod, role: 'moderator', add: true });
  assert.equal(t.status(() => t.wiki.groupView(out, g)), 404);
  assert.equal(t.status(() => t.wiki.groupView(null, g)), 404);
  assert.equal(t.wiki.groupView(mod, g).roles.length, 1);
  // An open one shows its moderators to anyone, as before.
  const open = t.group(owner);
  assert.equal(t.wiki.groupView(out, open).group, open);
  t.done();
});

test('history comes in pages; any old version is reachable', () => {
  const t = setup();
  const owner = t.person('owner');
  const { id } = t.wiki.create(owner, { title: 'Статья', body: 'r1' });
  for (let r = 2; r <= 120; r++) t.wiki.edit(owner, id, text('r' + r, r - 1));
  const view = t.wiki.page(owner, id);
  assert.equal(view.versions.length, 50);
  assert.equal(view.versions[0].body, 'r120');
  assert.equal(view.more, true);
  const next = t.wiki.history(owner, id, { before: view.versions.at(-1).revision });
  assert.equal(next.versions[0].revision, 70);
  assert.equal(next.versions.length, 50);
  const last = t.wiki.history(owner, id, { before: 21 });
  assert.equal(last.versions.length, 20);
  assert.equal(last.more, false);
  assert.equal(t.wiki.version(owner, id, 3).body, 'r3');
  assert.equal(t.status(() => t.wiki.version(owner, id, 999)), 404);
  t.done();
});

test('the wiki does not grow without bound: revisions per page and pages', () => {
  const t = setup({ CEZEOS_WIKI_MAX_REVISIONS: '5', CEZEOS_WIKI_MAX_PAGES: '3' });
  const owner = t.person('owner');
  const { id } = t.wiki.create(owner, { title: 'Статья', body: 'r1' });
  for (let r = 2; r <= 5; r++) t.wiki.edit(owner, id, text('r' + r, r - 1));
  assert.equal(t.status(() => t.wiki.edit(owner, id, text('r6', 5))), 507);
  assert.equal(t.status(() => t.wiki.rollback(owner, id, { revision: 1, current: 5 })), 507);
  t.wiki.create(owner, { title: 'Б', body: 'x' });
  t.wiki.create(owner, { title: 'В', body: 'x' });
  assert.equal(t.status(() => t.wiki.create(owner, { title: 'Г', body: 'x' })), 507);
  t.done();
});

test('pages the reader cannot see do not push the ones they can out of the list', () => {
  const t = setup();
  const owner = t.person('owner'), reader = t.person('reader');
  const { id: visible } = t.wiki.create(owner, { title: 'Открытая', body: 'x' });
  const closed = t.group(owner, true);
  for (let i = 0; i < 210; i++) t.wiki.create(owner, { title: 'Закрытая ' + i, body: 'x', group: closed });
  const list = t.wiki.list(reader);
  assert.ok(list.some(x => x.id === visible));
  assert.ok(!list.some(x => x.group_id === closed));
  t.done();
});
