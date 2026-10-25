import { Router } from 'express';
import prisma from '../db';
import { requireAuth, requireAttendee, AuthRequest } from '../middleware/auth';
import { confirmHolds, holdSeat } from '../services/holdService';
import { formatPrice } from '../utils/helpers';
import { asyncHandler, parseId } from '../utils/http';

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

router.post('/:id/cancel', requireAuth, async (req: AuthRequest, res) => {
  const id = parseInt(req.params.id);

  await prisma.booking.updateMany({
    where: { id, status: 'CONFIRMED' },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  res.json({ success: true });
});

export default router;
