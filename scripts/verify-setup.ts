import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {env} from '../src/config/env.js';
import {models,User} from '../src/modules/domain/models.js';
import {confirmedTestDatabase} from './database-tools.js';
try {
  await mongoose.connect(env.MONGODB_URI);
  confirmedTestDatabase(mongoose.connection.name,env.NODE_ENV);
  const actual=(await mongoose.connection.db!.listCollections().toArray()).map(c=>c.name).sort();
  assert.deepEqual(actual,Object.keys(models).sort());
  const admin=await User.findOne({email:process.env.INITIAL_ADMIN_EMAIL||'kamel@endpoint.local'}).select('+passwordHash');
  assert.ok(admin);assert.equal(admin.role,'super_admin');assert.match(admin.passwordHash,/^\$2[aby]\$/);
  const password=process.env.INITIAL_ADMIN_PASSWORD;assert.ok(password,'Set INITIAL_ADMIN_PASSWORD for login verification');
  assert.ok(await bcrypt.compare(password,admin.passwordHash));
  const base=`http://localhost:${env.PORT}/api/v1`;
  assert.equal((await fetch(`${base}/health`)).status,200);
  const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:admin.email,password})});
  assert.equal(login.status,200);const result=await login.json();assert.equal(result.data.user.role,'super_admin');assert.equal(result.data.user.passwordHash,undefined);
  const cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  assert.equal((await fetch(`${base}/auth/me`,{headers:{cookie}})).status,200);
  assert.equal((await fetch(`${base}/auth/logout`,{method:'POST',headers:{cookie}})).status,200);
  assert.equal((await fetch(`${base}/auth/me`,{headers:{cookie}})).status,401);
  let indexCount=0;for(const model of Object.values(models))indexCount+=(await model.collection.indexes()).length;
  console.log(JSON.stringify({database:mongoose.connection.name,collections:actual.length,indexes:indexCount,users:await User.countDocuments(),passwordHashed:true,health:true,login:true,logoutInvalidated:true}));
}finally{await mongoose.disconnect();}
