import { Router } from 'express';
import { requireAuth, requireAttendee, AuthRequest } from '../middleware/auth';
import { confirmHolds, getMyHolds, holdSeat, releaseHold } from '../services/holdService';
import { asyncHandler, parseId } from '../utils/http';

const router = Router();

router.post(
  '/',
  requireAuth,
  requireAttendee,
  asyncHandler(async (req: AuthRequest, res) => {
    const hold = await holdSeat(req.user!.id, parseId(req.body?.seatId, 'seatId'));
    res.status(201).json({ ...hold, serverTime: new Date() });
  })
);

router.get(
  '/mine',
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    res.json({ holds: await getMyHolds(req.user!.id), serverTime: new Date() });
  })
);

// Books every seat the user holds for the event, all or nothing.
router.post(
  '/confirm',
  requireAuth,
  requireAttendee,
  asyncHandler(async (req: AuthRequest, res) => {
    const bookings = await confirmHolds(req.user!.id, parseId(req.body?.eventId, 'eventId'));
    res.json(bookings);
  })
);

router.delete(
  '/:id',
  requireAuth,
  asyncHandler(async (req: AuthRequest, res) => {
    await releaseHold(req.user!.id, parseId(req.params.id));
    res.status(204).end();
  })
);

export default router;
