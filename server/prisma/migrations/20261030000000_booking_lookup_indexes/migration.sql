-- Holds and confirms look up a seat's live claim and a user's live holds on every request.
-- CreateIndex
CREATE INDEX "Booking_seatId_status_idx" ON "Booking"("seatId", "status");

-- CreateIndex
CREATE INDEX "Booking_userId_status_idx" ON "Booking"("userId", "status");
