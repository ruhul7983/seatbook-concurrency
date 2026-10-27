import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import eventRoutes from './routes/events';
import bookingRoutes from './routes/bookings';
import holdRoutes from './routes/holds';
import { startHoldSweeper } from './services/holdService';
import { HttpError } from './utils/http';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/auth', authRoutes);
app.use('/events', eventRoutes);
app.use('/bookings', bookingRoutes);
app.use('/holds', holdRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Every error ends here as JSON. Only HttpErrors and request-body errors show their message;
// anything else is logged and answered with a generic 500, so internals never reach the client.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  // Errors from express.json(): broken JSON, a body over the size limit, an unsupported charset.
  const bodyError = err as { type?: string; status?: number; expose?: boolean; message?: string };
  if (bodyError.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (bodyError.expose && bodyError.status && bodyError.status < 500) {
    return res.status(bodyError.status).json({ error: bodyError.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// Last line of defence. Route handlers are wrapped in asyncHandler (test/routes.test.ts checks this),
// but a promise rejected outside a request, such as in a timer, would otherwise kill the whole server
// on Node 15+. Each one is request- or task-scoped, so log it loudly and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

startHoldSweeper();

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Seatbook API running on http://localhost:${PORT}`);
});
