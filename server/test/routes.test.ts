import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Express 4 does not catch a rejected promise from an async handler, and an unhandled rejection
// used to take the whole server down. Every async handler in a router must go through asyncHandler,
// which hands its errors to the error middleware. This fails if one is added without it.
const routesDir = join(__dirname, '../src/routes');

describe('route handlers', () => {
  const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));

  it('finds the route files', () => {
    expect(files).toEqual(expect.arrayContaining(['auth.ts', 'bookings.ts', 'events.ts', 'holds.ts']));
  });

  it.each(files)('%s wraps every async handler in asyncHandler', (file) => {
    const source = readFileSync(join(routesDir, file), 'utf8');
    const asyncHandlers = source.match(/async \(/g) ?? [];
    const wrapped = source.match(/asyncHandler\(async \(/g) ?? [];
    expect(asyncHandlers.length).toBeGreaterThan(0);
    expect(wrapped.length).toBe(asyncHandlers.length);
  });
});
