# ContractIQ — Setup Guide

## Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)
- npm

---

## 1. Backend Setup

```bash
cd server
npm install
cp .env.example .env   # then edit .env with your values
```

### Configure `.env`:
| Variable | Required | Notes |
|---|---|---|
| `MONGODB_URI` | Yes | Local: `mongodb://localhost:27017/clm_db` |
| `JWT_SECRET` | Yes | Long random string — change in production |
| `SMTP_USER` | Optional | Gmail / SMTP credentials for email |
| `SMTP_PASS` | Optional | App password (not account password) |
| `HF_API_KEY` | Optional | Hugging Face token for AI features |
| `ENCRYPTION_KEY` | Yes | Exactly 32 characters |

### Start backend:
```bash
npm run dev    # development (with nodemon auto-restart)
npm start      # production
```

Backend runs at: **http://localhost:5000**

---

## 2. Frontend Setup

```bash
# From project root
NODE_ENV=development npm install
NODE_ENV=development npm run dev
```

Frontend runs at: **http://localhost:5173**

---

## 3. Create First Admin User

```bash
# Using curl or any REST client
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Admin User","email":"admin@company.com","password":"SecurePass123","role":"admin"}'
```

---

## 4. Features Overview

| Module | Route | Description |
|---|---|---|
| Dashboard | `/` | KPIs, charts, pipeline |
| Contracts | `/contracts` | Full contract lifecycle management |
| Tasks | `/tasks` | Assign, track, complete tasks |
| Legal Folder | `/legal-folder` | Approved documents store |
| Signing | `/signing` | Canvas/upload digital signatures |
| AI Assistant | `/ai` | Natural language document navigation |
| Notifications | `/notifications` | Real-time in-app notifications |
| Templates | `/templates` | MOA/MOI/NDA templates + Draft |
| Reports | `/reports` | Task/contract analytics |
| Settings | `/settings` | Users, roles, permissions |

---

## 5. Email Configuration (Gmail)

1. Enable 2FA on your Gmail account
2. Create an App Password: Google Account → Security → App Passwords
3. Set `SMTP_USER=your@gmail.com` and `SMTP_PASS=your-app-password`

Without SMTP config, emails are logged to console (mock mode).

---

## 6. AI Configuration

The assistant is local-first by default: `ACTIVE_MODEL_PROVIDER=local` runs the configured GGUF model through the local runtime and verifies model files with SHA-256 before use.

Optional Hugging Face cloud inference is disabled unless you explicitly set `ACTIVE_MODEL_PROVIDER=huggingface` and `ALLOW_CLOUD_AI=true`. Only enable this after confirming that contract and Legal Folder content may leave your environment.

Useful safety limits are in `server/.env.example`: `AI_CHAT_RATE_LIMIT_MAX`, `AI_MAX_MESSAGE_CHARS`, `AI_RAG_MAX_SYNC_TOTAL_CHARS`, and `AI_REDACT_RAG_PII`.

---

## 7. Directory Structure

```
Law-Contract-Managment/
├── server/                 # Backend (Node.js/Express)
│   ├── src/
│   │   ├── config/         # Database connection
│   │   ├── middleware/     # Auth, upload, RBAC
│   │   ├── models/         # MongoDB schemas
│   │   ├── routes/         # API endpoints
│   │   └── services/       # Email, AI, signing, expiry
│   ├── uploads/            # Uploaded files
│   ├── legal-folder/       # Approved documents
│   └── templates/          # Contract templates
├── src/                    # Frontend (React/Vite)
│   ├── components/
│   │   ├── Auth/           # Login
│   │   ├── Tasks/          # Task management
│   │   ├── Documents/      # Document manager + Legal folder
│   │   ├── Signing/        # Digital signing + canvas
│   │   ├── AI/             # AI assistant chat
│   │   └── Notifications/  # Notification center
│   ├── context/            # Auth + Notification contexts
│   └── services/           # API client (fetch wrapper)
└── SETUP.md
```
