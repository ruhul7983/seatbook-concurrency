# Seatbook

Seat booking for small venues. Organizers publish an event with a seat grid, attendees pick a seat and book it.

## Handover note

Seatbook worked, but it wasn't safe to take money through. Two people could book the same seat, anyone could cancel anyone's booking or make themselves an organizer, tokens were signed with a secret written in the code, and one malformed request could take the whole API down. I fixed those, then added seat holds: tap seats to hold them for 10 minutes on one countdown, confirm to book, or let them go back on sale.

### Holds: why Redis, and not only the database

A hold is a lock with a deadline. It has to do three things: never let two people own one seat, free the seat at the exact moment the time runs out, and keep working when a popular event opens and many people tap the same seats at once.

**The database-only design I considered first.** Store a `HELD` row with an `expiresAt`, and let a partial unique index allow only one live claim per seat. It's correct and has one moving part. But Postgres won't let an index condition use `now()`, so expired holds keep blocking their seat until something rewrites them. Every hold attempt would have to clean up stale rows and insert in one transaction. Under a burst, every click becomes a write transaction on the same few rows, and the losers queue for locks and pool connections before failing.

**What I built.** I split the job between the two stores:

- **Redis decides who holds a seat right now.** A hold is `SET seat-key token NX PXAT deadline`, run inside a Lua script so it is atomic. `NX` means exactly one request wins a seat. Every other request is turned away in memory, in microseconds, without touching Postgres. `PXAT` makes the key expire by itself at the deadline, so the seat is back on sale at that instant with no job involved. Each user also has a small hash per event that holds the shared deadline and their seat count, so adding seats joins the running countdown and the 6-seat limit is enforced in the same atomic step.
- **Postgres records everything and has the final word.** Every hold is a `Booking` row (`HELD`, then `CONFIRMED`, `EXPIRED`, `RELEASED` or `CANCELLED`). A partial unique index allows only one `CONFIRMED` booking per seat. Even if Redis lost data or a bug slipped past it, the database still refuses a double booking.

The flows:

- **Hold:** take the Redis lock first, then check the seat isn't booked and write the `HELD` row. If the database step fails, the lock is released (compare-and-delete, so it only removes our own token).
- **Confirm:** one Lua call checks that the user still owns every seat and keeps the locks for a 30-second grace period, so a confirm sent in the last second can finish. One database transaction then turns all the holds into bookings, all or nothing, with the unique index as the backstop. After that the locks are deleted.
- **Expire:** Redis drops the key at the deadline. A sweeper marks the database row `EXPIRED` later; it only tidies records, and nothing waits for it.

**The cost, honestly.** Redis is a second thing to run and reason about:

- **If Redis is down,** browsing still works, but holding and booking return `503`. That fails closed: no seat is sold without a lock.
- **A Redis restart loses live holds.** AOF persistence makes this rare, and losing 10-minute holds is acceptable.
- **The two stores can briefly disagree.** For example, a `HELD` row can outlive its lost Redis key. Reads trust Redis for "is it held", and a confirm on such a row is refused.
- **At today's size** (40-seat rooms), the database-only design would cope. I chose Redis for how it behaves under a burst and for exact expiry, and I kept Postgres as the guarantee so Redis is never trusted on its own.

### Assumptions

The brief left these open, so I decided:

- **Holds need an account.** A logged-out visitor who taps a seat is asked to sign in, and after signing in the app tries to hold that seat. The first signed-in person wins. I didn't hold seats for anonymous visitors, because identifying them by IP is unreliable: home and office Wi-Fi is shared, and many connections change IP often.
- **Up to 6 seats per person per event, on one shared countdown** started by the first seat. Seats added later expire at the same moment.
- **A hold never outlives the event's start**, and it can't be extended. After it expires, anyone can hold the seat again, including the same person.
- **Confirming is booking.** There is no payment step yet (see "Before launch").
- **Organizers can't hold or book seats.**
- **Organizer accounts come only from `prisma/seed.ts`.** Sign-up creates attendees only. The brief lists "sign up as an organizer" as existing behaviour, but self-service organizer sign-up lets anyone publish events, so I closed it. Organizers can still log in.
- **Bookings can be cancelled by their owner until the event starts.** Cancelling twice is not an error.
- **Passwords need 8 to 72 bytes.** bcrypt ignores anything past 72 bytes. Existing accounts keep working.
- **The server's clock is the judge** of whether a hold has expired. The UI countdown corrects for the browser's clock but only displays the time.
- **One server instance.** The sweeper runs in-process.

