import { HttpError } from './http';

export const MAX_ROWS = 26; // seat labels use one letter per row
export const MAX_COLS = 30;
export const MAX_PRICE_CENTS = 1_000_000; // $10,000.00

export interface EventInput {
  title: string;
  description: string;
  venue: string;
  startsAt: Date;
  rows: number;
  cols: number;
  priceCents: number;
}

function requiredText(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${field} is required`);
  }
  if (value.trim().length > maxLength) {
    throw new HttpError(400, `${field} must be at most ${maxLength} characters`);
  }
  return value.trim();
}

function wholeNumber(value: unknown, message: string, min: number, max: number) {
  // typeof rules out strings like "1500": a client sending the wrong type is a bug to surface, not coerce.
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, message);
  }
  return value;
}

// Checks an organizer's new event before anything is stored. Every field is checked for type and
// range, so a bad request gets a 400 naming the field instead of a 500 or a silently changed value.
export function parseEventInput(body: unknown, now = new Date()): EventInput {
  const input = (body ?? {}) as Record<string, unknown>;

  const title = requiredText(input.title, 'Title', 200);
  const venue = requiredText(input.venue, 'Venue', 200);

  let description = '';
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string' || input.description.length > 5000) {
      throw new HttpError(400, 'Description must be text of at most 5000 characters');
    }
    description = input.description.trim();
  }

  const startsAt = typeof input.startsAt === 'string' ? new Date(input.startsAt) : new Date(NaN);
  if (Number.isNaN(startsAt.getTime())) {
    throw new HttpError(400, 'Start time must be a valid date');
  }
  if (startsAt <= now) {
    throw new HttpError(400, 'Start time must be in the future');
  }

  const rows = wholeNumber(input.rows, `Rows must be a whole number from 1 to ${MAX_ROWS}`, 1, MAX_ROWS);
  const cols = wholeNumber(input.cols, `Columns must be a whole number from 1 to ${MAX_COLS}`, 1, MAX_COLS);

  // Price is in cents (1500 = $15.00), so it must be a whole number. Leaving it out means a free
  // event; null, text, fractions and negatives are rejected rather than turned into $0.
  const priceCents =
    input.priceCents === undefined
      ? 0
      : wholeNumber(
          input.priceCents,
          `Price must be a whole number of cents from 0 to ${MAX_PRICE_CENTS} ($${MAX_PRICE_CENTS / 100})`,
          0,
          MAX_PRICE_CENTS
        );

  return { title, description, venue, startsAt, rows, cols, priceCents };
}
