import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import bodyParser from 'body-parser';
import pg from 'pg';
import pgSession from 'connect-pg-simple';
import multer from 'multer';
import fs from 'fs';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import { GoogleCalendarService } from './services/googleCalendarService.js';
import { GmailService } from './services/gmailService.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Google Calendar Service
const googleCalendarService = new GoogleCalendarService();

// Initialize Gmail Service
const gmailService = new GmailService();

// PostgreSQL session store
const PgSession = pgSession(session);

// Database connection
const db = new pg.Client({
  user: "postgres",
  host: "localhost",
  database: "Ovill",
  password: "mysecretpassword",
  port: 5433,
});

// Create a pool for session store
const sessionPool = new pg.Pool({
  user: "postgres",
  host: "localhost",
  database: "Ovill",
  password: "mysecretpassword",
  port: 5433,
});

const app = express();
const port = 3001;

app.use(express.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  store: new PgSession({
    pool: sessionPool,
    tableName: 'session'
  }),
  secret: 'your-secret-key-change-this-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, 'public/uploads/avatars');
    // Ensure directory exists
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    // Generate unique filename with timestamp and original extension
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, 'avatar-' + uniqueSuffix + extension);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    // Check if file is an image
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware to check authentication
function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        next();
    } else {
        // Redirect to public site login
        res.redirect('http://localhost:3000/login');
    }
}

// API Routes for Google Calendar (status and events only)

// Get Google Calendar integration status
app.get('/api/google/calendar/status', requireAuth, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT is_active, created_at, calendar_info FROM google_calendar_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        const isConnected = result.rows.length > 0;
        res.json({ 
            connected: isConnected,
            connectedSince: isConnected ? result.rows[0].created_at : null,
            calendarInfo: isConnected ? result.rows[0].calendar_info : null
        });
    } catch (error) {
        console.error('Error checking Google Calendar status:', error);
        res.status(500).json({ 
            connected: false,
            error: 'Failed to check status' 
        });
    }
});

// Get calendar events from Google Calendar
app.get('/api/google/calendar/events', requireAuth, async (req, res) => {
    try {
        const { start, end } = req.query;
        
        // Get user's Google Calendar tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM google_calendar_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Google Calendar integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await googleCalendarService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE google_calendar_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Google Calendar token' });
            }
        }
        
        // Set credentials and get events
        googleCalendarService.setCredentials({ access_token, refresh_token });
        const startDate = start || new Date().toISOString();
        const endDate = end || new Date(new Date().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days from now
        
        const events = await googleCalendarService.getEvents(startDate, endDate);
        res.json({ success: true, events });
        
    } catch (error) {
        console.error('Error fetching Google Calendar events:', error);
        res.status(500).json({ error: 'Failed to fetch calendar events' });
    }
});

// Create event in Google Calendar
app.post('/api/google/calendar/events', requireAuth, async (req, res) => {
    try {
        const { title, description, start, end, location, attendees } = req.body;
        
        // Get user's Google Calendar tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token FROM google_calendar_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Google Calendar integration not found' });
        }
        
        const { access_token, refresh_token } = tokenResult.rows[0];
        
        // Create event
        googleCalendarService.setCredentials({ access_token, refresh_token });
        const eventData = {
            title,
            description,
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
            location,
            attendees: attendees || []
        };
        
        const createdEvent = await googleCalendarService.createEvent(eventData);
        res.json({ success: true, event: createdEvent });
        
    } catch (error) {
        console.error('Error creating Google Calendar event:', error);
        res.status(500).json({ error: 'Failed to create calendar event' });
    }
});

// Calendar page route for creating events (alternative endpoint)
app.post('/calendar/create-event', requireAuth, async (req, res) => {
    try {
        const { title, description, start, end, location, allDay } = req.body;
        
        // Get user's Google Calendar tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM google_calendar_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Google Calendar integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await googleCalendarService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE google_calendar_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Google Calendar token' });
            }
        }
        
        // Set credentials and create event
        googleCalendarService.setCredentials({ access_token, refresh_token });
        
        let startDate, endDate;
        if (allDay) {
            // For all-day events, use date format without time
            startDate = start;
            endDate = end;
        } else {
            // For timed events, use ISO string format
            startDate = new Date(start).toISOString();
            endDate = new Date(end).toISOString();
        }
        
        const eventData = {
            title,
            description,
            start: startDate,
            end: endDate,
            location,
            allDay
        };
        
        const createdEvent = await googleCalendarService.createEvent(eventData);
        res.json({ success: true, event: createdEvent });
        
    } catch (error) {
        console.error('Error creating Google Calendar event:', error);
        res.status(500).json({ error: error.message || 'Failed to create calendar event' });
    }
});

// Update event route
app.put('/calendar/update-event/:eventId', requireAuth, async (req, res) => {
    try {
        const { eventId } = req.params;
        const { title, description, start, end, location, allDay } = req.body;
        
        // Get user's Google Calendar tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM google_calendar_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Google Calendar integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await googleCalendarService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE google_calendar_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Google Calendar token' });
            }
        }
        
        // Set credentials and update event
        googleCalendarService.setCredentials({ access_token, refresh_token });
        
        let startDate, endDate;
        if (allDay) {
            // For all-day events, use date format without time
            startDate = start;
            endDate = end;
        } else {
            // For timed events, use ISO string format
            startDate = new Date(start).toISOString();
            endDate = new Date(end).toISOString();
        }
        
        const eventData = {
            title,
            description,
            start: startDate,
            end: endDate,
            location,
            allDay
        };
        
        const updatedEvent = await googleCalendarService.updateEvent(eventId, eventData);
        res.json({ success: true, event: updatedEvent });
        
    } catch (error) {
        console.error('Error updating Google Calendar event:', error);
        res.status(500).json({ error: error.message || 'Failed to update calendar event' });
    }
});

// Delete event route
app.delete('/calendar/delete-event/:eventId', requireAuth, async (req, res) => {
    try {
        const { eventId } = req.params;
        
        // Get user's Google Calendar tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM google_calendar_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Google Calendar integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await googleCalendarService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE google_calendar_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Google Calendar token' });
            }
        }
        
        // Set credentials and delete event
        googleCalendarService.setCredentials({ access_token, refresh_token });
        
        await googleCalendarService.deleteEvent(eventId);
        res.json({ success: true, message: 'Event deleted successfully' });
        
    } catch (error) {
        console.error('Error deleting Google Calendar event:', error);
        res.status(500).json({ error: error.message || 'Failed to delete calendar event' });
    }
});

