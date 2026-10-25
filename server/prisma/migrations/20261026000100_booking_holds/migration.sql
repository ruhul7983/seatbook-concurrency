-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "holdToken" TEXT,
ADD COLUMN "expiresAt" TIMESTAMP(3),
ADD COLUMN "confirmedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Booking_holdToken_key" ON "Booking"("holdToken");

-- CreateIndex
CREATE INDEX "Booking_status_expiresAt_idx" ON "Booking"("status", "expiresAt");

-- At most one confirmed booking per seat. Redis stops most double bookings before they get here;
-- this index is the guarantee if Redis loses data or two requests slip past it.
-- Not expressible in schema.prisma, see the comment on the Booking model.
CREATE UNIQUE INDEX "Booking_seatId_confirmed_key" ON "Booking"("seatId") WHERE "status" = 'CONFIRMED';
