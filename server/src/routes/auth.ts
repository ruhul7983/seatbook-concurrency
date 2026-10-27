import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../db';
import { signToken } from '../middleware/auth';
import { asyncHandler, HttpError } from '../utils/http';

const router = Router();

// bcrypt only reads the first 72 bytes of a password, so anything longer would be silently cut.
const MAX_PASSWORD_BYTES = 72;
const MIN_PASSWORD_LENGTH = 8;

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function publicUser(user: { id: number; email: string; name: string; role: string }) {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { password, role } = req.body ?? {};
    const email = text(req.body?.email);
    const name = text(req.body?.name);

    if (!email || !name || typeof password !== 'string' || !password) {
      throw new HttpError(400, 'email, password and name are required');
    }

    // Sign-up only ever makes attendees. Organizer accounts are created in prisma/seed.ts, never
    // through the API. Asking for any other role is refused rather than silently ignored.
    if (role !== undefined && role !== 'ATTENDEE') {
      throw new HttpError(403, 'Organizer accounts cannot be created through sign-up');
    }

    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, 'Enter a valid email address');
    }
    if (name.length > 100) {
      throw new HttpError(400, 'Name must be at most 100 characters');
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) {
      throw new HttpError(400, `Password must be at most ${MAX_PASSWORD_BYTES} bytes`);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    let user;
    try {
      user = await prisma.user.create({ data: { email, name, passwordHash, role: 'ATTENDEE' } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError(409, 'An account with this email already exists');
      }
      throw err;
    }

    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { password } = req.body ?? {};
    const email = text(req.body?.email);

    if (!email || typeof password !== 'string' || !password) {
      throw new HttpError(400, 'Email and password are required');
    }

    const user = await prisma.user.findUnique({ where: { email } });
    // Too-long passwords can't match any account, and bcrypt would only compare their first 72 bytes.
    const ok =
      user !== null && Buffer.byteLength(password) <= MAX_PASSWORD_BYTES && (await bcrypt.compare(password, user.passwordHash));
    if (!user || !ok) {
      throw new HttpError(401, 'Invalid credentials');
    }

    res.json({ token: signToken(user), user: publicUser(user) });
  })
);

export default router;
