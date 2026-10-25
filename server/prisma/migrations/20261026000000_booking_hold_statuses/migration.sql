-- New enum values must be committed before anything can use them,
-- so they get their own migration ahead of 20261026000100_booking_holds.
ALTER TYPE "BookingStatus" ADD VALUE 'HELD' BEFORE 'CONFIRMED';
ALTER TYPE "BookingStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "BookingStatus" ADD VALUE 'RELEASED';
