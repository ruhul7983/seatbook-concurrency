import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import redis from '../redis';
import { HttpError } from '../utils/http';

// Postgres decides who holds a seat. Every hold and every confirm runs in a transaction that locks
// the seat's row and then looks for a live claim: a CONFIRMED booking, or a HELD booking whose
// expiresAt is still ahead. That alone keeps one owner per seat, whether Redis is up or not.
//
// Redis sits in front as a fast filter when it is up. A hold first takes a Redis lock (SET NX that
// expires at the deadline), so when many people tap the same seat the losers are turned away after
// one cheap read instead of queueing for the row lock. If Redis is down or slow, holds skip it and
// go straight to the transaction: slower under a burst, but never wrong, and nothing stops working.
//
// A user can hold several seats of one event. They all share one countdown, started by the first
// seat: seats added later expire at the same moment.

export const HOLD_MS = Number(process.env.HOLD_SECONDS || 600) * 1000;
export const MAX_SEATS_PER_HOLD = Number(process.env.HOLD_MAX_SEATS || 6);
// A confirm that arrives just after the countdown ends still succeeds if nobody has taken the seat
// in the meantime, so a click in the last second isn't lost to network delay.
const CONFIRM_GRACE_MS = 5_000;
// The sweeper leaves rows alone for this long past expiry, so it never races a confirm in progress.
const SWEEP_GRACE_MS = 60_000;
const SWEEP_EVERY_MS = 30_000;

const HOLD_RESULT = { HELD: 0, SEAT_TAKEN: 1, SEAT_LIMIT: 2 } as const;

function seatKey(eventId: number, seatId: number) {
  return `hold:{event:${eventId}}:seat:${seatId}`;
}

function userKey(eventId: number, userId: number) {
  return `hold:{event:${eventId}}:user:${userId}`;
}

// After a Redis failure, skip it for this long instead of waiting on it in every request.
const REDIS_RETRY_AFTER_MS = 2_000;
let redisDownSince: number | null = null;

