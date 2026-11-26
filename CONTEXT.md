# BookMyShow (BMS) — Project Context

This is the main product codebase. Goal: build a BookMyShow-like ticket booking system, applying the concurrency, data, and reliability concepts learned in the sibling labs (`../race_condition` and prior chat sessions).

---

## Product shape

Users browse movies/events by city, pick a show, select seats, hold them briefly, pay, and get a confirmed ticket. The hard part is **correct inventory under concurrency**, not the UI.

Core flows:

1. Discover (city → movie → venues → showtimes)
2. Seat map for a show
3. Temporary seat hold (TTL)
4. Checkout + payment (idempotent)
5. Confirm booking + async side effects (email/SMS/PDF)

---

## Concept map (labs → BMS)

### 1. Indexing (Postgres)

- Tables live in heap pages (8 KB); without an index, queries do sequential scans.
- B-tree / B+ tree indexes: leaf holds key + TID (pointer to heap row), not the full row.
- Planner picks Seq Scan vs Index Scan vs Index Only Scan vs Bitmap based on selectivity/cost.
- **Composite indexes:** leftmost prefix matters (`(city_id, movie_id, show_time)` helps city+movie, not movie alone).
- **Partial indexes:** e.g. only active shows / available seats.
- **BMS use:** city/movie search, show listings, seat lookups by `show_id`. Always validate with `EXPLAIN ANALYZE`.

### 2. Race conditions & seat inventory

Root cause: **read → decide → write** (check-then-act) on shared stock/seats. Concurrent buyers can both “see available” and oversell.

Failure modes:

- **Lost update:** write absolute value from a stale read; order count rises, stock looks fine.
- **Negative stock / double-booked seat:** relative decrement or dual inserts after stale checks.

Fixes (from `../race_condition`):

| Strategy | Idea | When for BMS |
|---|---|---|
| `SELECT … FOR UPDATE` | Pessimistic row lock; buyers queue | Seat hold/confirm when app logic decides across rows |
| Optimistic (`version` column) | Update only if version matches; retry or give up (503) | Low-contention rows; **bad for hot shows** (retry storms) |
| Atomic `UPDATE … WHERE …` | Check + write in one statement | Simple availability rules that fit SQL |

**BMS seat model (preferred direction):**

- Seats are rows (or a unique constraint on `(show_id, seat_id)`).
- **Hold:** claim seats atomically with status `available → held`, `held_until`, `hold_token`, owner.
- **Confirm:** `held → booked` only if hold still valid and same token/user.
- Prefer unique constraints + conditional updates over “read then insert.”
- Soft hold TTL (e.g. 5–10 min); expire holds via worker or on next claim.

Repo reference: `../race_condition` (`naive`, `naive-delta`, `for-update`, `optimistic`, `atomic` + `bench.js`).

### 3. Isolation levels & MVCC

- Postgres uses MVCC: readers don’t block writers; no dirty reads (even `READ UNCOMMITTED` ≈ `READ COMMITTED`).
- Anomalies to understand: dirty read, non-repeatable read, phantom read, **write skew**.
- Default `READ COMMITTED` is not enough alone for “at least one of these seats free” style invariants → locks, constraints, or `SERIALIZABLE` / explicit conflict handling.
- **BMS use:** booking + payment in clear transaction boundaries; never assume two transactions that each look fine won’t break a global rule (write skew).

### 4. N+1 queries & connection pooling

- N+1: 1 query for list + N queries per related row → fix with joins / `IN` / ORM `include`.
- Postgres `max_connections` is shared across **all** app instances; each instance’s pool steals from the same budget.
- **PgBouncer** (transaction pooling): many cheap app connections → few real Postgres connections; seat used only while a query/tx runs.
- **BMS use:** show listings with venues; never query seats/prices one-by-one in a loop; put PgBouncer in front when scaling app replicas.

### 5. Rate limiting

- **Fixed window:** simple; burst at window edges (2× limit across boundary).
- **Sliding window** (log or approx counter): smoother.
- **Token bucket:** sustained rate + controlled burst (good default for APIs).
- In-memory limits fail across multiple servers → **Redis** with atomic ops / Lua.
- **BMS use:** search, OTP, seat-hold attempts, payment initiate — per user/IP/API key.

