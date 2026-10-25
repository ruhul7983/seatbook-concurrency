import { Router } from 'express';
import prisma from '../db';
import { requireAuth, optionalAuth, AuthRequest } from '../middleware/auth';
import { getEventWithSeats, listEvents } from '../services/eventService';
import { MAX_SEATS_PER_HOLD } from '../services/holdService';
import { formatPrice, seatLabel } from '../utils/helpers';
import { asyncHandler, HttpError, parseId } from '../utils/http';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await listEvents());
  })
);

router.get(
  '/:id',
  optionalAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    const result = await getEventWithSeats(parseId(req.params.id), req.user?.id);
    if (!result) {
      throw new HttpError(404, 'Event not found');
    }

    const { event, seats, myHolds, holdExpiresAt } = result;
    res.json({
      id: event.id,
      title: event.title,
      description: event.description,
      venue: event.venue,
      startsAt: event.startsAt,
      price: formatPrice(event.priceCents),
      rows: event.rows,
      cols: event.cols,
      organizer: event.organizer,
      seats,
      myHolds,
      holdExpiresAt,
      maxSeatsPerHold: MAX_SEATS_PER_HOLD,
      serverTime: new Date(),
    });
  })
);

router.post('/', requireAuth, async (req: AuthRequest, res) => {
  if (req.user!.role !== 'ORGANIZER') {
    return res.status(403).json({ error: 'Only organizers can create events' });
  }

  try {
    const { title, description, venue, startsAt, rows, cols, priceCents } = req.body;

    if (!title || !venue || !startsAt || !rows || !cols) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (rows > 26 || cols > 30) {
      return res.status(400).json({ msg: 'Seat grid too large (max 26 rows x 30 cols)' });
    }

    const seats = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        seats.push({ row: r, col: c, label: seatLabel(r, c) });
      }
    }

    const event = await prisma.event.create({
      data: {
        title,
        description: description || '',
        venue,
        startsAt: new Date(startsAt),
        rows,
        cols,
        priceCents: priceCents || 0,
        organizerId: req.user!.id,
        seats: { create: seats },
      },
    });

    res.status(201).json(event);
  } catch (err) {
    console.log(err);
    res.status(500).send('Something went wrong');
  }
});

export default router;
