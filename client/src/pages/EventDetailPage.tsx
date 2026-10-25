import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import ConfirmDialog from '../components/ConfirmDialog';
import { formatCountdown, useCountdown } from '../hooks/useCountdown';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
// Other people's holds and bookings show up within this long.
const POLL_MS = 10000;
// A seat picked while logged out. Nothing is held for it; after sign-in we try to hold it once.
const PENDING_SEAT_KEY = 'pendingSeat';
// A second click this soon after holding a seat is a double click, not a request to release it.
const DOUBLE_CLICK_MS = 800;

type SeatStatus = 'available' | 'held' | 'heldByYou' | 'booked';

interface Seat {
  id: number;
  row: number;
  col: number;
  label: string;
  status: SeatStatus;
}

interface Hold {
  holdId: number;
  seatId: number;
  label: string;
  expiresAt: string;
}

interface EventDetail {
  id: number;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  price: string;
  organizer: { id: number; name: string };
  seats: Seat[];
  myHolds: Hold[];
  holdExpiresAt: string | null;
  maxSeatsPerHold: number;
  serverTime: string;
}

type Dialog = { kind: 'signIn'; seat: Seat } | { kind: 'release'; hold: Hold } | { kind: 'releaseAll' };

const SEAT_STYLES: Record<SeatStatus, string> = {
  available: 'bg-gradient-to-br from-[#a855f7]/60 to-[#6366f1]/60 hover:from-[#a855f7] hover:to-[#6366f1] hover:scale-110 cursor-pointer',
  heldByYou: 'bg-gradient-to-br from-[#f97316] to-[#facc15] text-black ring-2 ring-white scale-110 cursor-pointer',
  held: 'bg-[#f97316]/15 text-[#fdba74]/60 border border-dashed border-[#f97316]/50 cursor-not-allowed',
  booked: 'bg-gradient-to-br from-[#a855f7]/20 to-[#6366f1]/20 text-white/30 cursor-not-allowed',
};

const SEAT_TITLES: Record<SeatStatus, string> = {
  available: 'Free. Tap to hold it',
  heldByYou: 'Held by you. Tap to release it',
  held: 'Someone is holding this seat',
  booked: 'Booked',
};

