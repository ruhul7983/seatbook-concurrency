import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import redis from '../redis';
import { HttpError } from '../utils/http';

// Who holds a seat right now is decided by Redis: a lock key that expires on its own when the hold
// ends. Postgres keeps the record of every hold (HELD, then CONFIRMED / EXPIRED / RELEASED) and is
// the final word on confirmed bookings through a unique index.
//
// A user can hold several seats of one event. They all share one countdown, started by the first
// seat: seats added later expire at the same moment.

export const HOLD_MS = Number(process.env.HOLD_SECONDS || 600) * 1000;
export const MAX_SEATS_PER_HOLD = Number(process.env.HOLD_MAX_SEATS || 6);
// How long the seat locks survive once a confirm has started, so the database write can finish
// even if the confirm arrives in the hold's last second.
const CONFIRM_GRACE_MS = 30_000;
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

async function withRedis<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (err) {
    console.error('Redis command failed:', err);
    throw new HttpError(503, 'Seat holds are unavailable right now. Please try again shortly.');
  }
}

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

interface HoldLock {
  seatId: number;
  userId: number;
  holdToken: string | null;
}

function releaseLocks(eventId: number, hold: HoldLock) {
  return redis
    .releaseHold(seatKey(eventId, hold.seatId), userKey(eventId, hold.userId), hold.holdToken!, hold.seatId)
    .catch((err) => console.error('Releasing hold locks failed:', err));
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

  const token = randomUUID();
  // Used only if this is the user's first seat for the event; otherwise Redis keeps their running
  // countdown. Either way a hold never outlives the event's start.
  const newDeadline = Math.min(now + HOLD_MS, startsAt);

  const [result, deadline] = await withRedis(() =>
    redis.holdSeat(seatKey(seat.eventId, seatId), userKey(seat.eventId, userId), token, seatId, newDeadline, MAX_SEATS_PER_HOLD)
  );
  if (result === HOLD_RESULT.SEAT_LIMIT) {
    throw new HttpError(409, `You can hold up to ${MAX_SEATS_PER_HOLD} seats at a time`);
  }
  if (result === HOLD_RESULT.SEAT_TAKEN) {
    throw new HttpError(409, 'Someone else is holding this seat');
  }

  const expiresAt = new Date(Number(deadline));
  try {
    // Checked after taking the lock: a confirm writes CONFIRMED before it deletes its lock,
    // so once we hold the lock this read cannot miss a booking.
    const booked = await prisma.booking.findFirst({
      where: { seatId, status: 'CONFIRMED' },
      select: { id: true },
    });
    if (booked) {
      throw new HttpError(409, 'Seat already booked');
    }

    const hold = await prisma.booking.create({
      data: { seatId, userId, status: 'HELD', holdToken: token, expiresAt },
    });

    return { holdId: hold.id, seatId, label: seat.label, eventId: seat.eventId, expiresAt };
  } catch (err) {
    await releaseLocks(seat.eventId, { seatId, userId, holdToken: token });
    throw err;
  }
}

// Confirms the user's live holds on an event, all or nothing. `holdIds` narrows it to some of them.
export async function confirmHolds(userId: number, eventId: number, holdIds?: number[]) {
  const holds = await prisma.booking.findMany({
    where: {
      userId,
      status: 'HELD',
      expiresAt: { gt: new Date() },
      seat: { eventId },
      ...(holdIds ? { id: { in: holdIds } } : {}),
    },
    include: { seat: true },
    orderBy: { id: 'asc' },
  });
  if (holds.length === 0) {
    throw new HttpError(410, 'You have no seats on hold for this event. Your hold may have expired.');
  }

  const keys = holds.map((h) => seatKey(eventId, h.seatId));
  const tokens = holds.map((h) => h.holdToken!);
  const lost = await withRedis(() => redis.beginConfirm(keys.length, ...keys, ...tokens, CONFIRM_GRACE_MS));
  if (lost > 0) {
    const gone = holds[lost - 1];
    await prisma.booking.updateMany({ where: { id: gone.id, status: 'HELD' }, data: { status: 'EXPIRED' } });
    await releaseLocks(eventId, gone);
    throw new HttpError(410, `Your hold on ${gone.seat.label} has ended. Check your seats and confirm again.`);
  }

  const ids = holds.map((h) => h.id);
  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id: { in: ids }, userId, status: 'HELD' },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      if (updated.count !== ids.length) {
        throw new HttpError(410, 'Some of your holds have ended. Check your seats and confirm again.');
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Only possible if Redis lost a lock and someone else booked the seat meanwhile.
      await prisma.booking.updateMany({ where: { id: { in: ids }, status: 'HELD' }, data: { status: 'RELEASED' } });
      await Promise.all(holds.map((h) => releaseLocks(eventId, h)));
      throw new HttpError(409, 'Someone else already booked one of these seats. Please pick your seats again.');
    }
    // Any other error keeps the locks for the grace period, so a retry can still succeed.
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
  if (!hold || !hold.holdToken) {
    throw new HttpError(404, 'Hold not found');
  }

  await withRedis(() =>
    redis.releaseHold(seatKey(hold.seat.eventId, hold.seatId), userKey(hold.seat.eventId, userId), hold.holdToken!, hold.seatId)
  );
  await prisma.booking.updateMany({ where: { id: holdId, status: 'HELD' }, data: { status: 'RELEASED' } });
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

// The viewer's live holds on this event that the Redis locks still back.
export async function getMyHoldsForEvent(userId: number, eventId: number, heldTokens: Map<number, string>) {
  const holds = await prisma.booking.findMany({
    where: { userId, status: 'HELD', expiresAt: { gt: new Date() }, seat: { eventId } },
    include: { seat: true },
    orderBy: { id: 'asc' },
  });

  return holds
    .filter((h) => heldTokens.get(h.seatId) === h.holdToken)
    .map((h) => ({ holdId: h.id, seatId: h.seatId, label: h.seat.label, expiresAt: h.expiresAt }));
}

// Seat id -> token of whoever holds it right now. Reads fail soft: if Redis is down the seat map
// still renders (from the database alone) and holding a seat returns 503.
export async function getHeldSeats(seats: { id: number; eventId: number }[]): Promise<Map<number, string>> {
  const held = new Map<number, string>();
  if (seats.length === 0) {
    return held;
  }

  try {
    const tokens = await redis.mget(seats.map((s) => seatKey(s.eventId, s.id)));
    tokens.forEach((token, i) => {
      if (token) held.set(seats[i].id, token);
    });
  } catch (err) {
    console.error('Reading seat holds failed:', err);
  }
  return held;
}

// Redis frees the seat the moment a hold expires. This only tidies the database records.
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