### What I changed and why

**Seat holds (new):**

- **Server:**
  - Redis locks and the shared countdown ([redis.ts](server/src/redis.ts)), with the hold service in [holdService.ts](server/src/services/holdService.ts).
  - Endpoints: `POST /holds`, `POST /holds/confirm`, `DELETE /holds/:id`, `GET /holds/mine`.
  - Direct booking (`POST /bookings`) now runs through the same lock, so it can't take a seat someone is holding.
  - Two migrations: the new enum values have their own migration because Postgres can't use an enum value in the transaction that adds it.
- **Event page:**
  - One tap holds a seat, and a pulse shows while the request runs.
  - Tapping your own seat asks before releasing it. A second tap within 0.8 seconds is ignored, so a double tap can't give a seat away.
  - The countdown corrects for the browser's clock. The seat map refreshes every 10 seconds, and older responses can't overwrite newer ones.
  - **Confirm Booking (N seats)** and **Release all** buttons; the sign-in pop-up and banner for logged-out visitors.
- **My Bookings:** a "Seats on hold" section with live countdowns.

**Security and correctness fixes:**

- **Double booking:** the Redis lock, plus the partial unique index on `CONFIRMED` bookings.
- **Cancelling other people's bookings:** cancel now checks ownership. Someone else's booking is a 404, so ids can't be probed. The response is the real result, not always `success: true`.
- **Self-service organizers:** sign-up now creates attendees only and refuses any other role with a 403.
- **Hardcoded, mismatched JWT secret:** there is one source ([config.ts](server/src/config.ts)) with no fallback, and the server refuses to start without a 32+ character secret. Signing and checking happen in one place with HS256 pinned, so `alg: none` and other-algorithm tokens are rejected. Docker generates a random secret into a volume on first start, so none is committed.
- **Crashes on bad input:**
  - Every async route goes through `asyncHandler`, and [routes.test.ts](server/test/routes.test.ts) fails if one doesn't.
  - Login and sign-up validate their input, and ids are bounds-checked.
  - All errors come back as JSON, with no Prisma internals.
  - Unknown routes get a JSON 404.
  - A process-level handler logs stray promise rejections instead of dying.
- **Unvalidated event input:** the price must be whole cents from 0 to 1,000,000; a `null` price used to quietly become a free event. Rows, columns, dates and text are checked too, in [eventInput.ts](server/src/utils/eventInput.ts). Booking never takes a price from the client; prices are always read from the event in the database.

**Other fixes:**

- "Seats left" no longer counts cancelled bookings.
- A missing event returns 404 instead of `200 { success: false }`, which used to leave the page spinning.
- `/bookings/mine` no longer hides errors as an empty list.
- My Bookings shows when a cancel failed, marks cancelled bookings, and only offers Cancel for upcoming confirmed ones.
- Signing in from an event page brings you back to that event; the return path only accepts same-site paths.
- The Create Event form explains bad input instead of showing raw JSON, and its preview can't freeze the page.

**Infrastructure:**

- Redis runs inside the compose network only, with no host port.
- It has `noeviction` (a hold is never dropped to save memory) and AOF persistence.
- The JWT secret lives in its own volume.

### What I'd still do before launch

**Needed before paying customers:**

- **Payments.** Confirming a hold should take payment, and each booking should store the price it was sold at, so a later price change can't alter what someone paid.
- **A production build.** Both Dockerfiles run dev servers (`tsx watch`, Vite dev). Production needs compiled output, a static client build, `NODE_ENV=production`, and a restart policy.
- **HTTPS and a restricted CORS origin.** Right now `cors()` allows every origin.
- **Rate limiting on login, sign-up and holds.** Limit mainly per account, with only generous per-IP limits because of the shared-Wi-Fi problem.
- **Handling expired sessions in the client.** On a 401 the app should clear the session and go to sign-in. Today the navbar still looks signed in, and actions say the session expired.
- **A way to add organizers:** an admin action or an invite, replacing the seed file.
- **Running the API tests in CI** (see "Weakest part").
- **Password reset.** It was out of scope for this task, but real users will need it.

**Next:**

