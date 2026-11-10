import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('일정 운영 통합 검증',async()=>{
 const temp=mkdtempSync(path.join(tmpdir(),'today-list-'));process.env.DB_PATH=path.join(temp,'test.sqlite');process.env.AUTH_REQUIRED='1';
 const {server,occurrences}=await import('./server.mjs');await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api`;let cookie='';
 async function request(url,method='GET',body,auth=cookie){const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json',Cookie:auth},body:body?JSON.stringify(body):undefined});if(res.headers.get('set-cookie'))cookie=res.headers.get('set-cookie').split(';')[0];return {status:res.status,data:await res.json()};}
 try{
  assert.equal((await request('/me')).status,401);
  assert.equal((await request('/setup','POST',{name:'관리자',email:'admin@example.com',password:'test-password-1234'})).status,200);
  assert.equal((await request('/login','POST',{email:'admin@example.com',password:'wrong'})).status,401);
  assert.equal((await request('/login','POST',{email:'admin@example.com',password:'test-password-1234'})).status,200);const adminCookie=cookie;
  const me=(await request('/me')).data;
  await request('/users','POST',{name:'직원',email:'staff@example.com',password:'staff-password-1234',role:'staff',active:true});
  await request('/resources','POST',{name:'차량 01',kind:'차량',identifier:'1234',available:true,active:true});const resource=(await request('/resources')).data[0];
  const b={title:'현장 교육',category:'교육·연수',start:'2026-11-12T09:00:00+09:00',end:'2026-11-12T10:00:00+09:00',participants:[me.id],companions:[],resources:[resource.id],repeat:'none'};
  assert.equal((await request('/events','POST',b)).status,200);
  assert.equal((await request('/events','POST',b)).status,409);
  assert.equal((await request('/events','POST',{...b,confirmConflict:true})).status,200);
  assert.equal((await request('/events','POST',{...b,start:b.end,end:'2026-11-12T11:00:00+09:00'})).status,200);
  const rows=(await request('/events?from=2026-11-01&to=2026-12-01')).data;assert.equal(rows.length,3);
  assert.equal((await request('/events/'+rows[0].id,'PUT',{...b,version:0})).status,409);
  const recurrence=occurrences({...b,start:'2026-01-31T09:00:00+09:00',end:'2026-01-31T10:00:00+09:00',repeat:'monthly-date',until:'2026-03-31'});assert.equal(recurrence.length,2);assert.ok(recurrence[1].start.startsWith('2026-03-31'));
  const weekly=occurrences({...b,repeat:'weekly',until:'2026-11-26'});assert.equal(weekly.length,3);
  const weekday=occurrences({...b,start:'2026-01-02T09:00:00+09:00',end:'2026-01-02T10:00:00+09:00',repeat:'monthly-weekday',until:'2026-03-31'});assert.equal(weekday.length,3);assert.ok(weekday[1].start.startsWith('2026-02-06'));
  await request('/events/'+rows[0].id,'DELETE',{version:1});assert.ok((await request('/changes')).data.some(r=>r.type.includes('삭제')&&r.title===b.title));
  assert.ok((await request('/notifications')).data.length>0);await request('/notifications/read','POST');assert.ok((await request('/notifications')).data.every(n=>n.read===1));
  await request('/login','POST',{email:'staff@example.com',password:'staff-password-1234'});const staffCookie=cookie;
  assert.equal((await request('/resources','POST',{name:'불가',kind:'장비'})).status,403);
  const staff=(await request('/me')).data;cookie=adminCookie;
  await request('/users','POST',{...staff,active:false});assert.equal((await request('/me','GET',null,staffCookie)).status,401);
  assert.equal((await request('/users','POST',{...me,active:false})).status,400);
 }finally{await new Promise(r=>server.close(r));try{rmSync(temp,{recursive:true,force:true});}catch{}}
});
