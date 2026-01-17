# Service Management Backend

Node.js + Express + MongoDB backend for the Service Management Portal (Project Manager / Procurement Officer / Resource Planner).

## Features

- JWT authentication (register, login, change password)
- Service Requests workflow (Draft → InReview → OpenForOffers → Evaluating → Selected)
- Offers management (provider offers, select preferred offer)
- Service Orders (create, substitute specialist, extend)
- Role-based notifications (ProjectManager, ProcurementOfficer, ResourcePlanner)
- Real-time notifications via Socket.IO

## Setup

1. Copy `.env.example` to `.env` and fill in:

```bash
MONGO_URI=your_mongodb_connection
JWT_SECRET=your_super_secret_key
PORT=8000
```

2. Install dependencies:

```bash
npm install
```

3. Start server:

```bash
npm run dev
```

Backend will run on `http://localhost:8000`.

Make sure your Next.js frontend is configured to call this backend URL.