import { Request, Response, NextFunction } from 'express';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

// Express 4 does not catch rejected promises from async handlers, and an unhandled rejection
// kills the process. Wrapped handlers pass their errors to the error middleware in index.ts.
export function asyncHandler<R extends Request>(fn: (req: R, res: Response) => Promise<unknown>) {
  return (req: R, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function parseId(value: unknown, name = 'id'): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, `Invalid ${name}`);
  }
  return id;
}
