import {cpSync,mkdirSync} from 'node:fs';
mkdirSync(new URL('../dist/',import.meta.url),{recursive:true});
cpSync(new URL('../public/',import.meta.url),new URL('../dist/',import.meta.url),{recursive:true});
console.log('Vercel 화면 확인용 빌드 완료 (데이터베이스 연결 없음)');
