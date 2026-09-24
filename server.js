const express=require('express'),session=require('express-session'),mysql=require('mysql2/promise'),bcrypt=require('bcryptjs');
const pool=mysql.createPool({host:process.env.DB_HOST||'localhost',user:process.env.DB_USER||'root',password:process.env.DB_PASS||'',database:'bank_db',decimalNumbers:true});
const app=express();
app.use(express.json({limit:'20kb'}));
app.use(session({secret:process.env.SESSION_SECRET||'change-this-secret',resave:false,saveUninitialized:false,rolling:true,cookie:{httpOnly:true,sameSite:'strict',maxAge:15*60*1000}}));
app.use(express.static(__dirname+'/public'));

const db=async(s,p)=>(await pool.query(s,p))[0];
const bad=m=>Object.assign(new Error(m),{user:true});
const wrap=f=>(req,res)=>f(req,res).catch(e=>e.user?res.status(400).json({error:e.message}):(console.error(e),res.status(500).json({error:'Server error'})));
const auth=role=>(req,res,next)=>{const u=req.session.user;u&&(!role||u.role===role)?next():res.status(401).json({error:'Please log in'})};
const R={email:/^[^\s@]+@[^\s@]+\.[^\s@]+$/,mobile:/^[6-9]\d{9}$/,id:/^([A-Z]{5}\d{4}[A-Z]|\d{12})$/};
const pwOk=p=>typeof p==='string'&&p.length>=8&&/\d/.test(p)&&/[a-zA-Z]/.test(p);
const PWMSG='Password needs 8+ characters with letters and numbers';
const amount=v=>{const n=Math.round(Number(v)*100)/100;if(!(n>0&&n<=1000000))throw bad('Enter an amount between 0.01 and 10,00,000');return n};
const r2=n=>Math.round(n*100)/100,fmt=n=>'Rs.'+n.toLocaleString('en-IN',{minimumFractionDigits:2});
const txnId=()=>'TXN'+Date.now().toString(36).toUpperCase()+Math.floor(Math.random()*1e4);
const note=(cn,uid,m)=>cn.query('INSERT INTO notifications(user_id,message) VALUES(?,?)',[uid,m]);

// ---------- Auth ----------
app.post('/api/register',wrap(async(req,res)=>{
 const b=req.body,id=String(b.id_number||'').toUpperCase().trim();
 if(!b.name||b.name.trim().length<3)throw bad('Enter your full name');
 if(!b.dob||new Date(b.dob)>new Date(Date.now()-18*31557600000))throw bad('You must be 18 or older');
 if(!['Male','Female','Other'].includes(b.gender))throw bad('Select a gender');
 if(!R.mobile.test(b.mobile))throw bad('Enter a valid 10-digit mobile number');
 if(!R.email.test(b.email))throw bad('Enter a valid email address');
 if(!b.address||b.address.trim().length<5)throw bad('Enter your address');
 if(!R.id.test(id))throw bad('Enter a valid PAN (ABCDE1234F) or 12-digit Aadhaar number');
 if(!['Savings','Current'].includes(b.type))throw bad('Select an account type');
 if(!pwOk(b.password))throw bad(PWMSG);
 if((await db('SELECT id FROM users WHERE email=?',[b.email])).length)throw bad('This email is already registered');
 const acc='10'+String(Math.floor(Math.random()*1e10)).padStart(10,'0'),cn=await pool.getConnection();
 try{await cn.beginTransaction();
  const [u]=await cn.query('INSERT INTO users(email,password_hash) VALUES(?,?)',[b.email,await bcrypt.hash(b.password,10)]);
  const [c]=await cn.query('INSERT INTO customers(user_id,name,dob,gender,mobile,address,id_number) VALUES(?,?,?,?,?,?,?)',[u.insertId,b.name.trim(),b.dob,b.gender,b.mobile,b.address.trim(),id]);
  await cn.query('INSERT INTO accounts(account_no,customer_id,type) VALUES(?,?,?)',[acc,c.insertId,b.type]);
  await note(cn,u.insertId,'Account request submitted. It is waiting for admin approval.');
  await cn.commit();
 }catch(e){await cn.rollback();throw e}finally{cn.release()}
 res.json({accountNo:acc});
}));
app.post('/api/login',wrap(async(req,res)=>{
 const {id,password}=req.body;if(!id||!password)throw bad('Enter your account number or email, and your password');
 const [u]=await db('SELECT u.id,u.role,u.password_hash,a.status FROM users u LEFT JOIN customers c ON c.user_id=u.id LEFT JOIN accounts a ON a.customer_id=c.id WHERE u.email=? OR a.account_no=? LIMIT 1',[id,id]);
 if(!u||!(await bcrypt.compare(password,u.password_hash)))throw bad('Incorrect account number/email or password');
 if(u.role==='customer'&&u.status!=='active')throw bad({pending:'Your account is waiting for admin approval',inactive:'Your account is deactivated. Contact support',rejected:'Your account request was rejected'}[u.status]);
 req.session.regenerate(()=>{req.session.user={id:u.id,role:u.role};res.json({role:u.role})});
}));
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({ok:1})));
app.post('/api/forgot',wrap(async(req,res)=>{
 const {email,id_number,password}=req.body;if(!pwOk(password))throw bad(PWMSG);
 const [u]=await db('SELECT u.id FROM users u JOIN customers c ON c.user_id=u.id WHERE u.email=? AND c.id_number=?',[email,String(id_number||'').toUpperCase().trim()]);
 if(!u)throw bad('Email and PAN/Aadhaar do not match our records');
 await db('UPDATE users SET password_hash=? WHERE id=?',[await bcrypt.hash(password,10),u.id]);res.json({ok:1});
}));
const ME='SELECT u.role,u.email,c.name,c.dob,c.gender,c.mobile,c.address,c.id_number,a.account_no,a.type,a.balance,a.status,a.created_at FROM users u JOIN customers c ON c.user_id=u.id JOIN accounts a ON a.customer_id=c.id WHERE u.id=?';
app.get('/api/me',auth(),wrap(async(req,res)=>{
 if(req.session.user.role==='admin'){const [a]=await db('SELECT u.email,u.role,a.name FROM admins a JOIN users u ON u.id=a.user_id WHERE u.id=?',[req.session.user.id]);return res.json(a)}
 res.json((await db(ME,[req.session.user.id]))[0]);
}));