export default function EventDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const token = localStorage.getItem('token');
  const user = JSON.parse(localStorage.getItem('user') || 'null');
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const [pendingSeatIds, setPendingSeatIds] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [expiredLabels, setExpiredLabels] = useState<string[] | null>(null);
  const [toast, setToast] = useState<{ type: string; message: string } | null>(null);
  const pendingChecked = useRef(false);
  const heldAt = useRef(new Map<number, number>());
  const latestFetch = useRef(0);

  const myHolds = event?.myHolds ?? [];
  const msLeft = useCountdown(event?.holdExpiresAt, clockOffset);

  const showToast = (type: 'success' | 'error', message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchEvent = async () => {
    // Several holds in quick succession each refetch, and the responses can arrive out of order.
    // Only the newest request may update the page, so an older seat map never overwrites a newer one.
    const fetchId = ++latestFetch.current;
    try {
      const res = await fetch(`${API_URL}/events/${id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (fetchId !== latestFetch.current) return;
      if (res.status === 404 || res.status === 400) {
        setNotFound(true);
        return;
      }
      if (!res.ok) return;
      const data: EventDetail = await res.json();
      if (fetchId !== latestFetch.current) return;
      setClockOffset(new Date(data.serverTime).getTime() - Date.now());
      setEvent(data);
    } catch (err) {
      console.error(err);
    }
  };

  const send = async (method: string, path: string, body?: object) => {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { ok: res.ok, data, error: data?.error || data?.message || 'Something went wrong' };
  };

  useEffect(() => {
    fetchEvent();
    const timer = setInterval(fetchEvent, POLL_MS);
    return () => clearInterval(timer);
  }, [id]);

  // Back from signing in: try once to hold the seat they picked while logged out.
  useEffect(() => {
    if (!event || !token || pendingChecked.current) return;
    pendingChecked.current = true;
    const pending = JSON.parse(sessionStorage.getItem(PENDING_SEAT_KEY) || 'null');
    sessionStorage.removeItem(PENDING_SEAT_KEY);
    if (pending?.eventId === event.id) {
      holdSeat(pending.seatId);
    }
  }, [event]);

  useEffect(() => {
    if (event?.holdExpiresAt && msLeft === 0) {
      setExpiredLabels(myHolds.map((h) => h.label));
      setDialog(null);
      fetchEvent();
    }
  }, [msLeft === 0, event?.holdExpiresAt]);

  const setPending = (seatId: number, pending: boolean) => {
    setPendingSeatIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(seatId);
      else next.delete(seatId);
      return next;
    });
  };

  const holdSeat = async (seatId: number) => {
    setPending(seatId, true);
    try {
      const res = await send('POST', '/holds', { seatId });
      if (res.ok) {
        heldAt.current.set(seatId, Date.now());
        setExpiredLabels(null);
        setClockOffset(new Date(res.data.serverTime).getTime() - Date.now());
        // Show the hold straight away; the refetch below brings in everything else.
        setEvent((prev) =>
          prev && {
            ...prev,
            seats: prev.seats.map((s) => (s.id === seatId ? { ...s, status: 'heldByYou' } : s)),
            myHolds: [...prev.myHolds, { holdId: res.data.holdId, seatId, label: res.data.label, expiresAt: res.data.expiresAt }],
            holdExpiresAt: res.data.expiresAt,
          }
        );
      } else {
        showToast('error', '😢 ' + res.error);
      }
      await fetchEvent();
    } catch (err) {
      console.error(err);
      showToast('error', 'Something went wrong 😢');
    } finally {
      setPending(seatId, false);
    }
  };

  const releaseHolds = async (holds: Hold[]) => {
    setDialog(null);
    setBusy(true);
    try {
      for (const hold of holds) {
        const res = await send('DELETE', `/holds/${hold.holdId}`);
        if (!res.ok) showToast('error', '😢 ' + res.error);
      }
      await fetchEvent();
    } catch (err) {
      console.error(err);
      showToast('error', 'Something went wrong 😢');
    } finally {
      setBusy(false);
    }
  };

  const confirmHolds = async () => {
    setBusy(true);
    try {
      const labels = myHolds.map((h) => h.label).join(', ');
      const res = await send('POST', '/holds/confirm', { eventId: event!.id });
      if (res.ok) {
        showToast('success', `🎉 Woohoo! ${myHolds.length > 1 ? `Seats ${labels} are` : `Seat ${labels} is`} yours!`);
      } else {
        showToast('error', '😢 ' + res.error);
      }
      await fetchEvent();
    } catch (err) {
      console.error(err);
      showToast('error', 'Something went wrong 😢');
    } finally {
      setBusy(false);
    }
  };

  const goToSignIn = (seat?: Seat) => {
    if (seat) {
      sessionStorage.setItem(PENDING_SEAT_KEY, JSON.stringify({ eventId: event!.id, seatId: seat.id }));
    }
    navigate(`/login?next=/events/${id}`);
  };

  const onSeatClick = (seat: Seat) => {
    if (pendingSeatIds.has(seat.id)) return;

    if (!user) {
      setDialog({ kind: 'signIn', seat });
    } else if (user.role === 'ORGANIZER') {
      showToast('error', "Organizer accounts can't book seats");
    } else if (seat.status === 'available') {
      holdSeat(seat.id);
    } else if (seat.status === 'heldByYou') {
      if (Date.now() - (heldAt.current.get(seat.id) ?? 0) < DOUBLE_CLICK_MS) return;
      const hold = myHolds.find((h) => h.seatId === seat.id);
      if (hold) setDialog({ kind: 'release', hold });
    }
  };

  if (notFound) {
    return (
      <div className="text-center py-32 text-white/50">
        <div className="text-6xl">🤷</div>
        <p className="mt-4">Event not found</p>
        <Link to="/" className="text-[#a855f7]">
          Back to events →
        </Link>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="flex flex-col items-center justify-center py-32">
        <div className="w-16 h-16 border-4 border-[#ec4899] border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-6 text-white/60 animate-pulse">Loading event... 🎭</p>
      </div>
    );
  }

  const rows: Seat[][] = [];
  event.seats.forEach((seat) => {
    if (!rows[seat.row]) rows[seat.row] = [];
    rows[seat.row].push(seat);
  });

  const availableCount = event.seats.filter((seat) => seat.status === 'available').length;
  const holdActive = myHolds.length > 0 && msLeft > 0;
  const isOrganizer = user?.role === 'ORGANIZER';

  const price = parseFloat(event.price.replace('$', ''));
  const seatCount = holdActive ? myHolds.length : 1;
  const ticketTotal = price * seatCount;
  const serviceFee = ticketTotal * 0.05;
  const total = ticketTotal + serviceFee;
  const isPast = new Date(event.startsAt) < new Date();
  const percentBooked = event.seats.length
    ? Math.round(((event.seats.length - availableCount) / event.seats.length) * 100)
    : 0;

  const actionButtonClass =
    'mt-8 w-full py-4 rounded-2xl bg-gradient-to-r from-[#a855f7] via-[#ec4899] to-[#f97316] font-bold text-lg hover:scale-[1.02] hover:shadow-2xl hover:shadow-pink-500/40 transition-all duration-300 disabled:opacity-50 disabled:hover:scale-100';

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

      {dialog?.kind === 'signIn' && (
        <ConfirmDialog
          title="Sign in to hold this seat 🔒"
          confirmLabel="Sign in"
          cancelLabel="Not now"
          onConfirm={() => goToSignIn(dialog.seat)}
          onCancel={() => setDialog(null)}
        >
          Seats are only held for signed-in attendees. Sign in or create an account and we'll try to hold{' '}
          <strong className="text-white">{dialog.seat.label}</strong> for you when you're back. Someone who is already
          signed in could take it first.
        </ConfirmDialog>
      )}

      {dialog?.kind === 'release' && (
        <ConfirmDialog
          title={`Release seat ${dialog.hold.label}?`}
          confirmLabel="Release seat"
          cancelLabel="Keep it"
          danger
          onConfirm={() => releaseHolds([dialog.hold])}
          onCancel={() => setDialog(null)}
        >
          It goes back on sale right away, and someone else can take it.
          {myHolds.length === 1 && ' Your countdown ends too.'}
        </ConfirmDialog>
      )}

      {dialog?.kind === 'releaseAll' && (
        <ConfirmDialog
          title={`Release all ${myHolds.length} seats?`}
          confirmLabel="Release all"
          cancelLabel="Keep them"
          danger
          onConfirm={() => releaseHolds(myHolds)}
          onCancel={() => setDialog(null)}
        >
          {myHolds.map((h) => h.label).join(', ')} go back on sale right away, and someone else can take them.
        </ConfirmDialog>
      )}

      <div className="rounded-3xl p-10 bg-gradient-to-br from-[#a855f7]/30 via-[#ec4899]/20 to-[#f97316]/20 border border-white/10 glow">
        <span className="px-3 py-1 rounded-full bg-[#a855f7]/30 text-[#d8b4fe] text-xs font-bold">
          {isPast ? '⏰ ENDED' : '✨ LIVE NOW'}
        </span>
        <h1 className="mt-4 text-5xl font-extrabold">{event.title}</h1>
        <p className="mt-4 text-white/60 text-lg">{event.description}</p>
        <div className="mt-6 flex gap-6 text-white/70">
          <span>📍 {event.venue}</span>
          <span>📅 {new Date(event.startsAt).toDateString()}</span>
          <span>👤 {event.organizer.name}</span>
        </div>
      </div>

      {!user && !isPast && (
        <div className="mt-8 px-6 py-4 rounded-2xl bg-[#f97316]/15 border border-[#f97316]/40 text-[#fdba74] flex items-center justify-between gap-6">
          <span>
            🔒 <strong>Sign in to hold a seat.</strong> Seats are only held for signed-in attendees, so someone who is
            signed in can take the seat you picked while you sign up.
          </span>
          <button
            onClick={() => goToSignIn()}
            className="shrink-0 px-5 py-2 rounded-full bg-[#f97316] text-white text-sm font-semibold hover:scale-105 transition-all duration-300"
          >
            Sign in
          </button>
        </div>
      )}

      <div className="mt-10 grid grid-cols-3 gap-8">
        <div className="col-span-2 glass rounded-3xl p-8">
          <h2 className="text-2xl font-bold mb-2">
            Choose Your <span className="gradient-text">Perfect Seat</span> 🪑
          </h2>
          <p className="text-white/50 mb-6">
            {availableCount} of {event.seats.length} available · {percentBooked}% taken 🔥
          </p>
          <div className="w-full h-2 rounded-full bg-gradient-to-r from-[#a855f7] to-[#ec4899] mb-10 opacity-60"></div>
          <div className="space-y-3">
            {rows.map((row, i) => (
              <div key={i} className="flex gap-3 justify-center">
                {row.map((seat) => (
                  <button
                    key={seat.id}
                    type="button"
                    disabled={isPast || seat.status === 'held' || seat.status === 'booked'}
                    onClick={() => onSeatClick(seat)}
                    title={SEAT_TITLES[seat.status]}
                    aria-label={`Seat ${seat.label}: ${SEAT_TITLES[seat.status]}`}
                    className={`w-12 h-12 rounded-xl flex items-center justify-center text-xs font-bold transition-all duration-300 ${
                      SEAT_STYLES[seat.status]
                    } ${pendingSeatIds.has(seat.id) ? 'animate-pulse' : ''}`}
                  >
                    {seat.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-8 flex justify-center gap-6 text-xs text-white/50">
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 rounded bg-gradient-to-br from-[#a855f7]/60 to-[#6366f1]/60"></span> Free
            </span>
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 rounded bg-gradient-to-br from-[#f97316] to-[#facc15]"></span> Held by you
            </span>
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 rounded bg-[#f97316]/15 border border-dashed border-[#f97316]/50"></span> Held
            </span>
            <span className="flex items-center gap-2">
              <span className="w-4 h-4 rounded bg-gradient-to-br from-[#a855f7]/20 to-[#6366f1]/20"></span> Booked
            </span>
          </div>
        </div>

        <div className="glass rounded-3xl p-8 h-fit">
          <h3 className="text-xl font-bold mb-6">Order Summary 🧾</h3>
          <div className="space-y-4 text-white/70">
            <div className="flex justify-between gap-4">
              <span>{holdActive && myHolds.length > 1 ? 'Seats' : 'Seat'}</span>
              <span className="font-bold text-white text-right">
                {holdActive ? myHolds.map((h) => h.label).join(', ') : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Ticket{seatCount > 1 ? ` × ${seatCount}` : ''}</span>
              <span>${ticketTotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span>Service fee (5%)</span>
              <span>${serviceFee.toFixed(2)}</span>
            </div>
            <div className="border-t border-white/10 pt-4 flex justify-between text-xl font-bold text-white">
              <span>Total</span>
              <span className="gradient-text">${total.toFixed(2)}</span>
            </div>
          </div>

          {expiredLabels && !holdActive && (
            <p className="mt-6 p-3 rounded-xl bg-[#ef4444]/15 border border-[#ef4444]/40 text-[#fca5a5] text-sm">
              ⌛ Your hold on {expiredLabels.join(', ')} expired and {expiredLabels.length > 1 ? 'they are' : 'it is'}{' '}
              back on sale.
            </p>
          )}

          {holdActive ? (
            <>
              <div className="mt-6 p-4 rounded-2xl bg-[#f97316]/15 border border-[#f97316]/40 text-center">
                <div className="text-sm text-[#fdba74]">
                  {myHolds.length} {myHolds.length > 1 ? 'seats' : 'seat'} held for you
                </div>
                <div className={`text-4xl font-extrabold tabular-nums ${msLeft < 60000 ? 'text-[#fca5a5]' : 'text-white'}`}>
                  ⏳ {formatCountdown(msLeft)}
                </div>
                <div className="text-xs text-white/50">left to confirm</div>
              </div>
              <button onClick={confirmHolds} disabled={busy || pendingSeatIds.size > 0} className={actionButtonClass}>
                Confirm Booking{myHolds.length > 1 ? ` (${myHolds.length} seats)` : ''} 🎟️
              </button>
              <button
                onClick={() => (myHolds.length > 1 ? setDialog({ kind: 'releaseAll' }) : setDialog({ kind: 'release', hold: myHolds[0] }))}
                disabled={busy}
                className="mt-3 w-full py-3 rounded-2xl border border-white/20 text-white/70 hover:text-white hover:border-white/40 transition-all duration-300 disabled:opacity-50"
              >
                {myHolds.length > 1 ? 'Release all' : 'Release seat'}
              </button>
            </>
          ) : isPast ? (
            <button disabled className={actionButtonClass}>
              This event has ended
            </button>
          ) : !user ? (
            <button onClick={() => goToSignIn()} className={actionButtonClass}>
              Sign in to hold 🔒
            </button>
          ) : isOrganizer ? (
            <button disabled className={actionButtonClass}>
              Organizers can't book seats
            </button>
          ) : (
            <p className="mt-8 p-4 rounded-2xl bg-white/5 text-center text-white/70">👆 Tap a free seat to hold it</p>
          )}
          <p className="mt-4 text-center text-xs text-white/40">
            Tap seats to hold up to {event.maxSeatsPerHold} for 10 minutes on one timer. Tap a held seat again to release
            it. Nobody else can take them until you confirm or the time runs out.
          </p>
        </div>
      </div>
    </div>
  );
}
