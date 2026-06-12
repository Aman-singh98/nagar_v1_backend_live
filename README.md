# Nagar — Backend API

The backend service for **Nagar**, a field employee tracking and management system. It powers real-time location tracking, geofence-based visit verification, route assignment, authentication, and reporting for the Nagar Admin Dashboard and the Nagar Field Tracking mobile app.

## Overview

Nagar helps businesses that deploy employees to multiple locations daily — sales teams, delivery agents, service technicians, and survey workers. Managers assign routes with GPS-fenced stops via the admin dashboard, and field employees use the mobile app to navigate their routes. Visits are automatically verified when an employee enters the assigned geofence.

This repository contains the REST API and real-time server that both client apps communicate with.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB with Mongoose ORM
- **Real-time:** Socket.IO (live location updates, attendance events)
- **Authentication:** JWT (jsonwebtoken) + bcrypt for password hashing
- **Push Notifications:** Firebase Admin SDK
- **Validation:** Joi
- **Security:** Helmet
- **Scheduled Jobs:** node-cron (e.g., daily reports, route resets)
- **Reporting:** PDFKit (PDF report generation)
- **Deployment:** Hosted live (production backend)

## Features

- 🔐 JWT-based authentication & role-based access (Admin / Employee)
- 📍 Real-time GPS location tracking via Socket.IO
- 🗺️ Geofence-based automatic visit/check-in verification
- 🧭 Route and stop assignment management
- 🔔 Push notifications via Firebase Cloud Messaging
- 📊 Attendance and visit reports (PDF export)
- ⏰ Automated scheduled tasks via cron jobs
- 🛡️ Secured with Helmet, input validation via Joi

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- MongoDB instance (local or Atlas)
- Firebase project credentials (for push notifications)

### Installation

```bash
# Clone the repository
git clone https://github.com/Aman-singh98/nagar_v1_backend_live.git
cd nagar_v1_backend_live

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
```

### Environment Variables

Create a `.env` file in the root directory with the following:

```env
PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=7d
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=your_firebase_client_email
FIREBASE_PRIVATE_KEY=your_firebase_private_key
```

### Running the Server

```bash
# Development
npm run dev

# Production
npm start
```

The server will start on `http://localhost:5000` (or the port specified in `.env`).

## API Overview

The API exposes RESTful endpoints for:

- **Auth** — register, login, token refresh
- **Users** — employee and admin management
- **Routes** — create and assign routes/stops
- **Tracking** — live location updates and geofence checks
- **Reports** — generate and export attendance/visit reports

> Detailed API documentation (Postman collection / Swagger) coming soon.

## Related Repositories

- **Admin Dashboard:** [Nagar](https://github.com/Aman-singh98/Nagar)
- **Field Tracking App (React Native):** [nagar-field-tracking](https://github.com/Aman-singh98/nagar-field-tracking)

## Author

**Aman Singh**
- GitHub: [@Aman-singh98](https://github.com/Aman-singh98)

## License

This project is currently unlicensed. All rights reserved.
