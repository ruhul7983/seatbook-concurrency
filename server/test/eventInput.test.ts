import { describe, it, expect } from 'vitest';
import { parseEventInput } from '../src/utils/eventInput';
import { HttpError } from '../src/utils/http';

const now = new Date('2026-10-26T12:00:00Z');
const valid = {
  title: 'Postgres in Practice',
  description: 'An evening talk',
  venue: 'Banani Hall',
  startsAt: '2026-11-01T12:30:00Z',
  rows: 5,
  cols: 8,
  priceCents: 1500,
};

function errorFor(body: unknown) {
  try {
    parseEventInput(body, now);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    return (err as HttpError).message;
  }
  throw new Error('expected a 400');
}

describe('parseEventInput', () => {
  it('accepts a valid event', () => {
    const input = parseEventInput(valid, now);
    expect(input).toMatchObject({ title: 'Postgres in Practice', rows: 5, cols: 8, priceCents: 1500 });
    expect(input.startsAt.toISOString()).toBe('2026-11-01T12:30:00.000Z');
  });

  it('treats a missing price as a free event', () => {
    const { priceCents, ...rest } = valid;
    expect(parseEventInput(rest, now).priceCents).toBe(0);
    expect(parseEventInput({ ...valid, priceCents: 0 }, now).priceCents).toBe(0);
  });

  it.each([
    ['negative', -100],
    ['fractional cents', 1500.5],
    ['a string', '1500'],
    ['null', null],
    ['NaN', NaN],
    ['over the maximum', 1_000_001],
  ])('rejects a price that is %s', (_, priceCents) => {
    expect(errorFor({ ...valid, priceCents })).toMatch(/^Price/);
  });

  it.each([
    ['rows', 0],
    ['rows', 27],
    ['rows', 2.5],
    ['rows', '5'],
    ['cols', -1],
    ['cols', 31],
  ])('rejects %s = %s', (field, value) => {
    expect(errorFor({ ...valid, [field]: value })).toMatch(field === 'rows' ? /^Rows/ : /^Columns/);
  });

  it('rejects missing or blank text fields', () => {
    expect(errorFor({ ...valid, title: '   ' })).toBe('Title is required');
    expect(errorFor({ ...valid, venue: undefined })).toBe('Venue is required');
    expect(errorFor({ ...valid, title: 'x'.repeat(201) })).toMatch(/at most 200/);
  });

  it('rejects bad or past start times', () => {
    expect(errorFor({ ...valid, startsAt: 'not a date' })).toBe('Start time must be a valid date');
    expect(errorFor({ ...valid, startsAt: 1767225600000 })).toBe('Start time must be a valid date');
    expect(errorFor({ ...valid, startsAt: '2026-10-01T00:00:00Z' })).toBe('Start time must be in the future');
  });

  it('rejects an empty body', () => {
    expect(errorFor(undefined)).toBe('Title is required');
  });
});