// ---------- Money (row-locked DB transactions) ----------
async function withAcc(uid,fn){const cn=await pool.getConnection();try{await cn.beginTransaction();
 const [[a]]=await cn.query('SELECT a.*,c.name FROM accounts a JOIN customers c ON c.id=a.customer_id WHERE c.user_id=? FOR UPDATE',[uid]);
 if(!a||a.status!=='active')throw bad('Your account is not active');
 const out=await fn(cn,a);await cn.commit();return out}catch(e){await cn.rollback();throw e}finally{cn.release()}}
const post=(cn,acc,type,dir,amt,bal,cp,id)=>cn.query('INSERT INTO transactions(txn_id,account_id,type,direction,amount,balance_after,counterparty) VALUES(?,?,?,?,?,?,?)',[id,acc,type,dir,amt,bal,cp]);
const setBal=(cn,id,b)=>cn.query('UPDATE accounts SET balance=? WHERE id=?',[b,id]);
app.post('/api/deposit',auth('customer'),wrap(async(req,res)=>{const amt=amount(req.body.amount);
 res.json(await withAcc(req.session.user.id,async(cn,a)=>{const bal=r2(a.balance+amt),id=txnId();
  await setBal(cn,a.id,bal);await post(cn,a.id,'Deposit','Credit',amt,bal,null,id);
  await note(cn,req.session.user.id,`${fmt(amt)} deposited. Ref ${id}`);return{txnId:id,balance:bal}}))}));
app.post('/api/withdraw',auth('customer'),wrap(async(req,res)=>{const amt=amount(req.body.amount);
 res.json(await withAcc(req.session.user.id,async(cn,a)=>{if(amt>a.balance)throw bad('Insufficient balance');
  const bal=r2(a.balance-amt),id=txnId();
  await setBal(cn,a.id,bal);await post(cn,a.id,'Withdrawal','Debit',amt,bal,null,id);
  await note(cn,req.session.user.id,`${fmt(amt)} withdrawn. Ref ${id}`);return{txnId:id,balance:bal}}))}));
app.post('/api/transfer',auth('customer'),wrap(async(req,res)=>{const amt=amount(req.body.amount),to=String(req.body.to||'').trim();
 res.json(await withAcc(req.session.user.id,async(cn,a)=>{
  if(to===a.account_no)throw bad('You cannot transfer to your own account');
  const [[r]]=await cn.query('SELECT a.*,c.user_id,c.name FROM accounts a JOIN customers c ON c.id=a.customer_id WHERE a.account_no=? FOR UPDATE',[to]);
  if(!r)throw bad('Receiver account not found');if(r.status!=='active')throw bad('Receiver account is not active');
  if(amt>a.balance)throw bad('Insufficient balance');
  const id=txnId(),sb=r2(a.balance-amt),rb=r2(r.balance+amt);
  await setBal(cn,a.id,sb);await setBal(cn,r.id,rb);
  await post(cn,a.id,'Transfer','Debit',amt,sb,to,id);await post(cn,r.id,'Transfer','Credit',amt,rb,a.account_no,id);
  await cn.query('INSERT IGNORE INTO beneficiaries(account_id,benef_account_no,nickname) VALUES(?,?,?)',[a.id,to,r.name]);
  await note(cn,req.session.user.id,`${fmt(amt)} sent to ${r.name} (${to}). Ref ${id}`);
  await note(cn,r.user_id,`${fmt(amt)} received from ${a.name}. Ref ${id}`);
  return{txnId:id,balance:sb}}))}));
app.get('/api/lookup/:no',auth('customer'),wrap(async(req,res)=>{
 const [r]=await db("SELECT c.name FROM accounts a JOIN customers c ON c.id=a.customer_id WHERE a.account_no=? AND a.status='active'",[req.params.no]);
 r?res.json(r):res.status(404).json({error:'Account not found'})}));
