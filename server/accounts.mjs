import { randomBytes } from 'node:crypto';
import { capabilities, USER_ROLES, managedEmail } from './account-roles.mjs';
import { hashPassword, passwordAcceptable, normalizeUsername, randomToken, digestToken } from './local-auth-crypto.mjs';
import { sealMail } from './account-mail.mjs';
const fail=(message,status)=>Object.assign(new Error(message),{status});
const id=()=>randomBytes(16).toString('hex');
export function createAccounts({store,config,admission,clock=Date.now,dispatch=()=>{}}) {
 async function enqueue(tx,user,profile,purpose) {
  if(!profile?.email)throw fail('לא הוגדרה כתובת מייל לחשבון',409);
  const token=randomToken(),now=clock(),expires=now+(purpose==='password'?3600000:86400000);
  await tx.deleteAccountTokens(user.id,purpose);
  await tx.insertAccountToken({hash:digestToken(token),userId:user.id,purpose,version:user.version,expires});
  const link=config.publicOrigin+config.apiBasePath+'/auth/account#'+purpose+':'+token;
  const text=(purpose==='password'?'שלום,\nלקביעת סיסמה לחשבון '+user.username+' פתחו את הקישור הבא (תקף לשעה):\n':'שלום,\nלאימות כתובת המייל לחשבון '+user.username+' פתחו את הקישור הבא (תקף ליום):\n')+link+'\n\nאם לא ביקשתם זאת, אפשר להתעלם מההודעה.\nהיכל הקודש';
  await tx.enqueueAccountMail({id:id(),now,payload:sealMail({to:profile.email,subject:purpose==='password'?'קביעת סיסמה בהיכל הקודש':'אימות כתובת מייל בהיכל הקודש',text},config.env.SESSION_SECRET)});
 }
 function kick(){Promise.resolve().then(dispatch).catch(()=>{});}
 async function fresh(tx,auth,admin=false) {
  if(auth?.method!=='local')throw fail('נדרשת כניסה לחשבון מקומי',403);
  const u=await tx.getUserById(auth.user.id),s=await tx.getSession(digestToken(auth.token)),settings=await tx.getSettings();
  if(!settings.local_enabled||!u||u.disabled||u.version!==auth.user.version||!s||s.version!==u.version||s.expires_at<=clock())throw fail('ההפעלה הסתיימה. התחברו שוב.',401);
  if(admin&&!capabilities(u.role).manageUsers)throw fail('אין הרשאה לניהול משתמשים',403);
  return u;
 }
 async function admin(request,env,auth,method,body) {
  if(!auth?.actor?.capabilities?.manageUsers)throw fail('אין הרשאה לניהול משתמשים',403);
  if(method==='GET')return {users:await store.listAccounts(),roles:USER_ROLES};
  await admission(request,env,auth.user.username);
  const result=await store.atomic(async tx=>{
   await fresh(tx,auth,true);
   if(body.action==='create'){
    const username=normalizeUsername(body.username),email=managedEmail(body.email),name=typeof body.displayName==='string'?body.displayName.trim():'';
    if(!username||!email||!name||[...name].length>40||/[\p{Cc}<>]/u.test(name)||!USER_ROLES.includes(body.role))throw fail('בדקו את שם המשתמש, השם, המייל והתפקיד',400);
    if(await tx.getUserByUsername(username)||await tx.getAccountByEmail(email))throw fail('שם המשתמש או המייל כבר בשימוש',409);
    if((await tx.listAccounts()).length>=1000)throw fail('הגעתם למכסת המשתמשים',409);
    if(body.password!==undefined&&body.password!==''&&!passwordAcceptable(body.password))throw fail('הסיסמה צריכה להכיל 8–128 תווים',400);
    const provided=typeof body.password==='string'&&body.password!=='';
    const user={id:id(),username,display_name:name,password_hash:await hashPassword(provided?body.password:randomToken()),owner_hash:digestToken(email),role:body.role,version:1,disabled:false};
    await tx.insertUser(user);await tx.saveAccountProfile(user.id,email,false);
    await enqueue(tx,user,{email},provided?'verify':'password');
    return {created:true,mailQueued:true};
   }
   if(!/^[a-f0-9]{32}$/.test(body.id||''))throw fail('משתמש לא תקין',400);
   const user=await tx.getUserById(body.id);if(!user)throw fail('משתמש לא נמצא',404);
   const profile=await tx.getAccountProfile(user.id);
   if(['reset','verify'].includes(body.action)){
    if(user.disabled)throw fail('החשבון מושבת',409);
    await enqueue(tx,user,profile,body.action==='reset'?'password':'verify');
    return {mailQueued:true};
   }
   if(body.action!=='update'||!USER_ROLES.includes(body.role)||typeof body.disabled!=='boolean')throw fail('פעולה לא תקינה',400);
   if(user.role==='owner')throw fail('חשבון הבעלים הראשי מוגן משינוי תפקיד או השבתה',409);
   if(user.id===auth.user.id&&(body.disabled||body.role!=='administrator'))throw fail('אין להשבית או להוריד הרשאה מהחשבון הפעיל שלכם',409);
   const admins=(await tx.listAccounts()).filter(x=>!Number(x.disabled)&&['owner','administrator'].includes(x.role));
   if(user.role==='administrator'&&(body.disabled||body.role!=='administrator')&&admins.length<=1)throw fail('צריך להשאיר מנהל פעיל',409);
   await tx.saveUser({...user,role:body.role,disabled:body.disabled,version:user.version+1});await tx.deleteUserSessions(user.id);
   return {updated:true};
  });kick();return result;
 }
 async function forgot(request,env,body) {
  const email=managedEmail(body.email);
  await admission(request,env,'account-recovery:'+digestToken(email||'invalid'));
  if(email)await store.atomic(async tx=>{
   const settings=await tx.getSettings();if(!settings.local_enabled)return;
   const found=await tx.getAccountByEmail(email);if(!found)return;
   const user=await tx.getUserById(found.user_id);if(!user||user.disabled)return;
   await enqueue(tx,user,{email},'password');
  });
  kick();return {message:'אם הכתובת משויכת לחשבון פעיל, יישלח אליה קישור לקביעת סיסמה.'};
 }
 async function redeem(request,env,body) {
  await admission(request,env,'account-token');
  if(typeof body.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.token)||!['verify','password'].includes(body.purpose))throw fail('הקישור אינו תקין או שפג תוקפו',400);
  const hash=digestToken(body.token),first=await store.getAccountToken(hash);
  if(!first||first.purpose!==body.purpose||Number(first.expires_at)<=clock())throw fail('הקישור אינו תקין או שפג תוקפו',400);
  let passwordHash;
  if(body.purpose==='password'){
   if(body.password!==body.confirmation||!passwordAcceptable(body.password))throw fail('נדרשת סיסמה תואמת של 8–128 תווים',400);
   passwordHash=await hashPassword(body.password);
  }
  return store.atomic(async tx=>{
   const t=await tx.getAccountToken(hash),settings=await tx.getSettings();
   const user=t?await tx.getUserById(t.user_id):null,p=user?await tx.getAccountProfile(user.id):null;
   if(!settings.local_enabled||!t||t.purpose!==body.purpose||Number(t.expires_at)<=clock()||!user||user.disabled||user.version!==Number(t.version)||!p)throw fail('הקישור אינו תקין או שפג תוקפו',400);
   await tx.deleteAccountTokens(user.id,body.purpose);await tx.saveAccountProfile(user.id,p.email,true);
   if(passwordHash){await tx.saveUser({...user,password_hash:passwordHash,version:user.version+1});await tx.deleteUserSessions(user.id);await tx.deleteAccountTokens(user.id,'verify');}
   return {completed:true,message:passwordHash?'הסיסמה נשמרה. אפשר להתחבר ללוח הניהול.':'כתובת המייל אומתה.'};
  });
 }
 // Restricted authors own only individual pages that they created. Ownership
 // survives publication; published pre-existing pages can never be claimed.
 async function authorizePath(auth,path,{published=false,draftEmail=null,claim=false}={}) {
  if(capabilities(auth.user.role).editAll)return;
  if(!['author','contributor'].includes(auth.user.role)||!/^data\/pages\/[a-z0-9][a-z0-9-]*\.json$/.test(path))throw fail('התפקיד מאפשר עריכת דפים אישיים בלבד',403);
  await store.atomic(async tx=>{
   const user=await fresh(tx,auth),owner=await tx.contentOwner(path);
   if(!['author','contributor'].includes(user.role)||owner&&owner!==user.id||!owner&&(published||draftEmail&&draftEmail!==auth.actor.email))throw fail('אין הרשאה לערוך את התוכן הזה',403);
   if(!owner&&claim)await tx.claimContent(path,user.id);
  });
 }
 return {admin,forgot,redeem,authorizePath,enqueue,kick,fresh};
}
