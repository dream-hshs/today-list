import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewApi} from './public/preview-api.js';
test('배포 확인용: 저장 없이 직원·자원·날짜별 일정과 예약 경고 동작',async()=>{
 const api=createPreviewApi();
 assert.equal((await api('/status')).setup,false);
 assert.deepEqual(await api('/users'),[]);
 await api('/users','POST',{name:'담당자',email:'staff@example.com',role:'staff',active:true,password:'not-stored'});
 const [staff]=await api('/users');assert.equal(staff.password,undefined);
 await api('/resources','POST',{name:'차량',kind:'차량',active:true,available:true});
 const [vehicle]=await api('/resources');
 const event={title:'교육 운영',category:'교육·연수',start:'2026-11-16T09:00:00+09:00',end:'2026-11-16T10:00:00+09:00',participants:[staff.id],companions:[],resources:[vehicle.id]};
 assert.equal((await api('/events','POST',event)).count,1);
 await assert.rejects(api('/events','POST',event),e=>e.status===409&&e.data.conflicts.length===1);
 await api('/events','POST',{...event,confirmConflict:true});
 const rows=await api('/events?from=2026-11-01&to=2026-12-01');assert.equal(rows.length,2);
 rows[0].title='외부 변경';assert.notEqual((await api('/events?from=2026-11-01&to=2026-12-01'))[0].title,'외부 변경');
 await assert.rejects(api('/events/'+rows[0].id,'PUT',{...event,version:0}),e=>e.status===409);
 await api('/events/'+rows[0].id,'DELETE',{version:1});assert.match((await api('/changes'))[0].type,/삭제/);
 await api('/notifications/read','POST');assert.ok((await api('/notifications')).every(n=>n.read));
 assert.deepEqual(await createPreviewApi()('/users'),[]);
});
test('배포 확인용: 매월 말일 반복과 전체 회차 삭제',async()=>{
 const api=createPreviewApi();await api('/users','POST',{name:'담당자',email:'staff@example.com',active:true});const [staff]=await api('/users');
 const result=await api('/events','POST',{title:'월말 점검',category:'행사·회의',start:'2026-01-31T09:00:00+09:00',end:'2026-01-31T10:00:00+09:00',participants:[staff.id],companions:[],resources:[],repeat:'monthly-date',until:'2026-03-31'});
 assert.equal(result.count,2);const rows=await api('/events?from=2026-01-01&to=2026-04-01');assert.ok(rows[1].start.startsWith('2026-03-31'));
 await api('/events/'+rows[0].id,'DELETE',{version:1,scope:'series'});assert.deepEqual(await api('/events?from=2026-01-01&to=2026-04-01'),[]);
});