// Dashboard route
app.get('/dashboard', requireAuth, async (req, res) => {
    try {
        // Get complete user data from database
        const query = 'SELECT * FROM users WHERE username = $1';
        const result = await db.query(query, [req.session.user.email]);
        
        let userData = req.session.user;
        if (result.rows.length > 0) {
            const dbUser = result.rows[0];
            userData = {
                name: dbUser.name,
                email: dbUser.username,
                phone: dbUser.phone || '',
                bio: dbUser.bio || '',
                jobTitle: dbUser.job_title || '',
                company: dbUser.company || '',
                skills: dbUser.skills || '',
                avatar_url: dbUser.avatar_url || null
            };
        }
        
        res.render('index.ejs', {
            page: 'dashboard',
            user: userData
        });
        console.log('Dashboard accessed by:', req.session.user);
    } catch (error) {
        console.error('Error fetching user data for dashboard:', error);
        res.render('index.ejs', {
            page: 'dashboard',
            user: req.session.user
        });
    }
});

// Profile route
app.get('/profile', requireAuth, async (req, res) => {
    try {
        // Get complete user data from database
        const query = 'SELECT * FROM users WHERE username = $1';
        const result = await db.query(query, [req.session.user.email]);
        
        if (result.rows.length > 0) {
            const userData = result.rows[0];
            res.render('index.ejs', {
                page: 'profile',
                user: {
                    name: userData.name,
                    email: userData.username,
                    phone: userData.phone || '',
                    bio: userData.bio || '',
                    jobTitle: userData.job_title || '',
                    company: userData.company || '',
                    skills: userData.skills || '',
                    avatar_url: userData.avatar_url || null
                }
            });
        } else {
            // Fallback to session data if user not found in DB
            res.render('index.ejs', {
                page: 'profile',
                user: {
                    ...req.session.user,
                    phone: '',
                    bio: '',
                    jobTitle: '',
                    company: '',
                    skills: '',
                    avatar_url: null
                }
            });
        }
    } catch (error) {
        console.error('Error fetching user data:', error);
        // Fallback to session data
        res.render('index.ejs', {
            page: 'profile',
            user: {
                ...req.session.user,
                phone: '',
                bio: '',
                jobTitle: '',
                company: '',
                skills: '',
                avatar_url: null
            }
        });
    }
    console.log('Profile accessed by:', req.session.user);
});

app.get('/calendar', requireAuth, async (req, res) => {
    try {
        // Get complete user data from database
        const query = 'SELECT * FROM users WHERE username = $1';
        const result = await db.query(query, [req.session.user.email]);
        
        let userData = req.session.user;
        if (result.rows.length > 0) {
            const dbUser = result.rows[0];
            userData = {
                name: dbUser.name,
                email: dbUser.username,
                phone: dbUser.phone || '',
                bio: dbUser.bio || '',
                jobTitle: dbUser.job_title || '',
                company: dbUser.company || '',
                skills: dbUser.skills || '',
                avatar_url: dbUser.avatar_url || null
            };
        }
        
        res.render('index.ejs', {
            page: 'calendar',
            user: userData
        });
    } catch (error) {
        console.error('Error fetching user data for calendar:', error);
        res.render('index.ejs', {
            page: 'calendar',
            user: req.session.user
        });
    }
});

app.get('/tasks', requireAuth, async (req, res) => {
    try {
        // Get complete user data from database
        const query = 'SELECT * FROM users WHERE username = $1';
        const result = await db.query(query, [req.session.user.email]);
        
        let userData = req.session.user;
        if (result.rows.length > 0) {
            const dbUser = result.rows[0];
            userData = {
                name: dbUser.name,
                email: dbUser.username,
                phone: dbUser.phone || '',
                bio: dbUser.bio || '',
                jobTitle: dbUser.job_title || '',
                company: dbUser.company || '',
                skills: dbUser.skills || '',
                avatar_url: dbUser.avatar_url || null
            };
        }
        
        res.render('index.ejs', {
            page: 'tasks',
            user: userData
        });
    } catch (error) {
        console.error('Error fetching user data for tasks:', error);
        res.render('index.ejs', {
            page: 'tasks',
            user: req.session.user
        });
    }
});

app.get('/email', requireAuth, async (req, res) => {
    try {
        // Get complete user data from database
        const query = 'SELECT * FROM users WHERE username = $1';
        const result = await db.query(query, [req.session.user.email]);
        
        let userData = req.session.user;
        if (result.rows.length > 0) {
            const dbUser = result.rows[0];
            userData = {
                name: dbUser.name,
                email: dbUser.username,
                phone: dbUser.phone || '',
                bio: dbUser.bio || '',
                jobTitle: dbUser.job_title || '',
                company: dbUser.company || '',
                skills: dbUser.skills || '',
                avatar_url: dbUser.avatar_url || null
            };
        }
        
        res.render('index.ejs', {
            page: 'email',
            user: userData
        });
    } catch (error) {
        console.error('Error fetching user data for email:', error);
        res.render('index.ejs', {
            page: 'email',
            user: req.session.user
        });
    }
});

app.get('/email', requireAuth, async (req, res) => {
    try {
        // Get complete user data from database
        const query = 'SELECT * FROM users WHERE username = $1';
        const result = await db.query(query, [req.session.user.email]);
        
        let userData = req.session.user;
        if (result.rows.length > 0) {
            const dbUser = result.rows[0];
            userData = {
                name: dbUser.name,
                email: dbUser.username,
                phone: dbUser.phone || '',
                bio: dbUser.bio || '',
                jobTitle: dbUser.job_title || '',
                company: dbUser.company || '',
                skills: dbUser.skills || '',
                avatar_url: dbUser.avatar_url || null
            };
        }
        
        res.render('index.ejs', {
            page: 'email',
            user: userData
        });
    } catch (error) {
        console.error('Error fetching user data for email:', error);
        res.render('index.ejs', {
            page: 'email',
            user: req.session.user
        });
    }
});


// Gmail OAuth Routes
// OAuth authorization route for Gmail
app.get('/auth/google/gmail', requireAuth, (req, res) => {
    try {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback'
        );

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: [
                'https://www.googleapis.com/auth/gmail.readonly',
                'https://www.googleapis.com/auth/gmail.send',
                'https://www.googleapis.com/auth/gmail.modify',
                'https://www.googleapis.com/auth/userinfo.email'
            ],
            prompt: 'consent' // Force consent screen to get refresh token
        });

        res.redirect(authUrl);
    } catch (error) {
        console.error('Gmail OAuth authorization error:', error);
        res.redirect('/email?error=auth_failed');
    }
});

