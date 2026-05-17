require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const contractRoutes = require('./routes/contracts');
const taskRoutes = require('./routes/tasks');
const documentRoutes = require('./routes/documents');
const templateRoutes = require('./routes/templates');
const signingRoutes = require('./routes/signing');
const aiRoutes      = require('./routes/ai');
const aiAuditRoutes = require('./routes/aiAudit');
const notificationRoutes = require('./routes/notifications');
const reportRoutes = require('./routes/reports');
const legalRequestRoutes    = require('./routes/legalRequests');
const signatureRequestRoutes = require('./routes/signatureRequests');
const { getInstance: getAiRuntimeManager } = require('./ai/runtime/AiRuntimeManager');

const app = express();

connectDB();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(cors({
  origin: (origin, callback) => {
    const allowed = process.env.FRONTEND_URL || 'http://localhost:5173';
    if (
      !origin ||                // no Origin header (curl, server-to-server)
      origin === 'null' ||      // file:// pages in Electron production
      origin === allowed ||
      /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Signing-Session', 'X-Signing-Idempotency-Key', 'X-Signing-Dev-Bypass'],
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many auth attempts, please try again after 15 minutes',
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Static file serving for uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/legal-folder', express.static(path.join(__dirname, '../legal-folder')));
app.use('/templates', express.static(path.join(__dirname, '../templates')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/signing', signingRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/ai/audit', aiAuditRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/legal-requests', legalRequestRoutes);
app.use('/api/signature-requests', signatureRequestRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  void next;
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`CLM Server running on port ${PORT} [${process.env.NODE_ENV}]`);
  if ((process.env.ACTIVE_MODEL_PROVIDER || 'local') === 'local') {
    getAiRuntimeManager().initialize().catch((err) => {
      console.error(`[AI Runtime] Startup check failed: ${err.message}`);
    });
  }
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use. Stop the other process or set PORT= to a different value and try again.`);
    process.exit(1);
  } else {
    throw err;
  }
});

// Start expiry notification cron job after server starts
require('./services/expiryService');

// Run legal-deadline monitor every 6 hours
const { runDeadlineMonitor } = require('./services/legalDeadlineMonitorService');
setInterval(() => {
  runDeadlineMonitor().catch(err => console.error('[deadlineMonitor]', err));
}, 6 * 3600 * 1000);

module.exports = app;
