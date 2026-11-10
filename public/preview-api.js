// In-memory preview only. Never stores business data, passwords or login sessions.
export function createPreviewApi(clock=()=>new Date()) {
 const state={users:[],resources:[],events:[],changes:[],notifications:[]};
 const me={id:'local-preview',name:'공용 사용자',role:'admin',active:true};
 const id=()=>crypto.randomUUID();
 const fail=(message,status=400,data={})=>{throw Object.assign(new Error(message),{status,data:{error:message,...data}});};
 const log=(event,type)=>{
  const time=clock().toISOString(),change={id:id(),event_id:event.id,title:event.title,actor:'공용 사용자',type,time};
  state.changes.unshift(change);
  state.notifications.unshift({id:id(),title:`${event.title} · ${type}`,body:time,read:0,time});
 };
 function repeats(b){
  if(!b.repeat||b.repeat==='none')return [{...b}];
  if(!['weekly','monthly-date','monthly-weekday'].includes(b.repeat)||!/^\d{4}-\d{2}-\d{2}$/.test(b.until||''))fail('반복 규칙과 종료일을 확인하세요.');
  const duration=Date.parse(b.end)-Date.parse(b.start),base=new Date(Date.parse(b.start)+9*3600000),until=Date.parse(b.until+'T23:59:59+09:00'),out=[];
  if(!Number.isFinite(until)||until<Date.parse(b.start)||until-Date.parse(b.start)>732*86400000)fail('반복 종료일은 시작일부터 2년 이내로 지정하세요.');
  for(let n=0;n<750;n++){
   const d=new Date(base);
   if(b.repeat==='weekly')d.setUTCDate(base.getUTCDate()+7*n);
   else {d.setUTCDate(1);d.setUTCMonth(base.getUTCMonth()+n);const month=d.getUTCMonth();if(b.repeat==='monthly-date')d.setUTCDate(base.getUTCDate());else d.setUTCDate(1+(base.getUTCDay()-d.getUTCDay()+7)%7+7*Math.floor((base.getUTCDate()-1)/7));if(d.getUTCMonth()!==month){if(d.getTime()-9*3600000>until)break;continue;}}
   const start=d.getTime()-9*3600000;if(start>until)break;out.push({...b,start:new Date(start).toISOString(),end:new Date(start+duration).toISOString()});
  }return out;
 }
 function validate(b){
  if(typeof b.title!=='string'||!b.title.trim()||b.title.length>200)fail('제목은 1~200자로 입력하세요.');
  if(!['행사·회의','교육·연수','휴가·개인'].includes(b.category))fail('분류를 선택하세요.');
  if(!Number.isFinite(Date.parse(b.start))||!Number.isFinite(Date.parse(b.end))||Date.parse(b.end)<=Date.parse(b.start))fail('종료는 시작보다 늦어야 합니다.');
  b.start=new Date(b.start).toISOString();b.end=new Date(b.end).toISOString();
  for(const key of ['participants','companions','resources'])if(!Array.isArray(b[key])||new Set(b[key]).size!==b[key].length)fail('선택 목록을 확인하세요.');
  if(!b.participants.length)fail('관리에서 직원을 추가한 뒤 담당자를 선택하세요.');
  if(b.participants.some(x=>b.companions.includes(x)))fail('담당자와 동행자는 중복될 수 없습니다.');
  for(const uid of [...b.participants,...b.companions])if(!state.users.some(u=>u.id===uid))fail('존재하지 않는 직원입니다.');
  for(const rid of b.resources)if(!state.resources.some(r=>r.id===rid))fail('존재하지 않는 자원입니다.');
 }
 function checkConflicts(items,excluded=[]){const found=[];for(const item of items)for(const e of state.events){if(excluded.includes(e.id)||e.start>=item.end||e.end<=item.start)continue;const shared=e.resources.filter(r=>item.resources.includes(r));if(shared.length)found.push({...e,resources:shared,requestedStart:item.start});}return found;}
 async function request(url,method='GET',body){
  const parsed=new URL(url,'https://preview.invalid'),route=parsed.pathname,b=structuredClone(body||{});
  if(route==='/status')return {setup:false,mode:'preview'};
  if(route==='/me')return me;
  if(route==='/logout')return {ok:true};
  if(route==='/users'&&method==='GET')return state.users;
  if(route==='/resources'&&method==='GET')return state.resources;
  if(route==='/changes'&&method==='GET')return state.changes.slice(0,30);
  if(route==='/notifications'&&method==='GET')return state.notifications.slice(0,200);
  if(route==='/notifications/read'&&method==='POST'){state.notifications.forEach(n=>n.read=1);return {ok:true};}
  if(['/users','/resources'].includes(route)&&method==='POST'){
   if(!b.name?.trim())fail('이름을 입력하세요.');
   const list=route==='/users'?state.users:state.resources,old=b.id?list.find(x=>x.id===b.id):null;
   if(b.id&&!old)fail('항목을 찾을 수 없습니다.',404);
   if(route==='/users'){
    if(!/^\S+@\S+\.\S+$/.test(b.email||''))fail('이메일을 확인하세요.');
    if(list.some(x=>x.id!==b.id&&x.email.toLowerCase()===b.email.toLowerCase()))fail('이미 등록된 이메일입니다.');
   }else if(!['차량','장비'].includes(b.kind))fail('자원 구분을 확인하세요.');
   const item=route==='/users'?{id:old?.id||id(),name:b.name.trim(),email:b.email,role:b.role||'staff',active:!!b.active}:{id:old?.id||id(),name:b.name.trim(),kind:b.kind,identifier:b.identifier||'',active:!!b.active,available:b.available?1:0};
   if(old)Object.assign(old,item);else list.push(item);return {ok:true};
  }
  if(route==='/events'&&method==='GET')return state.events.filter(e=>e.start<parsed.searchParams.get('to')&&e.end>parsed.searchParams.get('from')).sort((a,b)=>a.start.localeCompare(b.start));
  if(route==='/events'&&method==='POST'){
   validate(b);const items=repeats(b),conflicts=checkConflicts(items);if(conflicts.length&&!b.confirmConflict)fail('차량·장비 예약이 겹칩니다.',409,{conflicts});
   const series=items.length>1?id():null,time=clock().toISOString();
   const created=items.map(e=>({...e,id:id(),series,version:1,created_by:me.id,updated_by:me.id,created_at:time,updated_at:time}));state.events.push(...created);log(created[0],`등록 (${created.length}건)`);return {ok:true,count:created.length};
  }
  if(route.startsWith('/events/')&&['PUT','DELETE'].includes(method)){
   const old=state.events.find(e=>e.id===route.split('/').pop());if(!old)fail('일정을 찾을 수 없습니다.',404);
   if(old.version!==b.version)fail('일정이 변경되었습니다. 다시 열어주세요.',409);
   const all=b.scope==='series'&&old.series,targets=all?state.events.filter(e=>e.series===old.series):[old];
   if(method==='DELETE'){state.events=state.events.filter(e=>!targets.includes(e));log(old,`삭제 (${targets.length}건)`);return {ok:true};}
   validate(b);if(all&&(b.start!==old.start||b.end!==old.end))fail('전체 수정은 내용·참여자·자원만 변경할 수 있습니다.');
   const items=targets.map(e=>({...e,...b,start:all?e.start:b.start,end:all?e.end:b.end,id:e.id,version:e.version+1})),conflicts=checkConflicts(items,targets.map(e=>e.id));
   if(conflicts.length&&!b.confirmConflict)fail('차량·장비 예약이 겹칩니다.',409,{conflicts});
   for(const e of items)Object.assign(state.events.find(x=>x.id===e.id),e,{updated_at:clock().toISOString(),updated_by:me.id});log(items[0],`수정 (${items.length}건)`);return {ok:true};
  }
  fail('요청을 찾을 수 없습니다.',404);
 }
 return async (...args)=>structuredClone(await request(...args));
}
