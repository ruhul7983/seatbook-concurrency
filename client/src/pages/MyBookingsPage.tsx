import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ConfirmDialog from '../components/ConfirmDialog';
import { formatCountdown, useCountdown } from '../hooks/useCountdown';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

interface Hold {
  holdId: number;
  label: string;
  expiresAt: string;
  event: { id: number; title: string; venue: string };
}

function HoldRow({ hold, clockOffset }: { hold: Hold; clockOffset: number }) {
  const msLeft = useCountdown(hold.expiresAt, clockOffset);

  return (
    <div className="glass rounded-2xl p-6 flex items-center justify-between min-w-[760px] border-[#f97316]/40">
      <div>
        <div className="font-bold text-lg">{hold.event.title}</div>
        <div className="text-white/50 text-sm">
          📍 {hold.event.venue} · 💺 {hold.label}
        </div>
      </div>
      <div className="flex items-center gap-6">
        {msLeft > 0 ? (
          <>
            <span className="text-2xl font-extrabold tabular-nums text-[#fdba74]">⏳ {formatCountdown(msLeft)}</span>
            <Link
              to={`/events/${hold.event.id}`}
              className="px-4 py-2 rounded-xl bg-gradient-to-r from-[#a855f7] to-[#ec4899] text-sm font-semibold hover:scale-105 transition-all duration-300"
            >
              Confirm →
            </Link>
          </>
        ) : (
          <span className="text-white/40">⌛ Hold expired</span>
        )}
      </div>
    </div>
  );
}

export default function MyBookingsPage() {
  const [holds, setHolds] = useState<Hold[]>([]);
  const [clockOffset, setClockOffset] = useState(0);
  const [bookings, setBookings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalSpent, setTotalSpent] = useState(0);
  const [upcoming, setUpcoming] = useState(0);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<any>(null);
  const [cancelling, setCancelling] = useState(false);

  const loadBookings = () => {
    fetch(`${API_URL}/bookings/mine`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })
      .then((res) => res.json())
      .then((data) => {
        setBookings(data);

        let spent = 0;
        let up = 0;
        data.forEach((b: any) => {
          spent += parseFloat(b.event.price.replace('$', ''));
          if (new Date(b.event.startsAt) > new Date()) up++;
        });
        setTotalSpent(spent);
        setUpcoming(up);
        setLoading(false);
      });
  };

  const loadHolds = () => {
    fetch(`${API_URL}/holds/mine`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        setClockOffset(new Date(data.serverTime).getTime() - Date.now());
        setHolds(data.holds);
      })
      .catch((err) => console.error(err));
  };

  useEffect(() => {
    loadBookings();
    loadHolds();
  }, []);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const cancelBooking = async (id: number) => {
    setCancelTarget(null);
    setCancelling(true);
    try {
      const res = await fetch(`${API_URL}/bookings/${id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        showToast('success', 'Booking cancelled successfully! ✅');
      } else {
        showToast('error', '😢 ' + (data?.error || data?.message || 'Could not cancel the booking'));
      }
    } catch (err) {
      console.error(err);
      showToast('error', 'Something went wrong 😢');
    } finally {
      setCancelling(false);
      loadBookings();
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <div className="w-16 h-16 border-4 border-[#f97316] border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-6 text-white/60 animate-pulse">Loading your bookings... 🎟️</p>
      </div>
    );
  }

  return (
    <div>
      {toast && (
        <div
          className={`fixed top-24 right-6 z-50 px-6 py-4 rounded-2xl shadow-2xl font-medium ${
            toast.type === 'success'
              ? 'bg-gradient-to-r from-[#22c55e] to-[#16a34a]'
              : 'bg-gradient-to-r from-[#ef4444] to-[#dc2626]'
          }`}
        >
          {toast.message}
        </div>
      )}

      {cancelTarget && (
        <ConfirmDialog
          title={`Cancel your booking for ${cancelTarget.seat}?`}
          confirmLabel="Cancel booking"
          cancelLabel="Keep it"
          danger
          onConfirm={() => cancelBooking(cancelTarget.id)}
          onCancel={() => setCancelTarget(null)}
        >
          {cancelTarget.event.title}. The seat goes back on sale right away, and someone else can book it.
        </ConfirmDialog>
      )}

      <h1 className="text-5xl font-extrabold mb-2">
        My <span className="gradient-text">Bookings</span> 🎟️
      </h1>
      <p className="text-white/50 mb-10">All your amazing experiences in one place ✨</p>

      <div className="grid grid-cols-3 gap-6 mb-10">
        <div className="glass rounded-2xl p-6">
          <div className="text-white/50 text-sm">Total Bookings</div>
          <div className="text-4xl font-bold gradient-text">{bookings.length}</div>
        </div>
        <div className="glass rounded-2xl p-6">
          <div className="text-white/50 text-sm">Upcoming</div>
          <div className="text-4xl font-bold gradient-text">{upcoming}</div>
        </div>
        <div className="glass rounded-2xl p-6">
          <div className="text-white/50 text-sm">Total Spent</div>
          <div className="text-4xl font-bold gradient-text">${totalSpent.toFixed(2)}</div>
        </div>
      </div>

      {holds.length > 0 && (
        <div className="mb-10">
          <h2 className="text-2xl font-bold mb-4">
            Seats on <span className="gradient-text">hold</span> ⏳
          </h2>
          <div className="space-y-4">
            {holds.map((hold) => (
              <HoldRow key={hold.holdId} hold={hold} clockOffset={clockOffset} />
            ))}
          </div>
        </div>
      )}

      {bookings.length === 0 && (
        <div className="text-center py-20 text-white/40">
          <div className="text-6xl">🎭</div>
          <p className="mt-4">No bookings yet!</p>
          <Link to="/" className="text-[#a855f7]">
            Explore events →
          </Link>
        </div>
      )}

      <div className="space-y-4">
        {bookings.map((b) => (
          <div key={b.id} className="glass rounded-2xl p-6 flex items-center justify-between min-w-[760px]">
            <div className="flex items-center gap-5">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#a855f7] via-[#ec4899] to-[#f97316] flex items-center justify-center text-2xl">
                🎭
              </div>
              <div>
                <div className="font-bold text-lg">{b.event.title}</div>
                <div className="text-white/50 text-sm">
                  📍 {b.event.venue} · 📅 {b.event.startsAt.split('T')[0]}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <span className="px-3 py-1 rounded-full bg-[#a855f7]/20 text-[#d8b4fe] text-sm">💺 {b.seat}</span>
              <span className="font-bold">{b.event.price}</span>
              {b.status === 'CANCELLED' ? (
                <span className="px-3 py-1 rounded-full bg-white/10 text-white/50 text-sm">✕ CANCELLED</span>
              ) : (
                <span className="px-3 py-1 rounded-full bg-[#22c55e]/20 text-[#86efac] text-sm">✓ {b.status}</span>
              )}
              {b.status === 'CONFIRMED' && new Date(b.event.startsAt) > new Date() && (
                <button
                  onClick={() => setCancelTarget(b)}
                  disabled={cancelling}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-[#ef4444] to-[#dc2626] text-sm font-semibold hover:scale-105 transition-all duration-300 disabled:opacity-50"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
