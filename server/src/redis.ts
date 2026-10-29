import Redis, { Result } from 'ioredis';

// Each script runs atomically inside Redis, so no other command can land between its steps.
//
// Keys per event (the {event:N} hash tag keeps them in one slot, so multi-key scripts work on Redis Cluster):
//   hold:{event:N}:seat:S  string  token of the hold on seat S. Expires when the hold ends.
//   hold:{event:N}:user:U  hash    'deadline' = when user U's holds on this event end, plus one
//                                  field per held seat (seat id -> token). Expires at the deadline.
// Every seat a user adds joins the same deadline, so all their seats share one countdown.
//
// These keys are a fast filter in front of Postgres, not the source of truth (see holdService.ts).

// KEYS: seat key, user key. ARGV: token, seat id, deadline for a new countdown (ms), max seats.
// Returns {0, deadline} = held, {1} = seat already held by someone, {2} = user is at the seat limit.
const HOLD_SEAT = `
local deadline = redis.call('HGET', KEYS[2], 'deadline') or ARGV[3]
local seats = math.max(redis.call('HLEN', KEYS[2]) - 1, 0)
if seats >= tonumber(ARGV[4]) then return {2} end
if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PXAT', deadline) then return {1} end
redis.call('HSET', KEYS[2], 'deadline', deadline, ARGV[2], ARGV[1])
redis.call('PEXPIREAT', KEYS[2], deadline)
return {0, deadline}
`;

// KEYS: seat key, user key. ARGV: token, seat id.
// Deletes the locks only if they still belong to this token, so a late call can never release a
// hold someone else has taken since. When the user's last seat goes, their countdown ends too.
const RELEASE_HOLD = `
local deleted = 0
if redis.call('GET', KEYS[1]) == ARGV[1] then deleted = redis.call('DEL', KEYS[1]) end
if redis.call('HGET', KEYS[2], ARGV[2]) == ARGV[1] then
  redis.call('HDEL', KEYS[2], ARGV[2])
  if redis.call('HLEN', KEYS[2]) <= 1 then redis.call('DEL', KEYS[2]) end
end
return deleted
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    holdSeat(
      seatKey: string,
      userKey: string,
      token: string,
      seatId: number,
      newDeadlineMs: number,
      maxSeats: number
    ): Result<[number, string?], Context>;
    releaseHold(seatKey: string, userKey: string, token: string, seatId: number): Result<number, Context>;
  }
}

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // Fail fast while Redis is unreachable or slow instead of queueing or waiting, so holds fall
  // back to Postgres straight away.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 500,
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redis.defineCommand('holdSeat', { numberOfKeys: 2, lua: HOLD_SEAT });
redis.defineCommand('releaseHold', { numberOfKeys: 2, lua: RELEASE_HOLD });

export default redis;