- Store tokens in `httpOnly` cookies instead of `localStorage`.
- Push seat changes live with Server-Sent Events instead of polling every 10 seconds.
- Make the layout work on phones; pages use fixed 3-column grids.
- Clean up UI copy that isn't true:
  - "Total spent" counts cancelled bookings.
  - Upcoming events are labelled "LIVE NOW".
  - A 5% service fee is shown but never charged.
  - The home page claims "100% Satisfaction".
- Treat emails as case-insensitive.
- To run more than one server: move the sweeper to a single job and share `JWT_SECRET` across instances.
- Monitoring, alerts and database backups.

### The weakest part

The tests that prove the important guarantees aren't in the repo yet. The race tests (30 parallel holds and bookings on one seat, exactly one winner), the hold, cancel, sign-up, JWT and event-creation checks, and a 342-request bad-input fuzz were scripts I ran by hand against the running stack. One set lived in a temporary folder that got cleared, and I had to rewrite it. The 46 unit tests in `server/test` cover validation and the route-wrapping guard, but nothing stops a future change from quietly breaking the hold logic. Turning those scripts into integration tests that run against Postgres and Redis in CI is the first thing I'd do next.

### One place the AI was wrong

While writing the migration for the partial unique index, the AI told me Prisma can't describe partial indexes, so the next `prisma migrate dev` would generate a `DROP INDEX` for it and remove the double-booking guarantee. It put that warning in this README and in `schema.prisma`. I checked instead of trusting it: I ran `prisma migrate diff` from the migrations to the schema against a throwaway shadow database. The diff was empty, so Prisma 5.22 leaves the index alone. I corrected both notes.

Two smaller ones:

- **A bug in the AI's confirm code.** When a confirm lost to the database's unique index, it marked the hold released but left the Redis locks alive for 30 seconds, so the user was told "you already hold a seat" with nothing to show. A failure-path test caught it, and now a definite 409 or 410 releases the locks.
- **The AI's first hold UI.** It built select-then-press-Hold with one seat per event. I changed it to one tap per seat, several seats on a shared countdown, and a confirmation before releasing a seat.

### How I checked it works

- **Races:** 30 parallel holds, and separately 30 parallel bookings, on one seat. Exactly one 201 each time; every other request got 409, never 500. Inserting a second `CONFIRMED` row straight into Postgres is rejected by the index.
- **Hold lifecycle** (43 API checks):
  - Seats share one deadline, and the 7th seat is refused.
  - Another user, a direct booking and an anonymous visitor all see the seat as taken.
  - Confirm is all or nothing.
  - Release frees a seat at once.
  - Expiry, which I forced by shortening the Redis TTL, frees the seat immediately; a late confirm gets 410.
- **Fixes:** cancel ownership (21 checks), organizer sign-up (17), event and price validation (24), JWT (15). The JWT checks cover old-secret, wrong-secret, `alg: none`, HS512 and expired tokens; tokens surviving a server restart; and refusing to start without a secret.
- **Bad input:** before the fix, one `POST /auth/login` with `{}` took the API down. After it, 342 malformed requests across every route: the server stayed up, with no 500s and no leaked internals.
- **Failure paths:**
  - With Redis stopped, holds return 503 and browsing still works.
  - When the unique index fires inside a confirm, the user gets a clean 409.
  - `docker compose port redis 6379` shows nothing, so Redis isn't reachable from the host.
- **In the browser,** with two accounts:
  - logged-out pop-up → sign in → seat held automatically
  - one-tap holds on six seats with one timer
  - a double tap doesn't release
  - the release pop-up
  - the expiry message
  - a confirm booking five seats
  - cancel from My Bookings
- **Clean start:** `docker compose up --build` in a throwaway compose project, with empty volumes, after every infrastructure change. It runs the migrations, seeds the database, generates the secret, and logins work.
- **Unit tests:** `npm test` in `server`, 46 tests.

My conversations with the AI are in `ai-transcripts/`.

## Stack

