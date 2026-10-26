import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config';

export interface AuthUser {
  id: number;
  email: string;
  role: 'ORGANIZER' | 'ATTENDEE';
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

// Tokens are signed and checked only here, with the one secret from config.ts. The algorithm is
// pinned on both sides so a token can't pick a different one (such as "none").
const ALGORITHM = 'HS256';
const TOKEN_LIFETIME = '7d';

export function signToken(user: AuthUser) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: TOKEN_LIFETIME,
  });
}

function readToken(header: string | undefined): AuthUser | null {
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  try {
    const payload = jwt.verify(header.slice('Bearer '.length), JWT_SECRET, { algorithms: [ALGORITHM] }) as AuthUser;
    return { id: payload.id, email: payload.email, role: payload.role };
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const user = readToken(req.headers.authorization);
  if (!user) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
  req.user = user;
  next();
}

// For public routes that show more to a signed-in viewer. A missing or bad token just means anonymous.
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  req.user = readToken(req.headers.authorization) ?? undefined;
  next();
}

export function requireAttendee(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'ATTENDEE') {
    return res.status(403).json({ error: 'Only attendees can hold or book seats' });
  }
  next();
}