// OAuth callback route for Gmail
app.get('/auth/google/callback', async (req, res) => {
    const { code, error } = req.query;
    
    if (error) {
        console.error('OAuth error:', error);
        return res.redirect('/email?error=oauth_denied');
    }

    if (!code) {
        return res.redirect('/email?error=no_auth_code');
    }
    
    try {
        const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback'
        );

        // Exchange authorization code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        
        // Get user's Gmail email address
        oauth2Client.setCredentials(tokens);
        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        const gmailEmail = userInfo.data.email;
        
        // Store tokens in database
        const query = `
            INSERT INTO gmail_integration (user_email, access_token, refresh_token, expires_at, gmail_email, is_active)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (user_email) DO UPDATE SET
                access_token = $2, 
                refresh_token = $3, 
                expires_at = $4, 
                gmail_email = $5, 
                is_active = $6,
                updated_at = CURRENT_TIMESTAMP
        `;
        
        const values = [
            req.session.user.email,
            tokens.access_token,
            tokens.refresh_token,
            tokens.expiry_date ? new Date(tokens.expiry_date) : null,
            gmailEmail,
            true
        ];
        
        await db.query(query, values);

        console.log(`Gmail integration successful for user: ${req.session.user.email}`);
        res.redirect('/email?connected=true');
        
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.redirect('/email?error=oauth_failed');
    }
});

// Disconnect Gmail integration
app.post('/api/gmail/disconnect', requireAuth, async (req, res) => {
    try {
        await db.query(
            'UPDATE gmail_integration SET is_active = false WHERE user_email = $1',
            [req.session.user.email]
        );
        
        res.json({
            success: true,
            message: 'Gmail integration disconnected successfully'
        });
    } catch (error) {
        console.error('Error disconnecting Gmail:', error);
        res.status(500).json({
            success: false,
            message: 'Error disconnecting Gmail integration'
        });
    }
});

// Test Gmail connection
app.get('/api/gmail/test', requireAuth, async (req, res) => {
    try {
        // Get user's Gmail tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at, gmail_email FROM gmail_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Gmail integration not found' });
        }
        
        let { access_token, refresh_token, expires_at, gmail_email } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await gmailService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE gmail_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing Gmail token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Gmail token' });
            }
        }
        
        // Test Gmail connection by getting profile
        gmailService.setCredentials({ access_token, refresh_token });
        const profile = await gmailService.getProfile();
        
        res.json({
            success: true,
            connected: true,
            gmailEmail: gmail_email,
            profile: profile,
            message: 'Gmail connection is working correctly'
        });
        
    } catch (error) {
        console.error('Gmail connection test failed:', error);
        res.status(500).json({
            success: false,
            connected: false,
            error: 'Gmail connection test failed'
        });
    }
});


// Gmail API Routes
// Get Gmail integration status
app.get('/api/gmail/status', requireAuth, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT is_active, created_at, gmail_email FROM gmail_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        const isConnected = result.rows.length > 0;
        res.json({ 
            connected: isConnected,
            connectedSince: isConnected ? result.rows[0].created_at : null,
            gmailEmail: isConnected ? result.rows[0].gmail_email : null
        });
    } catch (error) {
        console.error('Error checking Gmail status:', error);
        res.status(500).json({ 
            connected: false,
            error: 'Failed to check status' 
        });
    }
});

// Sync emails from Gmail
// Helper function to process email attachments
async function processEmailAttachments(attachments, emailId, gmailMessageId, gmailService) {
    console.log(`Processing ${attachments.length} attachments for email ${emailId}`);
    
    for (const attachment of attachments) {
        try {
            console.log(`Processing attachment: ${attachment.filename} (${attachment.mimeType})`);
            
            // Skip if no attachment ID (shouldn't happen, but safety check)
            if (!attachment.attachmentId) {
                console.log(`Skipping attachment ${attachment.filename} - no attachment ID`);
                continue;
            }
            
            // Check if it's an image
            const isImage = gmailService.isImageMimeType(attachment.mimeType);
            console.log(`Attachment ${attachment.filename} is image: ${isImage}`);
            
            // For small images (under 1MB), download and store directly
            let attachmentData = null;
            let filePath = null;
            
            if (isImage && attachment.size < 1024 * 1024) { // 1MB limit
                try {
                    console.log(`Downloading attachment data for ${attachment.filename}`);
                    const downloadedAttachment = await gmailService.getAttachment(gmailMessageId, attachment.attachmentId);
                    attachmentData = Buffer.from(downloadedAttachment.data, 'base64');
                    console.log(`Downloaded ${attachmentData.length} bytes for ${attachment.filename}`);
                } catch (downloadError) {
                    console.error(`Error downloading attachment ${attachment.filename}:`, downloadError);
                    // Continue without the attachment data
                }
            }
            
            // Check if attachment already exists to prevent duplicates
            const existingAttachmentQuery = `
                SELECT id FROM email_attachments 
                WHERE email_id = $1 AND gmail_attachment_id = $2
            `;
            
            const existingAttachment = await db.query(existingAttachmentQuery, [emailId, attachment.attachmentId]);
            
            if (existingAttachment.rows.length > 0) {
                console.log(`Attachment ${attachment.filename} already exists for email ${emailId}, skipping`);
                continue;
            }
            
            // Insert attachment record
            const insertAttachmentQuery = `
                INSERT INTO email_attachments (
                    email_id, filename, original_filename, mime_type, file_size, attachment_data, 
                    gmail_attachment_id, is_inline, content_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id
            `;
            
            const attachmentValues = [
                emailId,
                attachment.filename,
                attachment.filename, // original_filename same as filename
                attachment.mimeType,
                attachment.size,
                attachmentData,
                attachment.attachmentId,
                attachment.isInline || false,
                attachment.contentId || null
            ];
            
            const result = await db.query(insertAttachmentQuery, attachmentValues);
            console.log(`Saved attachment ${attachment.filename} with ID ${result.rows[0].id}`);
            
        } catch (attachmentError) {
            console.error(`Error processing attachment ${attachment.filename}:`, attachmentError);
            // Continue with other attachments
        }
    }
}

