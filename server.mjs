import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(root,'data'),{recursive:true});
const db=new DatabaseSync(process.env.DB_PATH||path.join(root,'data','schedule.sqlite'));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT,email TEXT UNIQUE,password TEXT,role TEXT,active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER);
CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,name TEXT,kind TEXT,identifier TEXT,available INTEGER,active INTEGER);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,series TEXT,title TEXT,category TEXT,start TEXT,end TEXT,place TEXT,description TEXT,participants TEXT,companions TEXT,resources TEXT,version INTEGER DEFAULT 1,created_by TEXT,created_at TEXT,updated_by TEXT,updated_at TEXT);
CREATE TABLE IF NOT EXISTS changes(id INTEGER PRIMARY KEY,event_id TEXT,title TEXT,actor TEXT,type TEXT,time TEXT);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,user_id TEXT,title TEXT,body TEXT,read INTEGER DEFAULT 0,dedupe TEXT UNIQUE,time TEXT);
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER,reset INTEGER);`);
const q=(sql,...args)=>db.prepare(sql).all(...args);
const one=(sql,...args)=>db.prepare(sql).get(...args);
const run=(sql,...args)=>db.prepare(sql).run(...args);
const id=()=>randomBytes(16).toString('hex');
const now=()=>new Date().toISOString();
const hash=p=>{const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(p,salt,64).toString('hex')}`;};
const verify=(p,h)=>{const [s,v]=h.split(':');return timingSafeEqual(scryptSync(p,s,64),Buffer.from(v,'hex'));};
const safeUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,active:!!u.active});
// Local preview defaults to passwordless access; enable authentication for deployment.
const authRequired=process.env.AUTH_REQUIRED==='1';
if(!authRequired&&!one('SELECT id FROM users WHERE id=?','local-preview')){
 run('INSERT INTO users VALUES(?,?,?,?,?,1)','local-preview','로컬 관리자','local-preview@localhost.invalid',hash(id()),'admin');
}
if(!authRequired)run('UPDATE users SET name=? WHERE id=?','공용 사용자','local-preview');
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
function notify(event,type,actor){const time=now();run('INSERT INTO changes(event_id,title,actor,type,time) VALUES(?,?,?,?,?)',event.id,event.title,actor.name,type,time);for(const u of q('SELECT id FROM users WHERE active=1'))run('INSERT INTO notifications(user_id,title,body,time) VALUES(?,?,?,?)',u.id,`${event.title} · ${type}`,`${actor.name} · ${event.start}`,time);}
function parsed(e){return {...e,participants:JSON.parse(e.participants),companions:JSON.parse(e.companions),resources:JSON.parse(e.resources)};}
function validate(b){
 if(!b.title?.trim()||b.title.length>200)fail('제목은 1~200자로 입력하세요.');
 if(!['행사·회의','교육·연수','휴가·개인'].includes(b.category))fail('분류를 선택하세요.');
 if(!Number.isFinite(Date.parse(b.start))||!Number.isFinite(Date.parse(b.end))||Date.parse(b.start)>=Date.parse(b.end))fail('종료는 시작보다 늦어야 합니다.');
 b.start=new Date(b.start).toISOString();b.end=new Date(b.end).toISOString();
 for(const key of ['participants','companions','resources'])if(!Array.isArray(b[key])||new Set(b[key]).size!==b[key].length)fail('선택 목록이 올바르지 않습니다.');
 if(!b.participants.length)fail('담당자를 선택하세요.');
 if(b.participants.some(x=>b.companions.includes(x)))fail('담당자와 동행자는 중복될 수 없습니다.');
 for(const uid of [...b.participants,...b.companions])if(!one('SELECT id FROM users WHERE id=?',uid))fail('존재하지 않는 직원입니다.');
 for(const rid of b.resources)if(!one('SELECT id FROM resources WHERE id=?',rid))fail('존재하지 않는 자원입니다.');
}
export function occurrences(b){
 if(!b.repeat||b.repeat==='none')return [{...b}];
 if(!['weekly','monthly-date','monthly-weekday'].includes(b.repeat)||!/^\d{4}-\d{2}-\d{2}$/.test(b.until||''))fail('반복 규칙과 종료일을 확인하세요.');
 const base=new Date(Date.parse(b.start)+9*3600000), duration=Date.parse(b.end)-Date.parse(b.start),out=[];
 const last=new Date(`${b.until}T23:59:59+09:00`).getTime();
 if(last<Date.parse(b.start)||last-Date.parse(b.start)>366*2*86400000)fail('반복 종료일은 시작일부터 2년 이내로 지정하세요.');
 for(let n=0;n<750;n++){
  const d=new Date(base);
  if(b.repeat==='weekly')d.setUTCDate(base.getUTCDate()+7*n);
  else{d.setUTCDate(1);d.setUTCMonth(base.getUTCMonth()+n);const month=d.getUTCMonth();if(b.repeat==='monthly-date')d.setUTCDate(base.getUTCDate());else{const week=Math.floor((base.getUTCDate()-1)/7);d.setUTCDate(1+(base.getUTCDay()-d.getUTCDay()+7)%7+7*week);}if(d.getUTCMonth()!==month){if(d.getTime()-9*3600000>last)break;continue;}}
  const start=d.getTime()-9*3600000;if(start>last)break;out.push({...b,start:new Date(start).toISOString(),end:new Date(start+duration).toISOString()});
 }
 return out;
}
function conflicts(items,excluded=[]){const result=[];for(const item of items)for(const raw of q('SELECT * FROM events WHERE start < ? AND end > ?',item.end,item.start)){if(excluded.includes(raw.id))continue;const e=parsed(raw);const shared=e.resources.filter(x=>item.resources.includes(x));if(shared.length)result.push({id:e.id,title:e.title,start:e.start,end:e.end,participants:e.participants,resources:shared,requestedStart:item.start});}return result;}
function reminders(){transaction(()=>{for(const raw of q('SELECT * FROM events WHERE start > ? AND start <= ?',now(),new Date(Date.now()+30*60000).toISOString())){const e=parsed(raw);for(const uid of new Set([...e.participants,...e.companions]))run('INSERT OR IGNORE INTO notifications(user_id,title,body,dedupe,time) VALUES(?,?,?,?,?)',uid,`${e.title} · 시작 예정`,e.start,`${e.id}:${e.start}:${uid}`,now());}});}
const timer=setInterval(reminders,30000);timer.unref();
async function api(req,res,url){
 let b={};if(['POST','PUT','PATCH','DELETE'].includes(req.method)){let raw='';for await(const c of req){raw+=c;if(raw.length>1000000)fail('요청이 너무 큽니다.',413);}try{b=JSON.parse(raw||'{}');}catch{fail('잘못된 JSON입니다.');}}
 const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const route=url.pathname;const method=req.method;
 if(route==='/api/status'&&method==='GET')return send({setup:!one('SELECT id FROM users LIMIT 1')});
 if(route==='/api/setup'&&method==='POST'){
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))fail('초기 설정은 서버 PC에서 진행하세요.',403);
  if(one('SELECT id FROM users LIMIT 1'))fail('초기 설정이 완료되었습니다.',409);
  if(!b.name?.trim()||!/^\S+@\S+\.\S+$/.test(b.email||'')||typeof b.password!=='string'||b.password.length<12)fail('이름, 이메일과 12자 이상의 비밀번호를 입력하세요.');
  run('INSERT INTO users VALUES(?,?,?,?,?,1)',id(),b.name.trim(),b.email.trim().toLowerCase(),hash(b.password),'admin');return send({ok:true});
 }
 if(route==='/api/login'&&method==='POST'){
  const key=`${req.socket.remoteAddress}:${String(b.email).toLowerCase()}`,attempt=one('SELECT * FROM login_attempts WHERE key=?',key);
  if(attempt&&attempt.reset>Date.now()&&attempt.count>=10)fail('로그인 시도가 많습니다. 15분 뒤 다시 시도하세요.',429);
  const u=one('SELECT * FROM users WHERE email=?',String(b.email).trim().toLowerCase());
  if(!u?.active||typeof b.password!=='string'||!verify(b.password,u.password)){run('INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset<? THEN 1 ELSE count+1 END,reset=CASE WHEN reset<? THEN excluded.reset ELSE reset END',key,Date.now()+900000,Date.now(),Date.now());fail('이메일 또는 비밀번호를 확인하세요.',401);}
  run('DELETE FROM login_attempts WHERE key=?',key);const token=id()+id();run('INSERT INTO sessions VALUES(?,?,?)',token,u.id,Date.now()+12*3600000);
  res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE==='1'?'; Secure':''}`);return send(safeUser(u));
 }
 if(!['GET','HEAD'].includes(method)&&req.headers.origin&&req.headers.origin!==`${process.env.COOKIE_SECURE==='1'?'https':'http'}://${req.headers.host}`)fail('허용되지 않은 출처입니다.',403);
 const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8);
 const u=authRequired?one('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND active=1',token||'',Date.now()):one('SELECT * FROM users WHERE id=?','local-preview');if(!u)fail('로그인이 필요합니다.',401);
 if(route==='/api/logout'){run('DELETE FROM sessions WHERE token=?',token);res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send({ok:true});}
 if(route==='/api/me')return send(safeUser(u));
 if(route==='/api/users'&&method==='GET')return send(q("SELECT * FROM users WHERE id != 'local-preview'").map(safeUser));
 if(route==='/api/resources'&&method==='GET')return send(q('SELECT * FROM resources ORDER BY kind,name'));
 if(route==='/api/changes')return send(q('SELECT * FROM changes ORDER BY id DESC LIMIT 30'));
 if(route==='/api/notifications'&&method==='GET'){reminders();return send(q('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 200',u.id));}
 if(route==='/api/notifications/read'&&method==='POST'){run('UPDATE notifications SET read=1 WHERE user_id=?',u.id);return send({ok:true});}
 if(route==='/api/events'&&method==='GET'){if(!url.searchParams.get('from')||!url.searchParams.get('to'))fail('조회 기간이 필요합니다.');return send(q('SELECT * FROM events WHERE start < ? AND end > ? ORDER BY start',url.searchParams.get('to'),url.searchParams.get('from')).map(parsed));}
 if(route==='/api/events'&&method==='POST'){
  validate(b);const items=occurrences(b);const found=conflicts(items);if(found.length&&!b.confirmConflict)return send({conflicts:found},409);
  transaction(()=>{const series=b.repeat&&b.repeat!=='none'?id():null;for(const item of items){const e={...item,id:id()};const t=now();run('INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)',e.id,series,e.title.trim(),e.category,e.start,e.end,e.place||'',e.description||'',JSON.stringify(e.participants),JSON.stringify(e.companions),JSON.stringify(e.resources),u.id,t,u.id,t);}notify({...b,id:series||one('SELECT id FROM events ORDER BY rowid DESC LIMIT 1').id},`등록 (${items.length}건)`,u);});return send({ok:true,count:items.length});
 }
 if(route.startsWith('/api/events/')&&['PUT','DELETE'].includes(method)){
  const eid=route.split('/').pop();const raw=one('SELECT * FROM events WHERE id=?',eid);if(!raw)fail('일정을 찾을 수 없습니다.',404);const old=parsed(raw);
  if(b.version!==old.version)fail('다른 직원이 변경했습니다. 최신 일정을 다시 열어주세요.',409);
  const all=b.scope==='series'&&old.series;const targets=all?q('SELECT * FROM events WHERE series=?',old.series).map(parsed):[old];
  if(method==='DELETE'){transaction(()=>{for(const e of targets)run('DELETE FROM events WHERE id=?',e.id);notify(old,`삭제 (${targets.length}건)`,u);});return send({ok:true});}
  validate(b);if(all&&(b.start!==old.start||b.end!==old.end))fail('전체 수정에서는 시간 변경을 지원하지 않습니다. 회차별 수정 또는 전체 삭제 후 재등록하세요.');
  const items=targets.map(e=>({...b,start:all?e.start:b.start,end:all?e.end:b.end,id:e.id}));const found=conflicts(items,targets.map(e=>e.id));if(found.length&&!b.confirmConflict)return send({conflicts:found},409);
  transaction(()=>{for(const e of items)run('UPDATE events SET title=?,category=?,start=?,end=?,place=?,description=?,participants=?,companions=?,resources=?,version=version+1,updated_by=?,updated_at=? WHERE id=?',e.title.trim(),e.category,e.start,e.end,e.place||'',e.description||'',JSON.stringify(e.participants),JSON.stringify(e.companions),JSON.stringify(e.resources),u.id,now(),e.id);notify({...b,id:old.series||eid},`수정 (${targets.length}건)`,u);});return send({ok:true});
 }
 if(['/api/users','/api/resources'].includes(route)&&method==='POST'){
  if(u.role!=='admin')fail('관리자 권한이 필요합니다.',403);
  if(!b.name?.trim())fail('이름을 입력하세요.');
  if(route==='/api/users'){
   if(!/^\S+@\S+\.\S+$/.test(b.email||'')||!['admin','staff'].includes(b.role))fail('이메일과 역할을 확인하세요.');
   const old=b.id?one('SELECT * FROM users WHERE id=?',b.id):null;if(b.id&&!old)fail('직원을 찾을 수 없습니다.');
   if(old?.role==='admin'&&(!b.active||b.role!=='admin')&&q("SELECT id FROM users WHERE role='admin' AND active=1").length<=1)fail('최소 한 명의 활성 관리자가 필요합니다.');
   if((!old||b.password)&&(!b.password||b.password.length<12))fail('비밀번호는 12자 이상이어야 합니다.');
   run('INSERT INTO users VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,password=excluded.password,role=excluded.role,active=excluded.active',b.id||id(),b.name.trim(),b.email.trim().toLowerCase(),b.password?hash(b.password):old.password,b.role,b.active?1:0);
   if(old&&(b.password||!b.active))run('DELETE FROM sessions WHERE user_id=?',old.id);
  }else{
   if(!['차량','장비'].includes(b.kind))fail('자원 구분이 올바르지 않습니다.');
   run('INSERT INTO resources VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,identifier=excluded.identifier,available=excluded.available,active=excluded.active',b.id||id(),b.name.trim(),b.kind,b.identifier||'',b.available?1:0,b.active?1:0);
  }return send({ok:true});
 }
 fail('요청을 찾을 수 없습니다.',404);
}
export const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'");if(url.pathname.startsWith('/api/'))return await api(req,res,url);if(url.pathname==='/runtime-config.js'){res.setHeader('Content-Type','text/javascript');return res.end("globalThis.TODAY_LIST_MODE='server';");}const files={'/':'index.html','/preview-api.js':'preview-api.js','/app.js':'app.js','/style.css':'style.css'};const file=files[url.pathname];if(!file)fail('찾을 수 없습니다.',404);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(readFileSync(path.join(root,'public',file)));}catch(e){res.writeHead(e.status||500,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:e.status?e.message:e.code?.includes('CONSTRAINT')?'중복된 정보이거나 연결된 기록이 있습니다.':'서버 오류가 발생했습니다.'}));if(!e.status)console.error(e);}});
if(process.argv[1]===fileURLToPath(import.meta.url))server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log(`일정 관리: http://${process.env.HOST||'127.0.0.1'}:${process.env.PORT||3000}`));
