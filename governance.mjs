import { randomUUID } from 'node:crypto';

function fail(status,message) { throw Object.assign(new Error(message),{status}); }
export function aquaNickname(value) {
  return typeof value==='string' ? value.trim().replace(/^@/,'').toLowerCase() : '';
}
export function validAquaNickname(value) { return /^[a-z0-9_.]{3,32}$/.test(value); }

export function createGovernance(db, issuer) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS triumvirate_roster (
      nickname TEXT PRIMARY KEY, issuer TEXT, subject TEXT, UNIQUE(issuer,subject)
    );
    CREATE TABLE IF NOT EXISTS synclit_members (
      member TEXT PRIMARY KEY REFERENCES profiles, joined INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS synclit_applications (
      id TEXT PRIMARY KEY, member TEXT NOT NULL REFERENCES profiles,
      body TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS synclit_one_pending ON synclit_applications(member) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS synclit_cases (
      id TEXT PRIMARY KEY, author TEXT NOT NULL REFERENCES profiles,
      title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS synclit_ballots (
      kind TEXT NOT NULL, target TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL,
      approve INTEGER NOT NULL, PRIMARY KEY(kind,target,issuer,subject)
    );
    CREATE TABLE IF NOT EXISTS governance_audit (
      seq INTEGER PRIMARY KEY, actor TEXT NOT NULL REFERENCES profiles,
      kind TEXT NOT NULL, subject TEXT NOT NULL, created INTEGER NOT NULL
    );
  `);
  const audit=(actor,kind,target)=>db.prepare(
    'INSERT INTO governance_audit (actor,kind,subject,created) VALUES (?,?,?,?)').run(actor,kind,target,Date.now());
  const seat=member=>member && issuer ? db.prepare(`SELECT r.issuer,r.subject FROM triumvirate_roster r
    JOIN aquamarine_links a ON a.issuer=r.issuer AND a.subject=r.subject WHERE a.member=? AND r.issuer=?`).get(member,issuer) : null;
  const inSynclit=member=>Boolean(member && db.prepare('SELECT 1 FROM synclit_members WHERE member=?').get(member));
  const counts=(kind,id)=>db.prepare(`SELECT
    COALESCE(SUM(b.approve=1),0) yes, COALESCE(SUM(b.approve=0),0) no
    FROM synclit_ballots b JOIN triumvirate_roster r ON r.issuer=b.issuer AND r.subject=b.subject
    WHERE b.kind=? AND b.target=?`).get(kind,id);
  const annotate=(kind,target,identity)=>{
    const count=counts(kind,target.id);
    const voted=Boolean(identity && db.prepare(`SELECT 1 FROM synclit_ballots
      WHERE kind=? AND target=? AND issuer=? AND subject=?`).get(kind,target.id,identity.issuer,identity.subject));
    return {...target,for:count.yes,against:count.no,voted};
  };
  const roster=()=>db.prepare(`SELECT nickname,subject IS NOT NULL AS verified
    FROM triumvirate_roster ORDER BY rowid`).all().map(row=>({...row,verified:Boolean(row.verified)}));
  const publicSummary=()=>({triumvirs:roster(),members:db.prepare('SELECT COUNT(*) n FROM synclit_members').get().n});

  function vote(member,kind,id,approve) {
    const identity=seat(member);
    if (!identity) fail(403,'В голосовании участвуют подтверждённые триумвиры.');
    if (typeof approve!=='boolean') fail(400,'Требуется голос за или против.');
    const application=kind==='application';
    const table=application?'synclit_applications':'synclit_cases';
    const target=db.prepare('SELECT * FROM '+table+' WHERE id=?').get(id);
    if (!target) fail(404,'Запись не найдена.');
    if ((application?target.member:target.author)===member) fail(403,'Голосовать по своей записи нельзя.');
    const existing=db.prepare(`SELECT approve FROM synclit_ballots WHERE kind=? AND target=? AND issuer=? AND subject=?`)
      .get(kind,id,identity.issuer,identity.subject);
    if (existing?.approve===Number(approve)) return {id,status:target.status};
    if (existing || target.status!=='pending') fail(409,'Этот голос уже зафиксирован или рассмотрение завершено.');
    db.prepare('INSERT INTO synclit_ballots VALUES (?,?,?,?,?)').run(kind,id,identity.issuer,identity.subject,Number(approve));
    audit(member,kind+(approve?'-vote-yes':'-vote-no'),id);
    const result=counts(kind,id);
    const status=result.yes>=2?'approved':result.no>=2?'rejected':'pending';
    if (status!=='pending') {
      db.prepare('UPDATE '+table+' SET status=? WHERE id=?').run(status,id);
      if (application && status==='approved') db.prepare('INSERT OR IGNORE INTO synclit_members VALUES (?,?)').run(target.member,Date.now());
      audit(member,kind+'-'+status,id);
    }
    return {id,status};
  }

  return {
    publicSummary,
    setRoster(values) {
      const names=values.map(aquaNickname);
      if (!names.length || names.length>3 || names.some(name=>!validAquaNickname(name)) || new Set(names).size!==names.length) {
        fail(400,'Укажите от одного до трёх разных @ников Aquamarine.');
      }
      for (const {nickname} of roster()) {
        if (!names.includes(nickname)) db.prepare('DELETE FROM triumvirate_roster WHERE nickname=?').run(nickname);
      }
      const insert=db.prepare('INSERT OR IGNORE INTO triumvirate_roster (nickname) VALUES (?)');
      for (const nickname of names) insert.run(nickname);
      return roster();
    },
    claim(linkIssuer,subject,nickname) {
      if (!issuer || issuer!==linkIssuer || !nickname) return;
      db.prepare(`UPDATE triumvirate_roster SET issuer=?,subject=? WHERE nickname=? AND subject IS NULL
        AND NOT EXISTS (SELECT 1 FROM triumvirate_roster WHERE issuer=? AND subject=?)`)
        .run(issuer,subject,nickname,issuer,subject);
    },
    summary(member) {
      const identity=seat(member);
      const joined=inSynclit(member);
      const own=member ? db.prepare('SELECT id,status,created FROM synclit_applications WHERE member=? ORDER BY rowid DESC LIMIT 1').get(member) : null;
      const applications=identity ? db.prepare(`SELECT a.id,a.body,a.status,a.created,p.name,p.handle
        FROM synclit_applications a JOIN profiles p ON p.id=a.member WHERE a.status='pending' ORDER BY a.created LIMIT 100`).all()
        .map(item=>annotate('application',item,identity)) : [];
      const cases=identity || joined ? db.prepare('SELECT * FROM synclit_cases ORDER BY created DESC LIMIT 100').all()
        .map(item=>annotate('case',item,identity)) : [];
      return {...publicSummary(),roles:{triumvir:Boolean(identity),synclit:joined},application:own || null,applications,cases};
    },
    apply(member,body) {
      if (inSynclit(member) || seat(member)) fail(409,'Заявка для вашего аккаунта не требуется.');
      if (!body) fail(400,'Расскажите, чем хотите помочь Синклиту.');
      if (db.prepare("SELECT 1 FROM synclit_applications WHERE member=? AND status='pending'").get(member)) {
        fail(409,'У вас уже есть заявка на рассмотрении.');
      }
      const id=randomUUID();
      db.prepare("INSERT INTO synclit_applications VALUES (?,?,?,'pending',?)").run(id,member,body,Date.now());
      audit(member,'application-submitted',id);
      return {id,status:'pending'};
    },
    withdraw(member,id) {
      const change=db.prepare("UPDATE synclit_applications SET status='withdrawn' WHERE id=? AND member=? AND status='pending'").run(id,member);
      if (!change.changes) fail(409,'Заявка уже закрыта или недоступна.');
      audit(member,'application-withdrawn',id);
      return {id,status:'withdrawn'};
    },
    propose(member,title,body) {
      if (!inSynclit(member)) fail(403,'Внести дело вправе участник Синклита.');
      if (!title || !body) fail(400,'Добавьте заголовок и описание дела.');
      const id=randomUUID();
      db.prepare("INSERT INTO synclit_cases VALUES (?,?,?,?,'pending',?)").run(id,member,title,body,Date.now());
      audit(member,'case-submitted',id);
      return {id};
    },
    vote
  };
}
