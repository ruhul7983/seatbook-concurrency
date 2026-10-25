import prisma from '../db';
import { formatPrice, isSeatBookable } from '../utils/helpers';
import { getHeldSeats, getMyHoldsForEvent } from './holdService';

export async function listEvents() {
  const events = await prisma.event.findMany({
    orderBy: { startsAt: 'asc' },
    include: { seats: { include: { bookings: { where: { status: 'CONFIRMED' } } } } },
  });

  const held = await getHeldSeats(events.flatMap((event) => event.seats));

  return events.map((event) => {
    const seatsLeft = event.seats.filter((seat) => isSeatBookable(seat, event) && !held.has(seat.id)).length;
    return {
      id: event.id,
      title: event.title,
      venue: event.venue,
      startsAt: event.startsAt,
      price: formatPrice(event.priceCents),
      totalSeats: event.seats.length,
      seatsLeft,
    };
  });
}

export type SeatStatus = 'available' | 'held' | 'heldByYou' | 'booked';

export async function getEventWithSeats(id: number, viewerId?: number) {
  const event = await prisma.event.findUnique({
    where: { id },
    include: {
      organizer: { select: { id: true, name: true } },
      seats: {
        orderBy: [{ row: 'asc' }, { col: 'asc' }],
        include: { bookings: { where: { status: 'CONFIRMED' } } },
      },
    },
  });
  if (!event) {
    return null;
  }

  const held = await getHeldSeats(event.seats);
  const myHolds = viewerId ? await getMyHoldsForEvent(viewerId, event.id, held) : [];
  const mySeatIds = new Set(myHolds.map((h) => h.seatId));

  const seats = event.seats.map((seat) => {
    let status: SeatStatus = 'available';
    if (seat.bookings.length > 0) status = 'booked';
    else if (mySeatIds.has(seat.id)) status = 'heldByYou';
    else if (held.has(seat.id)) status = 'held';

    return { id: seat.id, row: seat.row, col: seat.col, label: seat.label, status, available: status === 'available' };
  });

  // All of a user's seats on one event share a countdown, so any hold's expiry is the deadline.
  return { event, seats, myHolds, holdExpiresAt: myHolds[0]?.expiresAt ?? null };
}
