import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilities,managedEmail } from '../server/account-roles.mjs';
import { sealMail,openMail,sendAccountMail } from '../server/account-mail.mjs';
import { renderAccountPage } from '../server/account-page.mjs';
test('roles enforce separate manage, publish, contribute and personal access',()=>{
 assert.equal(capabilities('administrator').manageUsers,true);assert.equal(capabilities('editor').manageUsers,false);
 assert.equal(capabilities('editor').publish,true);assert.equal(capabilities('author').editAll,false);assert.equal(capabilities('author').publish,true);
 assert.equal(capabilities('contributor').edit,true);assert.equal(capabilities('contributor').publish,false);assert.equal(capabilities('contributor').upload,false);
 assert.equal(capabilities('subscriber').edit,false);assert.equal(capabilities('unknown').edit,false);
});
test('mail accepts ordinary addresses and rejects header/domain injection',async()=>{
 assert.equal(managedEmail(' Y0583270102@gmail.com '),'y0583270102@gmail.com');
 for(const value of ["a@'gmail.com","a@b.com\r\nBcc: x@y.com",'a@@b.com'])assert.equal(managedEmail(value),null);
 await assert.rejects(sendAccountMail({to:'a@b.com',subject:'x\r\nBcc: x@y.com',text:'x'}),/Invalid account mail/);
});
test('mail queue tokens are encrypted and authenticated with the server secret',()=>{
 const secret='x'.repeat(32),message={to:'a@b.com',subject:'אימות',text:'private-token'};
 const encrypted=sealMail(message,secret);assert.ok(!encrypted.includes('private-token'));assert.deepEqual(openMail(encrypted,secret),message);
 assert.throws(()=>openMail(encrypted,'y'.repeat(32)));assert.notEqual(sealMail(message,secret),encrypted);
});
test('account links clear fragment tokens and use same-origin recovery with 8 character passwords',()=>{
 const html=renderAccountPage({apiBasePath:'/cms-api',nonce:'abc'});
 assert.ok(html.includes('minlength="8"'));assert.ok(html.includes("history.replaceState"));assert.ok(html.includes("credentials:'omit'"));
 assert.ok(!html.includes('https://'));assert.ok(renderAccountPage({nonce:'abc',recovery:true}).includes('type="email"'));
});