app.post('/api/gmail/sync', requireAuth, async (req, res) => {
    try {
        const { maxResults = 50, query = '' } = req.body;
        
        // Get user's Gmail tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM gmail_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Gmail integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await gmailService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE gmail_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing Gmail token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Gmail token' });
            }
        }
        
        // Set credentials and get messages
        gmailService.setCredentials({ access_token, refresh_token });
        const messages = await gmailService.getMessages(query, maxResults);
        
        // Store messages in database
        const syncedEmails = [];
        for (const message of messages) {
            try {
                // Check if email already exists
                const existingEmail = await db.query(
                    'SELECT id FROM emails WHERE gmail_message_id = $1 AND user_email = $2',
                    [message.id, req.session.user.email]
                );
                
                if (existingEmail.rows.length === 0) {
                    // Insert new email
                    const insertQuery = `
                        INSERT INTO emails (
                            user_email, sender_email, recipient_email, cc_emails, bcc_emails,
                            subject, body, is_read, is_important, email_type, 
                            gmail_message_id, gmail_thread_id, gmail_labels, snippet, synced_from_gmail
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                        RETURNING *
                    `;
                    
                    const values = [
                        req.session.user.email,
                        message.from,
                        message.to,
                        message.cc || null,
                        message.bcc || null,
                        message.subject,
                        message.body,
                        message.isRead,
                        message.isImportant,
                        'received',
                        message.id,
                        message.threadId,
                        message.labels,
                        message.snippet,
                        true
                    ];
                    
                    const result = await db.query(insertQuery, values);
                    const newEmail = result.rows[0];
                    syncedEmails.push(newEmail);
                    
                    // Process attachments if they exist
                    if (message.attachments && message.attachments.length > 0) {
                        await processEmailAttachments(message.attachments, newEmail.id, message.id, gmailService);
                    }
                } else {
                    // Update existing email
                    const updateQuery = `
                        UPDATE emails SET 
                            is_read = $1, is_important = $2, gmail_labels = $3, 
                            snippet = $4, updated_at = CURRENT_TIMESTAMP
                        WHERE gmail_message_id = $5 AND user_email = $6
                        RETURNING *
                    `;
                    
                    const values = [
                        message.isRead,
                        message.isImportant,
                        message.labels,
                        message.snippet,
                        message.id,
                        req.session.user.email
                    ];
                    
                    const result = await db.query(updateQuery, values);
                    if (result.rows.length > 0) {
                        const updatedEmail = result.rows[0];
                        syncedEmails.push(updatedEmail);
                        
                        // Check if we need to process attachments for this existing email
                        if (message.attachments && message.attachments.length > 0) {
                            const existingAttachments = await db.query(
                                'SELECT gmail_attachment_id FROM email_attachments WHERE email_id = $1',
                                [updatedEmail.id]
                            );
                            const existingAttachmentIds = existingAttachments.rows.map(a => a.gmail_attachment_id);
                            const newAttachments = message.attachments.filter(a => !existingAttachmentIds.includes(a.attachmentId));
                            
                            if (newAttachments.length > 0) {
                                await processEmailAttachments(newAttachments, updatedEmail.id, message.id, gmailService);
                            }
                        }
                    }
                }
            } catch (emailError) {
                console.error(`Error processing email ${message.id}:`, emailError);
                // Continue with other emails
            }
        }
        
        res.json({
            success: true,
            syncedCount: syncedEmails.length,
            totalFetched: messages.length,
            emails: syncedEmails
        });
        
    } catch (error) {
        console.error('Error syncing Gmail messages:', error);
        res.status(500).json({ error: 'Failed to sync Gmail messages' });
    }
});

// Get email attachment
app.get('/api/emails/:emailId/attachments/:attachmentId', requireAuth, async (req, res) => {
    try {
        const { emailId, attachmentId } = req.params;
        
        // Verify the email belongs to the user
        const emailCheck = await db.query(
            'SELECT id FROM emails WHERE id = $1 AND user_email = $2',
            [emailId, req.session.user.email]
        );
        
        if (emailCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Email not found' });
        }
        
        // Get attachment
        const attachmentResult = await db.query(
            'SELECT * FROM email_attachments WHERE id = $1 AND email_id = $2',
            [attachmentId, emailId]
        );
        
        if (attachmentResult.rows.length === 0) {
            return res.status(404).json({ error: 'Attachment not found' });
        }
        
        const attachment = attachmentResult.rows[0];
        
        // If we have the attachment data stored, serve it directly
        if (attachment.attachment_data) {
            res.set({
                'Content-Type': attachment.mime_type,
                'Content-Length': attachment.attachment_data.length,
                'Content-Disposition': `inline; filename="${attachment.filename}"`
            });
            res.send(attachment.attachment_data);
        } else {
            // If we don't have the data stored, try to fetch it from Gmail
            try {
                // Get Gmail credentials for this user
                const tokenResult = await db.query(
                    'SELECT access_token, refresh_token FROM gmail_integration WHERE user_email = $1 AND is_active = true',
                    [req.session.user.email]
                );
                
                if (tokenResult.rows.length === 0) {
                    return res.status(401).json({ error: 'Gmail integration not found' });
                }
                
                const { access_token, refresh_token } = tokenResult.rows[0];
                gmailService.setCredentials({ access_token, refresh_token });
                
                // Get the Gmail message ID for this email
                const emailResult = await db.query(
                    'SELECT gmail_message_id FROM emails WHERE id = $1',
                    [emailId]
                );
                
                if (emailResult.rows.length === 0 || !emailResult.rows[0].gmail_message_id) {
                    return res.status(404).json({ error: 'Gmail message not found' });
                }
                
                const gmailMessageId = emailResult.rows[0].gmail_message_id;
                const downloadedAttachment = await gmailService.getAttachment(gmailMessageId, attachment.gmail_attachment_id);
                const attachmentBuffer = Buffer.from(downloadedAttachment.data, 'base64');
                
                // Store the attachment data for future requests (if it's small enough)
                if (attachmentBuffer.length < 1024 * 1024) { // 1MB limit
                    await db.query(
                        'UPDATE email_attachments SET attachment_data = $1 WHERE id = $2',
                        [attachmentBuffer, attachmentId]
                    );
                }
                
                res.set({
                    'Content-Type': attachment.mime_type,
                    'Content-Length': attachmentBuffer.length,
                    'Content-Disposition': `inline; filename="${attachment.filename}"`
                });
                res.send(attachmentBuffer);
                
            } catch (gmailError) {
                console.error('Error fetching attachment from Gmail:', gmailError);
                res.status(500).json({ error: 'Failed to fetch attachment' });
            }
        }
        
    } catch (error) {
        console.error('Error serving attachment:', error);
        res.status(500).json({ error: 'Failed to serve attachment' });
    }
});

// Get email attachments list
app.get('/api/emails/:emailId/attachments', requireAuth, async (req, res) => {
    try {
        const { emailId } = req.params;
        
        // Verify the email belongs to the user
        const emailCheck = await db.query(
            'SELECT id FROM emails WHERE id = $1 AND user_email = $2',
            [emailId, req.session.user.email]
        );
        
        if (emailCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Email not found' });
        }
        
        // Get attachments
        const attachmentsResult = await db.query(
            'SELECT id, filename, mime_type, file_size, is_inline, content_id FROM email_attachments WHERE email_id = $1 ORDER BY filename',
            [emailId]
        );
        
        res.json({
            success: true,
            attachments: attachmentsResult.rows
        });
        
    } catch (error) {
        console.error('Error fetching attachments:', error);
        res.status(500).json({ error: 'Failed to fetch attachments' });
    }
});

