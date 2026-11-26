# bms_main

BookMyShow-style backend (Node + Postgres + Redis + Clerk + SMTP).

## Features

- Clerk auth (Bearer JWT) → local `users` sync (`AUTH_DISABLED=1` for local benches)
- Seat hold/book with `SELECT … FOR UPDATE` (5 min hold TTL, max 6 seats)
- Cancel hold + expiry worker
- Idempotent book (one booking per hold)
- Token-bucket rate limit (Redis / memory fallback)
- Catalog cache-aside (movies include `description`) — not for live seats
- Job queue (`SKIP LOCKED`, retries, DLQ) + **SMTP** booking confirmation email

Still skipped: payments, phone OTP/SMS, admin, queue/lottery.

## Setup (API)

```powershell
cd bms_main
npm install
docker compose up -d
# .env: SMTP_*, CLERK_SECRET_KEY, AUTH_DISABLED=0, CORS_ORIGIN=http://localhost:3000
npm run setup
npm run server
```

`GET /health` reports `clerkConfigured`, `smtpConfigured`, `redis`, `authDisabled`.

## Frontend (Next.js)

```powershell
cd bms_main/web
# .env.local already needs NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY + NEXT_PUBLIC_API_URL
npm install
npm run dev
```

Open **http://localhost:3000** — browse cities → seats → Continue (Clerk sign-in) → checkout countdown → Book / Back.

In Clerk Dashboard, add `http://localhost:3000` to allowed origins / redirect URLs.

## Auth

**Production path**

1. Create a Clerk app → enable Email.
2. Set `CLERK_SECRET_KEY` (and publishable key for the future frontend).
3. Set `AUTH_DISABLED=0`.
4. Call protected APIs with `Authorization: Bearer <session_jwt>`.

**Local benches**

```env
AUTH_DISABLED=1
```

Pass `"userId": 1` (seeded demo user) in JSON body / query as before.

## SMTP (Gmail)

1. Google account → 2-Step Verification → App password.  
2. Set `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` in `.env` (spaces in the app password are fine).  
3. Book a seat → job `notify_booking` sends mail (retries on failure).

## Main APIs

| Method | Path | Auth |
|--------|------|------|
| GET | `/cities`, `/cities/:id/movies`, `/movies/:id`, `/movies/:id/shows` | no |
| GET | `/shows`, `/shows/:id/seats` | no |
| GET | `/me`, `/me/bookings` | yes |
| POST | `/holds`, `/holds/:id/cancel`, `/bookings` | yes |
| GET | `/bookings/:id` | yes (owner) |

## Scripts

```powershell
npm run smoke:jobs-cache
npm run smoke:smtp          # hold→book→wait for notify job (needs AUTH_DISABLED=1)
npm run smoke:idempotent    # book same hold twice → one booking (needs AUTH_DISABLED=1)
npm run bench:hold          # server with RATE_LIMIT_DISABLED=1 and AUTH_DISABLED=1
```

**Idempotent book:** `POST /bookings` with the same `holdId` always returns the same booking (`idempotentReplay: true` on repeats). Enforced by unique index on `bookings.hold_id` plus hold-row locking.
