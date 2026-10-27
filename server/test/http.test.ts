import { describe, it, expect } from 'vitest';
import { parseId, HttpError } from '../src/utils/http';

describe('parseId', () => {
  it.each([1, '1', '42', 2147483647, '2147483647'])('accepts %s', (value) => {
    expect(parseId(value)).toBe(Number(value));
  });

  it.each(['abc', '', ' ', '0', '-1', '1.5', '1abc', 'null', undefined, null, [], {}, '2147483648', '99999999999999999999', 1e20, NaN])(
    'rejects %s with a 400',
    (value) => {
      try {
        parseId(value);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
      }
    }
  );
});
