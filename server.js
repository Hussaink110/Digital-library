require('dotenv').config();
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const MongoStore = require('connect-mongo');
const fileUpload = require('express-fileupload');
const path = require('path');
const helmet = require('helmet');
const morgan = require('morgan');
const csrf = require('csurf');
const connectDB = require('./database/mongodb');
const { setUserLocals } = require('./middleware/userAuth');
const User = require('./models/User');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
if (isProd) {
    // behind proxy/load balancer in production
    try { app.set('trust proxy', 1); } catch {}
}

// Connect to MongoDB
connectDB();

// Middleware
app.use(compression());
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            "default-src": ["'self'"],
            "connect-src": ["'self'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "blob:"],
            "img-src": ["'self'", "data:", "blob:"],
            "style-src": ["'self'", "'unsafe-inline'"],
            "style-src-attr": ["'unsafe-inline'"],
            "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"],
            "script-src-attr": ["'unsafe-inline'"],
            "worker-src": ["'self'", "blob:", "https://cdnjs.cloudflare.com"],
            "child-src": ["'self'", "blob:", "https://cdnjs.cloudflare.com"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration (Mongo store if MONGODB_URI provided)
const sessionOptions = {
    secret: process.env.SESSION_SECRET || 'digital-library-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        httpOnly: true,
        sameSite: 'lax',
        secure: isProd
    }
};
if (process.env.MONGODB_URI) {
    sessionOptions.store = MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        ttl: 60 * 60 * 24 * 7 // 7 days
    });
}
app.use(session(sessionOptions));

app.use(fileUpload({
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 50 * 1024 * 1024 }, // 50MB max file size
    createParentPath: true
}));

// CSRF protection for non-API routes
const csrfProtection = csrf();
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    return csrfProtection(req, res, next);
});

// Expose CSRF token to views when available
app.use((req, res, next) => {
    if (typeof req.csrfToken === 'function') {
        try { res.locals.csrfToken = req.csrfToken(); } catch (_) {}
    }
    next();
});

// CSRF error handler
app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).send('Invalid CSRF token');
    }
    next(err);
});

// Static files
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));

// Expose user to views
app.use(setUserLocals);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
const adminRoutes = require('./routes/admin');
const bookRoutes = require('./routes/books');
const userRoutes = require('./routes/user');
const reviewRoutes = require('./routes/reviews');
const readingListRoutes = require('./routes/readingList');

app.use('/admin', adminRoutes);
app.use('/user', userRoutes);
app.use(readingListRoutes);
app.use(reviewRoutes);
app.use('/', bookRoutes);

// 404 handler
app.use((req, res, next) => {
    if (req.accepts('html')) return res.status(404).render('404', { url: req.originalUrl });
    if (req.accepts('json')) return res.status(404).json({ error: 'not_found' });
    return res.status(404).type('txt').send('Not found');
});

// Centralized error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (req.accepts('html')) return res.status(500).render('500', { message: 'Something went wrong' });
    if (req.accepts('json')) return res.status(500).json({ error: 'server_error' });
    res.status(500).type('txt').send('Server error');
});

// Lightweight daily job: expire subscriptions past end date
setInterval(async () => {
    try {
        const now = new Date();
        const res = await User.updateMany(
          { subscription_status: 'active', subscription_end: { $lt: now } },
          { $set: { subscription_status: 'expired' } }
        );
        if (res?.modifiedCount) console.log('Expired subs updated:', res.modifiedCount);
    } catch (e) { console.error('Expire job failed:', e.message); }
}, 1000 * 60 * 60); // hourly

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