- **server/**: Node, Express, TypeScript, Prisma, Postgres, Redis (seat holds)
- **client/**: React, Vite, TypeScript, Tailwind

## Run it

```bash
docker compose up --build
```

- App: http://localhost:5173
- API: http://localhost:4000
- Postgres: `localhost:5434` (user / password / db: `seatbook`)

- Redis: not exposed to the host. Only the server reaches it, at `redis://redis:6379` on the compose network. To look inside: `docker compose exec redis redis-cli`.
- JWT secret: none is committed. On first start the server generates a random one into the `server-secrets` volume and reuses it after restarts. To choose your own, set `JWT_SECRET` (32+ characters) in your shell or a root `.env` file. `docker compose down -v` deletes it, which logs everyone out.

The database is migrated and seeded on first start. To start from a clean database: `docker compose down -v`.

**After changing `schema.prisma`:** create the migration from your machine (`cd server && npx prisma migrate dev`, with `DATABASE_URL` pointing at `localhost:5434`), then `docker compose restart server`. The server regenerates the Prisma client and applies migrations on start.

### Seeded accounts

All passwords are `password123`.

| Email | Role |
|---|---|
| organizer@seatbook.test | Organizer |
| alice@seatbook.test | Attendee |
| bob@seatbook.test | Attendee |

### Without Docker

```bash
cd server
export DATABASE_URL=postgresql://seatbook:seatbook@localhost:5434/seatbook REDIS_URL=redis://localhost:6379 JWT_SECRET=$(openssl rand -hex 32)
npm install && npm run db:migrate && npm run db:seed && npm run dev
cd client && npm install && npm run dev
```

You need a Postgres at `DATABASE_URL` and a Redis at `REDIS_URL`. The server refuses to start without `JWT_SECRET` (or `JWT_SECRET_FILE`, a file it generates the secret into once); there is no built-in default.

## Scripts

| | server | client |
|---|---|---|
| `npm run dev` | API with reload | Vite dev server |
| `npm run typecheck` | `tsc --noEmit` | `tsc --noEmit` |
| `npm test` | Vitest | none yet |

## API

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/auth/register` | none | Create an attendee account, returns a token. Any other `role` is refused with 403; organizer accounts come only from `prisma/seed.ts` |
| POST | `/auth/login` | none | Log in, returns a token |
| GET | `/events` | none | List events with seats left |
| GET | `/events/:id` | none | One event with its seat map |
| POST | `/events` | organizer | Create an event and its seats |
| POST | `/holds` | attendee | Hold a seat (`{ seatId }`). Your first seat for an event starts a 10 minute countdown; later seats join it |
| GET | `/holds/mine` | attendee | Your live holds with their expiry |
| POST | `/holds/confirm` | attendee | Book every seat you hold for an event (`{ eventId }`), all or nothing |
| DELETE | `/holds/:id` | attendee | Release one held seat early |
| POST | `/bookings` | attendee | Book a seat straight away (a hold and its confirm in one request) |
| GET | `/bookings/mine` | attendee | Your bookings |
| POST | `/bookings/:id/cancel` | attendee | Cancel one of your own bookings, until the event starts. Cancelling twice is fine; anyone else's booking is a 404 |

Send the token as `Authorization: Bearer <token>`. `GET /events/:id` also accepts it, to mark the viewer's own hold.

## Seat holds

An attendee taps a free seat to hold it, and can tap more seats (up to 6 per event) to add them. All their seats share one 10 minute countdown, started by the first seat. Nobody else can hold or book those seats meanwhile. Confirming in time books them all at once; otherwise they go back on sale. Tapping a held seat asks before releasing it, so a double tap never gives a seat away.

- **Redis decides who holds a seat right now.** Holding sets a lock key per seat that expires by itself when the countdown ends, using `SET NX` inside a Lua script so racing requests get exactly one winner. A per-user hash per event keeps the shared deadline and the seat count.
- **Postgres records every hold and booking** (`HELD`, `CONFIRMED`, `EXPIRED`, `RELEASED`, `CANCELLED`) and has the final word: a partial unique index allows only one `CONFIRMED` booking per seat. A background sweeper marks finished holds `EXPIRED` in the database; seats free up the moment the Redis key expires, without waiting for it.
- **Holds need an account.** A logged-out visitor sees a banner, and tapping a seat opens a "Sign in to hold this seat" pop-up. The seat is only remembered in their browser. After signing in they come back to the event and the app tries to hold it; if someone signed in took it first, they're told so.
- If Redis is down, browsing still works but holding and booking return `503` instead of risking a double booking.

`HOLD_SECONDS` (default `600`) sets the countdown length and `HOLD_MAX_SEATS` (default `6`) the seats one user can hold per event.

**Schema note:** the partial unique index `Booking_seatId_confirmed_key` lives only in the migration SQL, since Prisma can't describe it in `schema.prisma`. Prisma 5.22 leaves it alone: `prisma migrate diff` from the migrations to the schema comes out empty. Check generated migrations for a `DROP INDEX` on it anyway if you upgrade Prisma.
