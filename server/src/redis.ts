import Redis, { Result } from 'ioredis';

// Each script runs atomically inside Redis, so no other command can land between its steps.
//
// Keys per event (the {event:N} hash tag keeps them in one slot, so multi-key scripts work on Redis Cluster):
//   hold:{event:N}:seat:S  string  token of the hold on seat S. Expires when the hold ends.
//   hold:{event:N}:user:U  hash    'deadline' = when user U's holds on this event end, plus one
//                                  field per held seat (seat id -> token). Expires at the deadline.
// Every seat a user adds joins the same deadline, so all their seats share one countdown.

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

// KEYS: seat keys. ARGV: their tokens, in the same order, then the grace period (ms).
// Claims every hold for confirmation: if all tokens still own their seats, each lock is kept for at
// least the grace period so the database write can finish. Returns 0, or the 1-based index of the
// first seat whose hold is gone (nothing is changed in that case).
const BEGIN_CONFIRM = `
local grace = tonumber(ARGV[#ARGV])
for i = 1, #KEYS do
  if redis.call('GET', KEYS[i]) ~= ARGV[i] then return i end
end
for i = 1, #KEYS do
  if redis.call('PTTL', KEYS[i]) < grace then redis.call('PEXPIRE', KEYS[i], grace) end
end
return 0
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
    beginConfirm(numKeys: number, ...keysThenArgs: (string | number)[]): Result<number, Context>;
    releaseHold(seatKey: string, userKey: string, token: string, seatId: number): Result<number, Context>;
  }
}

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  // Fail fast while Redis is unreachable instead of queueing commands, so a hold request
  // gets a 503 rather than hanging.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

redis.defineCommand('holdSeat', { numberOfKeys: 2, lua: HOLD_SEAT });
// No fixed key count: confirm claims however many seats the user holds.
redis.defineCommand('beginConfirm', { lua: BEGIN_CONFIRM });
redis.defineCommand('releaseHold', { numberOfKeys: 2, lua: RELEASE_HOLD });

export default redis;
