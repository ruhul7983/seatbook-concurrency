import { Router } from 'express';
import prisma from '../db';
import { requireAuth, requireAttendee, AuthRequest } from '../middleware/auth';
import { confirmHolds, holdSeat } from '../services/holdService';
import { formatPrice } from '../utils/helpers';
import { asyncHandler, HttpError, parseId } from '../utils/http';

const router = Router();

// Book straight away: a hold and its confirm in one request, so it takes the same seat lock
// as the hold flow and can never book a seat someone else is holding.
router.post(
  '/',
  requireAuth,
  requireAttendee,
  asyncHandler(async (req: AuthRequest, res) => {
    const hold = await holdSeat(req.user!.id, parseId(req.body?.seatId, 'seatId'));
    const [booking] = await confirmHolds(req.user!.id, hold.eventId, [hold.holdId]);
    res.status(201).json(booking);
  })
);

router.get('/mine', requireAuth, async (req: AuthRequest, res) => {
  try {
    const bookings = await prisma.booking.findMany({
      where: { userId: req.user!.id, status: { in: ['CONFIRMED', 'CANCELLED'] } },
      orderBy: { createdAt: 'desc' },
      include: { seat: { include: { event: true } } },
    });

    res.json(
      bookings.map((b) => ({
        id: b.id,
        status: b.status,
        createdAt: b.createdAt,
        seat: b.seat.label,
        event: {
          id: b.seat.event.id,
          title: b.seat.event.title,
          venue: b.seat.event.venue,
          startsAt: b.seat.event.startsAt,
          price: formatPrice(b.seat.event.priceCents),
        },
      }))
    );
  } catch (err) {
    console.log(err);
    res.json([]);
  }
});

router.post(
  '/:id/cancel',
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const id = parseId(req.params.id);
    const userId = req.user!.id;

    // Someone else's booking gets the same 404 as a missing one, so ids can't be probed.
    const booking = await prisma.booking.findFirst({
      where: { id, userId },
      include: { seat: { include: { event: true } } },
    });
    if (!booking || !['CONFIRMED', 'CANCELLED'].includes(booking.status)) {
      throw new HttpError(404, 'Booking not found');
    }

    // Cancelling twice (a double click, a retry) is not an error.
    if (booking.status === 'CANCELLED') {
      return res.json({ id, status: booking.status, cancelledAt: booking.cancelledAt });
    }
    if (booking.seat.event.startsAt <= new Date()) {
      throw new HttpError(400, 'This event has already started, so the booking can no longer be cancelled');
    }

    // If a parallel request cancels it first this matches nothing, and the booking is cancelled either way.
    await prisma.booking.updateMany({
      where: { id, userId, status: 'CONFIRMED' },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    const cancelled = await prisma.booking.findUniqueOrThrow({ where: { id } });

    res.json({ id, status: cancelled.status, cancelledAt: cancelled.cancelledAt });
  })
);

export default router;