// Runs a Redis command, or returns undefined if Redis is unreachable, so the caller carries on
// with Postgres alone. Logs once when Redis goes away and once when it comes back.
async function tryRedis<T>(command: () => Promise<T>): Promise<T | undefined> {
  if (redisDownSince !== null && Date.now() - redisDownSince < REDIS_RETRY_AFTER_MS) {
    return undefined;
  }
  try {
    const result = await command();
    if (redisDownSince !== null) {
      redisDownSince = null;
      console.log('Redis is back: seat holds use it again');
    }
    return result;
  } catch (err) {
    if (redisDownSince === null) {
      console.warn('Redis unavailable, seat holds fall back to the database:', (err as Error).message);
    }
    redisDownSince = Date.now();
    return undefined;
  }
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function liveClaim(now: Date): Prisma.BookingWhereInput {
  return { OR: [{ status: 'CONFIRMED' }, { status: 'HELD', expiresAt: { gt: now } }] };
}

function claimMessage(claim: { status: string; userId: number }, userId: number) {
  if (claim.status === 'CONFIRMED') return 'Seat already booked';
  return claim.userId === userId ? 'You already hold this seat' : 'Someone else is holding this seat';
}

interface HoldLock {
  seatId: number;
  userId: number;
  holdToken: string | null;
}

function releaseLocks(eventId: number, hold: HoldLock) {
  return tryRedis(() =>
    redis.releaseHold(seatKey(eventId, hold.seatId), userKey(eventId, hold.userId), hold.holdToken!, hold.seatId)
  );
}

export async function holdSeat(userId: number, seatId: number) {
  const seat = await prisma.seat.findUnique({ where: { id: seatId }, include: { event: true } });
  if (!seat) {
    throw new HttpError(404, 'Seat not found');
  }

  const now = Date.now();
  const startsAt = seat.event.startsAt.getTime();
  if (startsAt <= now) {
    throw new HttpError(400, 'This event has already started');
  }

  const eventId = seat.eventId;
  const token = randomUUID();
  // Used only if this is the user's first seat for the event; otherwise the running countdown is
  // kept. Either way a hold never outlives the event's start.
  const newDeadline = Math.min(now + HOLD_MS, startsAt);

  // Fast path. A "no" from Redis is checked against Postgres before it counts: after an outage Redis
  // can still hold locks for holds that were released or expired while it was unreachable.
  const fast = await tryRedis(() =>
    redis.holdSeat(seatKey(eventId, seatId), userKey(eventId, userId), token, seatId, newDeadline, MAX_SEATS_PER_HOLD)
  );
  if (fast?.[0] === HOLD_RESULT.SEAT_TAKEN) {
    const claim = await prisma.booking.findFirst({
      where: { seatId, ...liveClaim(new Date()) },
      select: { status: true, userId: true },
    });
    if (claim) {
      throw new HttpError(409, claimMessage(claim, userId));
    }
  }
  if (fast?.[0] === HOLD_RESULT.SEAT_LIMIT) {
    const mine = await prisma.booking.count({
      where: { userId, status: 'HELD', expiresAt: { gt: new Date() }, seat: { eventId } },
    });
    if (mine >= MAX_SEATS_PER_HOLD) {
      throw new HttpError(409, `You can hold up to ${MAX_SEATS_PER_HOLD} seats at a time`);
    }
  }
  const lockedInRedis = fast?.[0] === HOLD_RESULT.HELD;

  try {
    const hold = await prisma.$transaction(async (tx) => {
      // The user's row lock makes parallel taps on different seats take turns, so they can't go over
      // the limit or start two countdowns. Locks are always taken user first, then seat.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Seat" WHERE id = ${seatId} FOR UPDATE`;

      const txNow = new Date();
      const claim = await tx.booking.findFirst({
        where: { seatId, ...liveClaim(txNow) },
        select: { status: true, userId: true },
      });
      if (claim) {
        throw new HttpError(409, claimMessage(claim, userId));
      }

      const mine = await tx.booking.findMany({
        where: { userId, status: 'HELD', expiresAt: { gt: txNow }, seat: { eventId } },
        orderBy: { expiresAt: 'asc' },
        select: { expiresAt: true },
      });
      if (mine.length >= MAX_SEATS_PER_HOLD) {
        throw new HttpError(409, `You can hold up to ${MAX_SEATS_PER_HOLD} seats at a time`);
      }

      // Join the running countdown if there is one. Postgres's deadline wins over the one Redis
      // returned: they only differ if Redis lost its data.
      const expiresAt = mine[0]?.expiresAt ?? new Date(lockedInRedis ? Number(fast![1]) : newDeadline);
      return tx.booking.create({ data: { seatId, userId, status: 'HELD', holdToken: token, expiresAt } });
    });

    const expiresAt = hold.expiresAt!;
    if (!lockedInRedis || Number(fast![1]) !== expiresAt.getTime()) {
      // Put Redis back in line with Postgres: this replaces a stale lock, or sets one if Redis was
      // skipped, so the fast path is accurate again. Best effort, like every Redis write here.
      await tryRedis(() => redis.set(seatKey(eventId, seatId), token, 'PXAT', expiresAt.getTime()));
    }

    return { holdId: hold.id, seatId, label: seat.label, eventId, expiresAt };
  } catch (err) {
    if (lockedInRedis) {
      await releaseLocks(eventId, { seatId, userId, holdToken: token });
    }
    throw err;
  }
}

// Confirms the user's live holds on an event, all or nothing. `holdIds` narrows it to some of them.
export async function confirmHolds(userId: number, eventId: number, holdIds?: number[]) {
  const holds = await prisma.booking.findMany({
    where: {
      userId,
      status: 'HELD',
      expiresAt: { gt: new Date(Date.now() - CONFIRM_GRACE_MS) },
      seat: { eventId },
      ...(holdIds ? { id: { in: holdIds } } : {}),
    },
    include: { seat: true },
    orderBy: { id: 'asc' },
  });
  if (holds.length === 0) {
    throw new HttpError(410, 'You have no seats on hold for this event. Your hold may have expired.');
  }

  const ids = holds.map((h) => h.id);
  const seatIds = holds.map((h) => h.seatId);
  try {
    await prisma.$transaction(async (tx) => {
      // Same seat row locks as a hold, so a hold on one of these seats waits for this confirm and
      // then sees it as booked. ORDER BY keeps lock order fixed, so two confirms can't deadlock.
      await tx.$queryRaw`SELECT id FROM "Seat" WHERE id IN (${Prisma.join(seatIds)}) ORDER BY id FOR UPDATE`;

      const now = new Date();
      const taken = await tx.booking.findFirst({
        where: { seatId: { in: seatIds }, id: { notIn: ids }, ...liveClaim(now) },
        include: { seat: true },
      });
      if (taken) {
        throw new HttpError(409, `Seat ${taken.seat.label} was taken after your hold ended. Please pick your seats again.`);
      }

      const updated = await tx.booking.updateMany({
        where: { id: { in: ids }, userId, status: 'HELD', expiresAt: { gt: new Date(now.getTime() - CONFIRM_GRACE_MS) } },
        data: { status: 'CONFIRMED', confirmedAt: now },
      });
      if (updated.count !== ids.length) {
        throw new HttpError(410, 'Some of your holds have ended. Check your seats and confirm again.');
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The seat row lock should make this impossible; the unique index is the last line of defence.
      await prisma.booking.updateMany({ where: { id: { in: ids }, status: 'HELD' }, data: { status: 'RELEASED' } });
      await Promise.all(holds.map((h) => releaseLocks(eventId, h)));
      throw new HttpError(409, 'Someone else already booked one of these seats. Please pick your seats again.');
    }
    throw err;
  }

  await Promise.all(holds.map((h) => releaseLocks(eventId, h)));

  return prisma.booking.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' } });
}

export async function releaseHold(userId: number, holdId: number) {
  const hold = await prisma.booking.findFirst({
    where: { id: holdId, userId, status: 'HELD' },
    include: { seat: true },
  });
  if (!hold) {
    throw new HttpError(404, 'Hold not found');
  }

  // Postgres first: once the row says RELEASED the seat is free, whatever happens to the Redis lock.
  const released = await prisma.booking.updateMany({ where: { id: holdId, status: 'HELD' }, data: { status: 'RELEASED' } });
  if (released.count === 0) {
    throw new HttpError(404, 'Hold not found');
  }
  await releaseLocks(hold.seat.eventId, hold);
}

export async function getMyHolds(userId: number) {
  const holds = await prisma.booking.findMany({
    where: { userId, status: 'HELD', expiresAt: { gt: new Date() } },
    orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    include: { seat: { include: { event: true } } },
  });

  return holds.map((h) => ({
    holdId: h.id,
    seatId: h.seatId,
    label: h.seat.label,
    expiresAt: h.expiresAt,
    event: {
      id: h.seat.event.id,
      title: h.seat.event.title,
      venue: h.seat.event.venue,
      startsAt: h.seat.event.startsAt,
    },
  }));
}

export async function getMyHoldsForEvent(userId: number, eventId: number) {
  const holds = await prisma.booking.findMany({
    where: { userId, status: 'HELD', expiresAt: { gt: new Date() }, seat: { eventId } },
    include: { seat: true },
    orderBy: { id: 'asc' },
  });

  return holds.map((h) => ({ holdId: h.id, seatId: h.seatId, label: h.seat.label, expiresAt: h.expiresAt }));
}

// Seat id -> id of the user holding it right now. Read from Postgres, so seat maps stay right
// while Redis is down.
export async function getHeldSeats(seatIds: number[]): Promise<Map<number, number>> {
  const held = new Map<number, number>();
  if (seatIds.length === 0) {
    return held;
  }

  const holds = await prisma.booking.findMany({
    where: { seatId: { in: seatIds }, status: 'HELD', expiresAt: { gt: new Date() } },
    select: { seatId: true, userId: true },
  });
  holds.forEach((h) => held.set(h.seatId, h.userId));
  return held;
}

// A hold ends the moment its expiresAt passes; every check above compares against it. This only
// tidies the records so finished holds read as EXPIRED.
export function startHoldSweeper() {
  const timer = setInterval(() => {
    prisma.booking
      .updateMany({
        where: { status: 'HELD', expiresAt: { lt: new Date(Date.now() - SWEEP_GRACE_MS) } },
        data: { status: 'EXPIRED' },
      })
      .catch((err) => console.error('Hold sweep failed:', err));
  }, SWEEP_EVERY_MS);
  timer.unref();
}
