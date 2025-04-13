# Neura - Google Gemini Live API Integration

A full-stack application demonstrating the integration of Google's Gemini Live API with a secure authentication system.

## Project Overview

This project implements a backend-based integration with Google's Gemini Live API, demonstrating best practices for:

- API key security (backend-only access)
- Real-time streaming of AI responses via WebSockets
- Google OAuth authentication with restricted access
- Clean separation of frontend and backend responsibilities

## Repository Structure

The project consists of two main parts:

- `neura-backend/`: Node.js/Express backend with Gemini Live API integration
- `neura-frontend/`: Next.js/React frontend with WebSocket client

## Why Backend Integration?

While client-side integration is possible, we chose a backend-based integration for several reasons:

1. **API Key Security**: Keeps API keys secure on the server side
2. **Rate Limiting & Caching**: Centralized control of API usage
3. **Access Control**: Ability to restrict access to specific users
4. **Consistent Interface**: Backend can evolve while maintaining a stable API
5. **Cross-platform Support**: Same backend can serve web, mobile, and desktop clients

## Quick Start

### Backend Setup

```bash
# Install dependencies
cd neura-backend
npm install

# Create .env.local file (see .env.example)
# Then start the development server
npm run dev
```

Required environment variables:

- `GEMINI_API_KEY`: Your Google Gemini API key
- `GOOGLE_CLIENT_ID`: OAuth client ID
- `GOOGLE_CLIENT_SECRET`: OAuth client secret
- `JWT_SECRET`: Secret for JWT token generation
- `ALLOWED_EMAIL`: Email allowed to access the app

### Frontend Setup

```bash
# Install dependencies
cd neura-frontend
npm install

# Create .env.local file (see .env.example)
# Then start the development server
npm run dev
```

Required environment variables:

- `NEXT_PUBLIC_API_URL`: Backend API URL (default: http://localhost:3001)
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`: Google OAuth client ID

### Using the Application

1. Start both backend and frontend servers
2. Navigate to `http://localhost:3000` in your browser
3. Sign in with Google (must use the allowed email)
4. Start chatting with Gemini's AI

## API Documentation

See the README files in each project directory for detailed API documentation:

- [Backend API Documentation](neura-backend/README.md)
- [Frontend Documentation](neura-frontend/README.md)

## Setting Up Google Cloud

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the required APIs:
   - Gemini API
   - OAuth2 API
3. Create credentials:
   - API key for Gemini
   - OAuth Client ID for authentication

## Security Considerations

- Keep API keys and secrets secure
- Only use HTTPS in production
- The application restricts access to the specific email in your environment variables
- Consider additional security measures for production use

## License

MIT
