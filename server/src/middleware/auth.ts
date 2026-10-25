import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'seatbook-secret-123';

export interface AuthUser {
  id: number;
  email: string;
  role: 'ORGANIZER' | 'ATTENDEE';
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const token = header.replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
}

// For public routes that show more to a signed-in viewer. A missing or bad token just means anonymous.
export function optionalAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header) {
    try {
      req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET) as AuthUser;
    } catch {
      req.user = undefined;
    }
  }
  next();
}

export function requireAttendee(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'ATTENDEE') {
    return res.status(403).json({ error: 'Only attendees can hold or book seats' });
  }
  next();
}