app.get('/api/beneficiaries',auth('customer'),wrap(async(req,res)=>res.json(await db('SELECT b.benef_account_no,b.nickname FROM beneficiaries b JOIN accounts a ON a.id=b.account_id JOIN customers c ON c.id=a.customer_id WHERE c.user_id=?',[req.session.user.id]))));
app.get('/api/transactions',auth('customer'),wrap(async(req,res)=>{
 const {type,q,from,to}=req.query;
 let s='SELECT t.txn_id,t.type,t.direction,t.amount,t.balance_after,t.counterparty,t.created_at FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN customers c ON c.id=a.customer_id WHERE c.user_id=?';const p=[req.session.user.id];
 if(type){s+=' AND t.type=?';p.push(type)}
 if(q){s+=' AND (t.txn_id LIKE ? OR t.counterparty LIKE ?)';p.push(`%${q}%`,`%${q}%`)}
 if(from){s+=' AND t.created_at>=?';p.push(from)}
 if(to){s+=' AND t.created_at<=?';p.push(to+' 23:59:59')}
 res.json(await db(s+' ORDER BY t.id DESC LIMIT 300',p))}));

// ---------- Profile & notifications ----------
app.put('/api/profile',auth('customer'),wrap(async(req,res)=>{const {mobile,email,address}=req.body;
 if(!R.mobile.test(mobile))throw bad('Enter a valid 10-digit mobile number');
 if(!R.email.test(email))throw bad('Enter a valid email address');
 if(!address||address.trim().length<5)throw bad('Enter your address');
 if((await db('SELECT id FROM users WHERE email=? AND id<>?',[email,req.session.user.id])).length)throw bad('Email is used by another account');
 await db('UPDATE users SET email=? WHERE id=?',[email,req.session.user.id]);
 await db('UPDATE customers SET mobile=?,address=? WHERE user_id=?',[mobile,address.trim(),req.session.user.id]);res.json({ok:1})}));
app.put('/api/password',auth(),wrap(async(req,res)=>{const {current,next}=req.body;
 const [u]=await db('SELECT password_hash FROM users WHERE id=?',[req.session.user.id]);
 if(!(await bcrypt.compare(current||'',u.password_hash)))throw bad('Current password is incorrect');
 if(!pwOk(next))throw bad(PWMSG);
 await db('UPDATE users SET password_hash=? WHERE id=?',[await bcrypt.hash(next,10),req.session.user.id]);res.json({ok:1})}));
app.get('/api/notifications',auth(),wrap(async(req,res)=>res.json(await db('SELECT message,is_read,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 15',[req.session.user.id]))));
app.post('/api/notifications/read',auth(),wrap(async(req,res)=>{await db('UPDATE notifications SET is_read=1 WHERE user_id=?',[req.session.user.id]);res.json({ok:1})}));

// ---------- Admin ----------
const adm=auth('admin');
app.get('/api/admin/stats',adm,wrap(async(req,res)=>res.json((await db("SELECT (SELECT COUNT(*) FROM customers) customers,(SELECT COUNT(*) FROM accounts) accounts,(SELECT COUNT(*) FROM accounts WHERE status='pending') pending,(SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='Deposit') deposits,(SELECT COALESCE(SUM(amount),0) FROM transactions WHERE type='Withdrawal') withdrawals"))[0])));
app.get('/api/admin/customers',adm,wrap(async(req,res)=>{const q=`%${req.query.q||''}%`;
 res.json(await db('SELECT a.id,a.account_no,a.type,a.balance,a.status,c.name,c.mobile,u.email FROM accounts a JOIN customers c ON c.id=a.customer_id JOIN users u ON u.id=c.user_id WHERE c.name LIKE ? OR u.email LIKE ? OR a.account_no LIKE ? ORDER BY a.id DESC',[q,q,q]))}));
app.post('/api/admin/accounts/:id/status',adm,wrap(async(req,res)=>{const st=req.body.status;
 if(!['active','inactive','rejected'].includes(st))throw bad('Invalid status');
 const [r]=await db('SELECT c.user_id FROM accounts a JOIN customers c ON c.id=a.customer_id WHERE a.id=?',[req.params.id]);if(!r)throw bad('Account not found');
 await db('UPDATE accounts SET status=? WHERE id=?',[st,req.params.id]);
 await db('INSERT INTO notifications(user_id,message) VALUES(?,?)',[r.user_id,`Your account status is now: ${st}.`]);res.json({ok:1})}));
app.get('/api/admin/transactions',adm,wrap(async(req,res)=>res.json(await db('SELECT t.txn_id,t.type,t.direction,t.amount,t.created_at,a.account_no FROM transactions t JOIN accounts a ON a.id=t.account_id ORDER BY t.id DESC LIMIT 200'))));

app.listen(process.env.PORT||3000,()=>console.log('Bank running at http://localhost:'+(process.env.PORT||3000)));
