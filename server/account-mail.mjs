import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { spawn } from 'node:child_process';
import { managedEmail } from './account-roles.mjs';
export const MAIL_FROM = 'help@hichal.yoterberama.com';
const key = secret => createHash('sha256').update('heichal-account-mail-v1\0'+secret).digest();
export function sealMail(message, secret) {
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv);
 const data=Buffer.concat([cipher.update(JSON.stringify(message),'utf8'),cipher.final()]);
 return [iv,cipher.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');
}
export function openMail(value,secret) {
 const [iv,tag,data]=value.split('.').map(x=>Buffer.from(x,'base64url'));
 const cipher=createDecipheriv('aes-256-gcm',key(secret),iv);cipher.setAuthTag(tag);
 return JSON.parse(Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8'));
}
export async function sendAccountMail(message, { executable='/usr/sbin/sendmail', timeout=20000 }={}) {
 const to=managedEmail(message.to);
 if (!to || typeof message.subject!=='string' || /[\r\n\0]/.test(message.subject) || message.subject.length>200 || typeof message.text!=='string' || message.text.length>32000) throw Error('Invalid account mail');
 const subject=Buffer.from(message.subject,'utf8').toString('base64');
 const body=Buffer.from(message.text,'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
 const mime='From: Heichal <'+MAIL_FROM+'>\r\nTo: '+to+'\r\nSubject: =?UTF-8?B?'+subject+'?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\nAuto-Submitted: auto-generated\r\n\r\n'+body+'\r\n';
 await new Promise((resolve,reject)=>{
  const p=spawn(executable,['-i','-t','-f',MAIL_FROM],{shell:false,stdio:['pipe','ignore','ignore']});
  const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('Mail delivery timeout'));},timeout);timer.unref();
  p.once('error',e=>{clearTimeout(timer);reject(e);});p.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Mail transport unavailable'));});
  p.stdin.on('error',()=>{});p.stdin.end(mime);
 });
}
export function mailDispatcher(queue,secret,send=sendAccountMail) {
 let running=false;
 return async function drain() {
  if(running)return;running=true;
  try{for(let n=0;n<10;n++){const m=await queue.claim(Date.now());if(!m)break;
   try{if(Date.now()-Number(m.created_at)>86400000)throw Error('Mail expired');await send(openMail(m.payload,secret));await queue.done(m.id,Date.now());}
   catch{await queue.retry(m.id,Date.now(),Number(m.attempts));}
  }await queue.prune(Date.now());}finally{running=false;}
 };
}