### 6. Cache (Redis cache-aside)

- Read path: get → miss → DB → set; write path: DB first, then **delete** cache key (prefer invalidate over update).
- **TTL** as safety net + jitter to avoid synchronized expiry.
- **Stampede:** lock / singleflight / probabilistic early refresh / serve-stale-while-revalidate.
- **BMS use:** movie details, city listings, static show metadata. Do **not** treat live seat maps as long-lived cache without careful invalidation (or short TTL + stampede protection).

### 7. Idempotency (payments)

- Network/timeouts make “success” look like failure → client retries → double charge.
- Client sends `Idempotency-Key` per payment attempt; server stores key → result atomically (unique constraint / `INSERT … ON CONFLICT` / Redis `SET NX`).
- Same key + same body → replay stored response; same key + different body → reject; in-flight → 409/wait.
- Propagate key to payment provider when possible; expire keys after retry window.
- **BMS use:** `POST /payments` and booking confirm must be safe to retry.

### 8. Background jobs (Postgres queue)

- Web request enqueues work; workers process later.
- Claim with `SELECT … FOR UPDATE SKIP LOCKED` (no duplicate work, no queueing behind one row).
- Failures: exponential backoff via `run_at`; max attempts → **dead-letter** for inspection.
- **BMS use:** booking confirmation email/SMS, ticket PDF, payment webhooks, expiring stale holds.

---

## Suggested domain model (starting point)

- `cities`, `movies`, `venues`, `screens`, `shows`
- `seats` (per screen) + `show_seats` or booking rows keyed by `(show_id, seat_id)` **UNIQUE**
- Seat status: `available | held | booked`
- `holds` / hold fields: `user_id`, `hold_token`, `held_until`
- `bookings`, `booking_seats`, `payments` (with `idempotency_key` unique)
- `jobs` (or external queue later): task, payload, status, attempts, run_at, last_error

---

## Engineering principles for this repo

1. Correctness under concurrency beats clever abstractions.
2. Prefer DB constraints + conditional updates for inventory.
3. Every money-moving or seat-claiming API is idempotent.
4. Measure: `EXPLAIN ANALYZE`, concurrent benches (like `race_condition`), pool saturation.
5. Cache what is read-heavy and slowly changing; keep seat truth in Postgres.
6. Push slow/side-effect work to workers with SKIP LOCKED + backoff + DLQ.
7. Rate-limit abusive/hot paths in Redis when multi-instance.

---

## Sibling learning artifact

- `../race_condition` — working Node + Postgres demo of oversell and three fixes. Reuse those patterns for seats; do not copy naive buy logic into production paths.

---

## Design docs

- **[LLD.md](./LLD.md)** — full low-level design (OPEN + QUEUE + LOTTERY, IRCTC-style soft seat prefs, admin, Node stack).

## Status

- Context captured from prior Cursor sessions (indexing, race conditions, isolation/MVCC, N+1/PgBouncer, rate limiting, cache, idempotency, job queue).
- LLD written for scope B (user + thin admin), Node.js, admission modes OPEN/QUEUE/LOTTERY with non-guaranteed preferred seats.
- v1 backend started: schema + seed + hold/book APIs (OPEN mode only, no admin/queue/lottery/payments yet).
- Rate limit: in-memory token bucket on hold/book (per user + per IP); Redis later for multi-instance.
- Hold cancel API, expire-holds worker, and `scripts/bench-hold.js` concurrent stress test.
- Postgres job queue (SKIP LOCKED + retries + DLQ); Redis cache-aside + Redis rate limit (memory fallback); richer catalog APIs (cities → movies → shows).
- Clerk auth (Bearer JWT → local users); SMTP booking email via nodemailer; movie description caching; CORS; AUTH_DISABLED for benches; 5‑min holds; max 6 seats; idempotent book.
- Next.js frontend in `web/` (Clerk, city→movie→show→seats→checkout hold timer→book).