// Re-process existing emails for attachments
app.post('/api/gmail/reprocess-attachments', requireAuth, async (req, res) => {
    try {
        // Get user's Gmail tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM gmail_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Gmail integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await gmailService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE gmail_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing Gmail token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Gmail token' });
            }
        }
        
        // Set credentials
        gmailService.setCredentials({ access_token, refresh_token });
        
        // Get emails without attachments that have Gmail message IDs
        const emailsToProcess = await db.query(`
            SELECT e.id, e.gmail_message_id, e.subject
            FROM emails e
            LEFT JOIN email_attachments ea ON e.id = ea.email_id
            WHERE e.gmail_message_id IS NOT NULL 
            AND e.user_email = $1
            AND ea.id IS NULL
            ORDER BY e.created_at DESC
            LIMIT 20
        `, [req.session.user.email]);
        
        console.log(`Re-processing ${emailsToProcess.rows.length} emails for attachments`);
        
        let processedCount = 0;
        let attachmentsFound = 0;
        
        for (const email of emailsToProcess.rows) {
            try {
                console.log(`Re-processing email: ${email.subject} (ID: ${email.gmail_message_id})`);
                
                // Get full message details from Gmail
                const messageDetail = await gmailService.getMessage(email.gmail_message_id);
                
                if (messageDetail.attachments && messageDetail.attachments.length > 0) {
                    console.log(`Found ${messageDetail.attachments.length} attachments in email: ${email.subject}`);
                    await processEmailAttachments(messageDetail.attachments, email.id, email.gmail_message_id, gmailService);
                    attachmentsFound += messageDetail.attachments.length;
                }
                
                processedCount++;
                
            } catch (error) {
                console.error(`Error re-processing email ${email.id}:`, error);
                // Continue with other emails
            }
        }
        
        res.json({
            success: true,
            processedEmails: processedCount,
            totalAttachments: attachmentsFound,
            message: `Re-processed ${processedCount} emails and found ${attachmentsFound} attachments`
        });
        
    } catch (error) {
        console.error('Error re-processing attachments:', error);
        res.status(500).json({ error: 'Failed to re-process attachments' });
    }
});

// Debug endpoint to inspect Gmail message structure
app.get('/debug/gmail/:messageId', async (req, res) => {
    try {
        const { messageId } = req.params;
        console.log(`[DEBUG] Inspecting Gmail message: ${messageId}`);
        
        const gmailService = new GmailService();
        const rawMessage = await gmailService.getMessage(messageId);
        
        console.log(`[DEBUG] Raw message structure:`, JSON.stringify(rawMessage, null, 2));
        
        res.json({
            success: true,
            messageId,
            rawMessage
        });
    } catch (error) {
        console.error('[DEBUG] Error inspecting message:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Test endpoint for attachment debugging (temporary)
app.get('/test/attachments', async (req, res) => {
    try {
        const attachments = await db.query('SELECT * FROM email_attachments LIMIT 10');
        const emails = await db.query('SELECT id, subject, gmail_message_id FROM emails LIMIT 10');
        
        res.json({
            success: true,
            emails: emails.rows,
            attachments: attachments.rows,
            totalAttachments: attachments.rows.length
        });
    } catch (error) {
        console.error('Error in test endpoint:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get Gmail profile information
app.get('/api/gmail/profile', requireAuth, async (req, res) => {
    try {
        // Get user's Gmail tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM gmail_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Gmail integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await gmailService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE gmail_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing Gmail token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Gmail token' });
            }
        }
        
        // Set credentials and get profile
        gmailService.setCredentials({ access_token, refresh_token });
        const profile = await gmailService.getProfile();
        
        res.json({
            success: true,
            profile: profile
        });
        
    } catch (error) {
        console.error('Error fetching Gmail profile:', error);
        res.status(500).json({ error: 'Failed to fetch Gmail profile' });
    }
});

// Send email via Gmail
app.post('/api/gmail/send', requireAuth, async (req, res) => {
    try {
        const { to, cc, bcc, subject, body } = req.body;
        
        if (!to || !subject || !body) {
            return res.status(400).json({
                success: false,
                message: 'To, subject, and body are required'
            });
        }
        
        // Get user's Gmail tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM gmail_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Gmail integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            try {
                const refreshedTokens = await gmailService.refreshAccessToken(refresh_token);
                access_token = refreshedTokens.access_token;
                
                // Update tokens in database
                const newExpiresAt = refreshedTokens.expiry_date ? new Date(refreshedTokens.expiry_date) : null;
                await db.query(
                    'UPDATE gmail_integration SET access_token = $1, expires_at = $2 WHERE user_email = $3',
                    [refreshedTokens.access_token, newExpiresAt, req.session.user.email]
                );
            } catch (refreshError) {
                console.error('Error refreshing Gmail token:', refreshError);
                return res.status(401).json({ error: 'Failed to refresh Gmail token' });
            }
        }
        
        // Set credentials and send email
        gmailService.setCredentials({ access_token, refresh_token });
        const sentMessage = await gmailService.sendMessage({ to, cc, bcc, subject, body });
        
        // Store sent email in database
        const insertQuery = `
            INSERT INTO emails (
                user_email, sender_email, recipient_email, cc_emails, bcc_emails,
                subject, body, is_read, is_important, email_type, 
                gmail_message_id, synced_from_gmail
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            RETURNING *
        `;
        
        const values = [
            req.session.user.email,
            req.session.user.email,
            to,
            cc || null,
            bcc || null,
            subject,
            body,
            true, // Sent emails are marked as read
            false,
            'sent',
            sentMessage.id,
            true
        ];
        
        const result = await db.query(insertQuery, values);
        
        res.json({
            success: true,
            message: 'Email sent successfully via Gmail',
            email: result.rows[0],
            gmailMessageId: sentMessage.id
        });
        
    } catch (error) {
        console.error('Error sending Gmail message:', error);
        res.status(500).json({ error: 'Failed to send email via Gmail' });
    }
});

// Mark Gmail message as read/unread
app.put('/api/gmail/messages/:messageId/read', requireAuth, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { isRead } = req.body;
        
        // Get user's Gmail tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token FROM gmail_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Gmail integration not found' });
        }
        
        const { access_token, refresh_token } = tokenResult.rows[0];
        
        // Set credentials and mark as read/unread
        gmailService.setCredentials({ access_token, refresh_token });
        
        if (isRead) {
            await gmailService.markAsRead(messageId);
        } else {
            await gmailService.markAsUnread(messageId);
        }
        
        // Update local database
        await db.query(
            'UPDATE emails SET is_read = $1, updated_at = CURRENT_TIMESTAMP WHERE gmail_message_id = $2 AND user_email = $3',
            [isRead, messageId, req.session.user.email]
        );
        
        res.json({
            success: true,
            message: `Message marked as ${isRead ? 'read' : 'unread'}`
        });
        
    } catch (error) {
        console.error('Error updating Gmail message read status:', error);
        res.status(500).json({ error: 'Failed to update message status' });
    }
});

// Delete Gmail message
app.delete('/api/gmail/messages/:messageId', requireAuth, async (req, res) => {
    try {
        const { messageId } = req.params;
        
        // Get user's Gmail tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token FROM gmail_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Gmail integration not found' });
        }
        
        const { access_token, refresh_token } = tokenResult.rows[0];
        
        // Set credentials and delete message
        gmailService.setCredentials({ access_token, refresh_token });
        await gmailService.deleteMessage(messageId);
        
        // Update local database
        await db.query(
            'DELETE FROM emails WHERE gmail_message_id = $1 AND user_email = $2',
            [messageId, req.session.user.email]
        );
        
        res.json({
            success: true,
            message: 'Gmail message deleted successfully'
        });
        
    } catch (error) {
        console.error('Error deleting Gmail message:', error);
        res.status(500).json({ error: 'Failed to delete Gmail message' });
    }
});


