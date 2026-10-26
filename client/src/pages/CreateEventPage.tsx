import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';
// Same limits as the server (server/src/utils/eventInput.ts).
const MAX_ROWS = 26;
const MAX_COLS = 30;

export default function CreateEventPage() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [venue, setVenue] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [rows, setRows] = useState(5);
  const [cols, setCols] = useState(8);
  const [price, setPrice] = useState('0');
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    // Up to two decimals, so "15.5" or "15.50" is fine and "15.555" or "-5" is not. The server checks again.
    if (!/^\d+(\.\d{1,2})?$/.test(price.trim())) {
      setError('Enter the ticket price in dollars, like 15 or 15.50');
      return;
    }
    if (!startsAt) {
      setError('Pick a start date and time');
      return;
    }

    try {
      const res = await fetch(`${API_URL}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({
          title,
          description,
          venue,
          startsAt: new Date(startsAt).toISOString(),
          rows: Number(rows),
          cols: Number(cols),
          priceCents: Math.round(parseFloat(price) * 100),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || data?.message || 'Something went wrong 😢');
        return;
      }

      const event = await res.json();
      navigate(`/events/${event.id}`);
    } catch (err) {
      console.error(err);
      setError('Something went wrong 😢');
    }
  };

  const previewRows = [];
  // Capped at the server's limits, so typing a huge number can't freeze the page with thousands of seats.
  for (let r = 0; r < Math.min(Number(rows), MAX_ROWS); r++) {
    const seats = [];
    for (let c = 0; c < Math.min(Number(cols), MAX_COLS); c++) {
      seats.push(String.fromCharCode(65 + r) + (c + 1));
    }
    previewRows.push(seats);
  }

  return (
    <div>
      <h1 className="text-5xl font-extrabold mb-2">
        Create <span className="gradient-text">Event</span> ✨
      </h1>
      <p className="text-white/50 mb-10">Bring people together for something amazing 🎉</p>

      <div className="grid grid-cols-2 gap-8">
        <form onSubmit={handleSubmit} className="glass rounded-3xl p-8 space-y-4">
          <input
            placeholder="🎭 Event title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full px-5 py-4 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#a855f7] transition-all duration-300"
          />
          <textarea
            placeholder="📝 Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-5 py-4 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#a855f7] transition-all duration-300"
          />
          <input
            placeholder="📍 Venue"
            value={venue}
            onChange={(e) => setVenue(e.target.value)}
            className="w-full px-5 py-4 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#a855f7] transition-all duration-300"
          />
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="w-full px-5 py-4 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#a855f7] transition-all duration-300"
          />
          <div className="grid grid-cols-3 gap-4">
            <input
              type="number"
              min={1}
              max={MAX_ROWS}
              title="Rows"
              value={rows}
              onChange={(e) => setRows(Number(e.target.value))}
              className="w-full px-5 py-4 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#a855f7] transition-all duration-300"
            />
            <input
              type="number"
              min={1}
              max={MAX_COLS}
              title="Seats per row"
              value={cols}
              onChange={(e) => setCols(Number(e.target.value))}
              className="w-full px-5 py-4 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#a855f7] transition-all duration-300"
            />
            <input
              placeholder="💰 Price"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full px-5 py-4 rounded-2xl bg-white/5 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-[#a855f7] transition-all duration-300"
            />
          </div>
          {error && <p className="text-[#fca5a5] text-sm">⚠️ {error}</p>}
          <button
            type="submit"
            className="w-full py-4 rounded-2xl bg-gradient-to-r from-[#a855f7] via-[#ec4899] to-[#f97316] font-bold text-lg hover:scale-[1.02] hover:shadow-2xl hover:shadow-pink-500/40 transition-all duration-300"
          >
            Launch Event 🚀
          </button>
        </form>

        <div className="glass rounded-3xl p-8">
          <h3 className="text-xl font-bold mb-6">Live Preview 👀</h3>
          <div className="space-y-3">
            {previewRows.map((row, i) => (
              <div key={i} className="flex gap-3 justify-center">
                {row.map((label) => (
                  <div
                    key={label}
                    className="w-12 h-12 rounded-xl flex items-center justify-center text-xs font-bold bg-gradient-to-br from-[#a855f7]/60 to-[#6366f1]/60"
                  >
                    {label}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
