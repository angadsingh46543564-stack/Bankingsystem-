const mysql=require('mysql2/promise'),bcrypt=require('bcryptjs'),fs=require('fs');
(async()=>{
const c=await mysql.createConnection({host:process.env.DB_HOST||'localhost',user:process.env.DB_USER||'root',password:process.env.DB_PASS||'',multipleStatements:true});
await c.query(fs.readFileSync(__dirname+'/schema.sql','utf8'));await c.query('USE bank_db');
const hash=p=>bcrypt.hash(p,10);
const [au]=await c.query("INSERT INTO users(email,password_hash,role) VALUES('admin@bank.com',?,'admin')",[await hash('Admin@123')]);
await c.query("INSERT INTO admins(user_id,name) VALUES(?,'Bank Admin')",[au.insertId]);
const add=async(email,name,type,bal,status,no,mobile,idn)=>{
 const [u]=await c.query('INSERT INTO users(email,password_hash) VALUES(?,?)',[email,await hash('Demo@1234')]);
 const [cu]=await c.query('INSERT INTO customers(user_id,name,dob,gender,mobile,address,id_number) VALUES(?,?,?,?,?,?,?)',[u.insertId,name,'2000-05-14','Male',mobile,'12 MG Road, Pune',idn]);
 const [a]=await c.query('INSERT INTO accounts(account_no,customer_id,type,balance,status) VALUES(?,?,?,?,?)',[no,cu.insertId,type,bal,status]);return a.insertId};
const r=await add('rahul@example.com','Rahul Sharma','Savings',25000,'active','100000000001','9876543210','ABCDE1234F');
const p=await add('priya@example.com','Priya Nair','Current',28000,'active','100000000002','9123456780','123456789012');
await add('amit@example.com','Amit Verma','Savings',0,'pending','100000000003','9012345678','FGHIJ5678K');
const tx=(a,i,t,d,amt,bal,cp,days)=>c.query('INSERT INTO transactions(txn_id,account_id,type,direction,amount,balance_after,counterparty,created_at) VALUES(?,?,?,?,?,?,?,DATE_SUB(NOW(),INTERVAL ? DAY))',[i,a,t,d,amt,bal,cp,days]);
await tx(r,'TXNDEMO001','Deposit','Credit',30000,30000,null,120);
await tx(r,'TXNDEMO002','Withdrawal','Debit',4000,26000,null,90);
await tx(r,'TXNDEMO003','Deposit','Credit',12000,38000,null,60);
await tx(r,'TXNDEMO004','Transfer','Debit',8000,30000,'100000000002',40);
await tx(r,'TXNDEMO005','Withdrawal','Debit',5000,25000,null,10);
await tx(p,'TXNDEMO006','Deposit','Credit',20000,20000,null,100);
await tx(p,'TXNDEMO004','Transfer','Credit',8000,28000,'100000000001',40);
console.log('Database ready.\nAdmin: admin@bank.com / Admin@123\nCustomer: rahul@example.com / Demo@1234');process.exit();
})();