// Email API Routes
// Get all emails for the authenticated user
app.get('/api/emails', requireAuth, async (req, res) => {
    try {
        const { filter, search } = req.query;
        let query = 'SELECT * FROM emails WHERE user_email = $1';
        let params = [req.session.user.email];
        
        // Apply filters
        if (filter === 'unread') {
            query += ' AND is_read = FALSE';
        } else if (filter === 'read') {
            query += ' AND is_read = TRUE';
        } else if (filter === 'important') {
            query += ' AND is_important = TRUE';
        }
        
        // Apply search
        if (search) {
            query += ' AND (subject ILIKE $' + (params.length + 1) + ' OR sender_email ILIKE $' + (params.length + 1) + ' OR body ILIKE $' + (params.length + 1) + ')';
            params.push(`%${search}%`);
        }
        
        query += ' ORDER BY created_at DESC';
        
        const result = await db.query(query, params);
        res.json({
            success: true,
            emails: result.rows
        });
    } catch (error) {
        console.error('Error fetching emails:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching emails'
        });
    }
});



app.get('/api/google/emails', requireAuth, async (req, res) => {
   try {
        const { title, description, start, end, location, attendees } = req.body;
        
        // Get user's Google Calendar tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token FROM google_calendar_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Google Calendar integration not found' });
        }
        
        const { access_token, refresh_token } = tokenResult.rows[0];
        
        // Create event
        googleCalendarService.setCredentials({ access_token, refresh_token });
        const eventData = {
            title,
            description,
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
            location,
            attendees: attendees || []
        };
        
        const createdEvent = await googleCalendarService.createEvent(eventData);
        res.json({ success: true, event: createdEvent });
        
    } catch (error) {
        console.error('Error creating Google Calendar event:', error);
        res.status(500).json({ error: 'Failed to create calendar event' });
    }
});


// Send/Save email
app.post('/api/emails', requireAuth, async (req, res) => {
    try {
        const { to, cc, bcc, subject, body, isImportant, isDraft } = req.body;
        
        if (!to || !subject || !body) {
            return res.status(400).json({
                success: false,
                message: 'To, subject, and body are required'
            });
        }
        
        const query = `
            INSERT INTO emails (user_email, sender_email, recipient_email, cc_emails, bcc_emails, subject, body, is_important, is_draft, email_type)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `;
        
        const values = [
            req.session.user.email, // user_email (owner)
            req.session.user.email, // sender_email
            to, // recipient_email
            cc || null, // cc_emails
            bcc || null, // bcc_emails
            subject,
            body,
            isImportant || false,
            isDraft || false,
            isDraft ? 'draft' : 'sent'
        ];
        
        const result = await db.query(query, values);
        
        res.json({
            success: true,
            message: isDraft ? 'Draft saved successfully' : 'Email sent successfully',
            email: result.rows[0]
        });
    } catch (error) {
        console.error('Error sending/saving email:', error);
        res.status(500).json({
            success: false,
            message: 'Error sending email'
        });
    }
});

// Mark email as read/unread
app.put('/api/emails/:id/read', requireAuth, async (req, res) => {
    try {
        const emailId = parseInt(req.params.id);
        const { isRead } = req.body;
        
        const query = 'UPDATE emails SET is_read = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_email = $3 RETURNING *';
        const result = await db.query(query, [isRead, emailId, req.session.user.email]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Email not found'
            });
        }
        
        res.json({
            success: true,
            email: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating email read status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating email'
        });
    }
});

// Mark email as important/unimportant
app.put('/api/emails/:id/important', requireAuth, async (req, res) => {
    try {
        const emailId = parseInt(req.params.id);
        const { isImportant } = req.body;
        
        const query = 'UPDATE emails SET is_important = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_email = $3 RETURNING *';
        const result = await db.query(query, [isImportant, emailId, req.session.user.email]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Email not found'
            });
        }
        
        res.json({
            success: true,
            email: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating email importance:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating email'
        });
    }
});

// Delete email
app.delete('/api/emails/:id', requireAuth, async (req, res) => {
    try {
        const emailId = parseInt(req.params.id);
        
        const query = 'DELETE FROM emails WHERE id = $1 AND user_email = $2 RETURNING *';
        const result = await db.query(query, [emailId, req.session.user.email]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Email not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Email deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting email:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting email'
        });
    }
});

// Get single email
app.get('/api/emails/:id', requireAuth, async (req, res) => {
    try {
        const emailId = parseInt(req.params.id);
        
        const query = 'SELECT * FROM emails WHERE id = $1 AND user_email = $2';
        const result = await db.query(query, [emailId, req.session.user.email]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Email not found'
            });
        }
        
        res.json({
            success: true,
            email: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching email:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching email'
        });
    }
});

