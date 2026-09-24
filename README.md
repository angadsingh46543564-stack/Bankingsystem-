# Meridian Bank: Bank Management System

Node.js + Express + MySQL, with a vanilla HTML/CSS/JS single-page frontend.

## Setup
1. Install Node.js 18+ and MySQL 8+ (make sure MySQL is running).
2. `npm install`
3. Create the database and demo data (set DB_USER / DB_PASS if not root with an empty password):
   `DB_PASS=yourpassword npm run seed`
4. `DB_PASS=yourpassword npm start`, then open http://localhost:3000
   (On Windows PowerShell: `$env:DB_PASS="yourpassword"; npm start`)

## Demo logins
| Role | Login | Password |
|---|---|---|
| Admin | admin@bank.com | Admin@123 |
| Customer (Savings, ₹25,000) | rahul@example.com or 100000000001 | Demo@1234 |
| Customer (Current, ₹28,000) | priya@example.com or 100000000002 | Demo@1234 |
| Pending approval | amit@example.com | Demo@1234 (approve as admin first) |

## Structure
```
server.js     Express API, sessions, validation, row-locked transactions
seed.js       Runs schema.sql and inserts demo data
schema.sql    users, customers, accounts, transactions, beneficiaries, admins, notifications
public/       index.html, style.css, app.js (SPA: dashboard, deposit, withdraw, transfer, history, profile, services, admin)
```

## Security
bcrypt password hashing, httpOnly + SameSite session cookies (15 min idle timeout), server-side validation, parameterised SQL, role checks on every route, confirmation dialogs before money moves, DB transactions with row locks so balances stay consistent.
Before deploying, set `SESSION_SECRET`.

## Notes
Forgot password verifies email + PAN/Aadhaar (no email/OTP service in a college demo). New accounts start as "pending" until an admin approves them.
