# Seatbook

Seat booking for small venues. Organizers publish an event with a seat grid, attendees pick a seat and book it.

## Stack

- **server/**: Node, Express, TypeScript, Prisma, Postgres, Redis (seat holds)
- **client/**: React, Vite, TypeScript, Tailwind

## Run it

```bash
docker compose up --build
```

- App: http://localhost:5173
- API: http://localhost:4000
- Postgres: `localhost:5433` (user / password / db: `seatbook`)

- Redis: not exposed to the host. Only the server reaches it, at `redis://redis:6379` on the compose network. To look inside: `docker compose exec redis redis-cli`.

The database is migrated and seeded on first start. To start from a clean database: `docker compose down -v`.

**After changing `schema.prisma`:** create the migration from your machine (`cd server && npx prisma migrate dev`, with `DATABASE_URL` pointing at `localhost:5433`), then `docker compose restart server`. The server regenerates the Prisma client and applies migrations on start.

### Seeded accounts

All passwords are `password123`.

| Email | Role |
|---|---|
| organizer@seatbook.test | Organizer |
| alice@seatbook.test | Attendee |
| bob@seatbook.test | Attendee |

### Without Docker

```bash
cd server && cp .env.example .env && npm install && npm run db:migrate && npm run db:seed && npm run dev
cd client && npm install && npm run dev
```

You need a Postgres running at the `DATABASE_URL` in `server/.env`, and a Redis at `REDIS_URL` (default `redis://localhost:6379`).

## Scripts

| | server | client |
|---|---|---|
| `npm run dev` | API with reload | Vite dev server |
| `npm run typecheck` | `tsc --noEmit` | `tsc --noEmit` |
| `npm test` | Vitest | none yet |

## API

| Method | Path | Auth | What it does |
|---|---|---|---|
| POST | `/auth/register` | none | Create an account, returns a token |
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
| POST | `/bookings/:id/cancel` | attendee | Cancel a booking |

Send the token as `Authorization: Bearer <token>`. `GET /events/:id` also accepts it, to mark the viewer's own hold.

## Seat holds

An attendee taps a free seat to hold it, and can tap more seats (up to 6 per event) to add them. All their seats share one 10 minute countdown, started by the first seat. Nobody else can hold or book those seats meanwhile. Confirming in time books them all at once; otherwise they go back on sale. Tapping a held seat asks before releasing it, so a double tap never gives a seat away.

- **Redis decides who holds a seat right now.** Holding sets a lock key per seat that expires by itself when the countdown ends, using `SET NX` inside a Lua script so racing requests get exactly one winner. A per-user hash per event keeps the shared deadline and the seat count.
- **Postgres records every hold and booking** (`HELD`, `CONFIRMED`, `EXPIRED`, `RELEASED`, `CANCELLED`) and has the final word: a partial unique index allows only one `CONFIRMED` booking per seat. A background sweeper marks finished holds `EXPIRED` in the database; seats free up the moment the Redis key expires, without waiting for it.
- **Holds need an account.** A logged-out visitor sees a banner, and tapping a seat opens a "Sign in to hold this seat" pop-up. The seat is only remembered in their browser. After signing in they come back to the event and the app tries to hold it; if someone signed in took it first, they're told so.
- If Redis is down, browsing still works but holding and booking return `503` instead of risking a double booking.

`HOLD_SECONDS` (default `600`) sets the countdown length and `HOLD_MAX_SEATS` (default `6`) the seats one user can hold per event.

**Schema note:** the partial unique index `Booking_seatId_confirmed_key` lives only in the migration SQL, since Prisma can't describe it in `schema.prisma`. Prisma 5.22 leaves it alone: `prisma migrate diff` from the migrations to the schema comes out empty. Check generated migrations for a `DROP INDEX` on it anyway if you upgrade Prisma.