// Profile update route
app.put('/api/profile', requireAuth, async (req, res) => {
    try {
        const { name, email, phone, bio, jobTitle, company, skills } = req.body;
        
        // Update user in database
        const query = `
            UPDATE users 
            SET name = $1, username = $2, phone = $3, bio = $4, job_title = $5, company = $6, skills = $7
            WHERE username = $8
            RETURNING avatar_url
        `;
        const values = [name, email, phone, bio, jobTitle, company, skills, req.session.user.email];
        
        const result = await db.query(query, values);
        
        // Update session data
        req.session.user = {
            name: name,
            email: email
        };
        
        res.json({ 
            success: true, 
            message: 'Profile updated successfully',
            avatar_url: result.rows[0]?.avatar_url
        });
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error updating profile' 
        });
    }
});


// Avatar upload route
app.post('/api/upload-avatar', requireAuth, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                message: 'No file uploaded' 
            });
        }

        // Generate the URL path for the uploaded file
        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        
        // Update user's avatar_url in database
        const query = `
            UPDATE users 
            SET avatar_url = $1 
            WHERE username = $2
            RETURNING avatar_url
        `;
        const values = [avatarUrl, req.session.user.email];
        
        const result = await db.query(query, values);
        
        res.json({ 
            success: true, 
            message: 'Avatar uploaded successfully',
            avatar_url: result.rows[0]?.avatar_url
        });
    } catch (error) {
        console.error('Error uploading avatar:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error uploading avatar' 
        });
    }
});

// Translations API route
app.get('/api/translations/:lang', (req, res) => {
    try {
        const requestedLang = req.params.lang || 'en';
        const supportedLanguages = ['en', 'es', 'fr', 'de'];
        
        // Default to English if language not supported
        const lang = supportedLanguages.includes(requestedLang) ? requestedLang : 'en';
        
        // Read translation file
        const translationPath = path.join(__dirname, 'translations', `${lang}.json`);
        
        if (fs.existsSync(translationPath)) {
            const translations = JSON.parse(fs.readFileSync(translationPath, 'utf8'));
            
            // Flatten the nested object for easier frontend access
            const flatTranslations = {};
            
            function flatten(obj, prefix = '') {
                for (const key in obj) {
                    if (typeof obj[key] === 'object' && obj[key] !== null) {
                        flatten(obj[key], prefix + key + '.');
                    } else {
                        flatTranslations[prefix + key] = obj[key];
                    }
                }
            }
            
            flatten(translations);
            
            res.json({
                success: true,
                language: lang,
                translations: flatTranslations
            });
        } else {
            // Fallback to English if file doesn't exist
            const fallbackPath = path.join(__dirname, 'translations', 'en.json');
            const translations = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
            
            const flatTranslations = {};
            function flatten(obj, prefix = '') {
                for (const key in obj) {
                    if (typeof obj[key] === 'object' && obj[key] !== null) {
                        flatten(obj[key], prefix + key + '.');
                    } else {
                        flatTranslations[prefix + key] = obj[key];
                    }
                }
            }
            
            flatten(translations);
            
            res.json({
                success: true,
                language: 'en',
                translations: flatTranslations
            });
        }
    } catch (error) {
        console.error('Error loading translations:', error);
        res.status(500).json({
            success: false,
            message: 'Error loading translations'
        });
    }
});

// Default translations route (defaults to English)
app.get('/api/translations', (req, res) => {
    res.redirect('/api/translations/en');
});

// Task Management API Routes

// Get all tasks for the authenticated user
app.get('/api/tasks', requireAuth, async (req, res) => {
    try {
        const query = 'SELECT * FROM tasks WHERE user_email = $1 ORDER BY created_at DESC';
        const result = await db.query(query, [req.session.user.email]);
        
        res.json({
            success: true,
            tasks: result.rows
        });
    } catch (error) {
        console.error('Error fetching tasks:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching tasks'
        });
    }
});

// Create a new task
app.post('/api/tasks', requireAuth, async (req, res) => {
    try {
        const { text, source = 'user' } = req.body;
        
        if (!text || text.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Task text is required'
            });
        }

        // Validate source
        const validSources = ['user', 'google_tasks', 'microsoft_todo', 'calendar_integration'];
        const taskSource = validSources.includes(source) ? source : 'user';
        
        const query = `
            INSERT INTO tasks (user_email, text, completed, source)
            VALUES ($1, $2, false, $3)
            RETURNING *
        `;
        const values = [req.session.user.email, text.trim(), taskSource];
        const result = await db.query(query, values);
        
        res.json({
            success: true,
            task: result.rows[0],
            message: 'Task created successfully'
        });
    } catch (error) {
        console.error('Error creating task:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating task'
        });
    }
});

// Update a task (text or completion status)
app.put('/api/tasks/:id', requireAuth, async (req, res) => {
    try {
        const taskId = parseInt(req.params.id);
        const { text, completed, source } = req.body;
        
        // First check if the task belongs to the user
        const checkQuery = 'SELECT * FROM tasks WHERE id = $1 AND user_email = $2';
        const checkResult = await db.query(checkQuery, [taskId, req.session.user.email]);
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Task not found'
            });
        }

        // Validate source if provided
        const validSources = ['user', 'google_tasks', 'microsoft_todo', 'calendar_integration'];
        const validatedSource = source && validSources.includes(source) ? source : undefined;
        
        // Build dynamic update query based on provided fields
        const updateFields = [];
        const values = [];
        let valueIndex = 1;
        
        if (text !== undefined) {
            updateFields.push(`text = $${valueIndex++}`);
            values.push(text.trim());
        }
        
        if (completed !== undefined) {
            updateFields.push(`completed = $${valueIndex++}`);
            values.push(completed);
        }
        
        if (validatedSource !== undefined) {
            updateFields.push(`source = $${valueIndex++}`);
            values.push(validatedSource);
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid update data provided'
            });
        }
        
        // Add WHERE clause parameters
        values.push(taskId, req.session.user.email);
        
        const updateQuery = `
            UPDATE tasks 
            SET ${updateFields.join(', ')} 
            WHERE id = $${valueIndex++} AND user_email = $${valueIndex++} 
            RETURNING *
        `;
        
        const result = await db.query(updateQuery, values);
        
        res.json({
            success: true,
            task: result.rows[0],
            message: 'Task updated successfully'
        });
    } catch (error) {
        console.error('Error updating task:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating task'
        });
    }
});

// Delete a task
app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
    try {
        const taskId = parseInt(req.params.id);
        
        // First check if the task belongs to the user, then delete
        const query = 'DELETE FROM tasks WHERE id = $1 AND user_email = $2 RETURNING *';
        const result = await db.query(query, [taskId, req.session.user.email]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Task not found'
            });
        }
        
        res.json({
            success: true,
            message: 'Task deleted successfully',
            deletedTask: result.rows[0]
        });
    } catch (error) {
        console.error('Error deleting task:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting task'
        });
    }
});

// Bulk operations for tasks
app.post('/api/tasks/bulk', requireAuth, async (req, res) => {
    try {
        const { action, taskIds } = req.body;
        
        if (!action || !taskIds || !Array.isArray(taskIds)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid bulk operation request'
            });
        }
        
        let query;
        let values;
        
        switch (action) {
            case 'complete':
                query = 'UPDATE tasks SET completed = true WHERE id = ANY($1) AND user_email = $2 RETURNING *';
                values = [taskIds, req.session.user.email];
                break;
            case 'uncomplete':
                query = 'UPDATE tasks SET completed = false WHERE id = ANY($1) AND user_email = $2 RETURNING *';
                values = [taskIds, req.session.user.email];
                break;
            case 'delete':
                query = 'DELETE FROM tasks WHERE id = ANY($1) AND user_email = $2 RETURNING *';
                values = [taskIds, req.session.user.email];
                break;
            default:
                return res.status(400).json({
                    success: false,
                    message: 'Invalid bulk action'
                });
        }
        
        const result = await db.query(query, values);
        
        res.json({
            success: true,
            affectedTasks: result.rows,
            message: `Bulk ${action} operation completed successfully`
        });
    } catch (error) {
        console.error('Error performing bulk operation:', error);
        res.status(500).json({
            success: false,
            message: 'Error performing bulk operation'
        });
    }
});

// Google Tasks integration (placeholder for future implementation)

// Get Google Tasks integration status
app.get('/api/google/tasks/status', requireAuth, async (req, res) => {
    try {
        const result = await db.query(
            'SELECT is_active, created_at, task_info FROM google_tasks_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        const isConnected = result.rows.length > 0;
        res.json({ 
            connected: isConnected,
            connectedSince: isConnected ? result.rows[0].created_at : null,
            taskInfo: isConnected ? result.rows[0].task_info : null
        });
    } catch (error) {
        console.error('Error checking Google Tasks status:', error);
        res.status(500).json({ 
            connected: false,
            error: 'Failed to check status' 
        });
    }
});

// Sync tasks from Google Tasks
app.post('/api/google/tasks/sync', requireAuth, async (req, res) => {
    try {
        // Get user's Google Tasks tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token, expires_at FROM google_tasks_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Google Tasks integration not found' });
        }
        
        let { access_token, refresh_token, expires_at } = tokenResult.rows[0];
        
        // Check if token needs refresh
        if (expires_at && new Date() >= new Date(expires_at)) {
            // You'll need to implement token refresh for Google Tasks
            // Similar to your calendar refresh logic
        }
        
        // Fetch tasks from Google Tasks API
        const response = await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error(`Google Tasks API error: ${response.status}`);
        }
        
        const googleTasks = await response.json();
        
        // Store/update tasks in your database
        const syncedTasks = [];
        for (const googleTask of googleTasks.items || []) {
            // Check if task already exists
            const existingTask = await db.query(
                'SELECT id FROM tasks WHERE google_task_id = $1 AND user_email = $2',
                [googleTask.id, req.session.user.email]
            );
            
            if (existingTask.rows.length === 0) {
                // Insert new task
                const insertResult = await db.query(
                    'INSERT INTO tasks (user_email, text, completed, source, google_task_id, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                    [
                        req.session.user.email,
                        googleTask.title,
                        googleTask.status === 'completed',
                        'google_tasks',
                        googleTask.id,
                        new Date()
                    ]
                );
                syncedTasks.push(insertResult.rows[0]);
            } else {
                // Update existing task
                const updateResult = await db.query(
                    'UPDATE tasks SET text = $1, completed = $2, updated_at = $3 WHERE google_task_id = $4 AND user_email = $5 RETURNING *',
                    [
                        googleTask.title,
                        googleTask.status === 'completed',
                        new Date(),
                        googleTask.id,
                        req.session.user.email
                    ]
                );
                syncedTasks.push(updateResult.rows[0]);
            }
        }
        
        res.json({ 
            success: true, 
            syncedCount: syncedTasks.length,
            tasks: syncedTasks
        });
        
    } catch (error) {
        console.error('Error syncing Google Tasks:', error);
        res.status(500).json({ error: 'Failed to sync Google Tasks' });
    }
});

// Push task to Google Tasks
app.post('/api/google/tasks/push', requireAuth, async (req, res) => {
    try {
        const { taskId } = req.body;
        
        // Get the task
        const taskResult = await db.query(
            'SELECT * FROM tasks WHERE id = $1 AND user_email = $2',
            [taskId, req.session.user.email]
        );
        
        if (taskResult.rows.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }
        
        const task = taskResult.rows[0];
        
        // Get user's Google Tasks tokens
        const tokenResult = await db.query(
            'SELECT access_token, refresh_token FROM google_tasks_integration WHERE user_email = $1 AND is_active = true',
            [req.session.user.email]
        );
        
        if (tokenResult.rows.length === 0) {
            return res.status(401).json({ error: 'Google Tasks integration not found' });
        }
        
        const { access_token } = tokenResult.rows[0];
        
        // Create task in Google Tasks
        const googleTaskData = {
            title: task.text,
            status: task.completed ? 'completed' : 'needsAction'
        };
        
        const response = await fetch('https://tasks.googleapis.com/tasks/v1/lists/@default/tasks', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(googleTaskData)
        });
        
        if (!response.ok) {
            throw new Error(`Google Tasks API error: ${response.status}`);
        }
        
        const createdGoogleTask = await response.json();
        
        // Update local task with Google Task ID
        await db.query(
            'UPDATE tasks SET google_task_id = $1, source = $2 WHERE id = $3',
            [createdGoogleTask.id, 'google_tasks', taskId]
        );
        
        res.json({ 
            success: true, 
            googleTaskId: createdGoogleTask.id
        });
        
    } catch (error) {
        console.error('Error pushing task to Google Tasks:', error);
        res.status(500).json({ error: 'Failed to push task to Google Tasks' });
    }
});

// Logout route
app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        // Redirect to public site
        res.redirect('http://localhost:3000/');
    });
});

// Default redirect to dashboard
app.get('/', requireAuth, (req, res) => {
    res.redirect('/dashboard');
});

// Database connection and server startup
async function startServer() {
    try {
        await db.connect();
        console.log('Connected to the database successfully');
        
        app.listen(port, () => {
            console.log(`Private Zone App is running at http://localhost:${port}`);
        });
    } catch (error) {
        console.error('Error connecting to the database:', error);
        process.exit(1);
    }
}

startServer();
//