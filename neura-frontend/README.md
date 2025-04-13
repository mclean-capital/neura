# Neura Frontend

A Next.js frontend application for Neura, providing a user interface to interact with the Gemini Live API through WebSockets.

## Features

- **React & Next.js**: Modern frontend framework with server-side rendering
- **Google Authentication**: Secure login with Google OAuth
- **Real-time AI Chat**: WebSocket-based chat interface with streaming responses
- **Responsive Design**: Works on desktop and mobile devices
- **Dark Mode**: Easy on the eyes, suitable for extended use

## Prerequisites

- Node.js (v16+)
- npm or yarn
- Google Cloud account with OAuth credentials
- Running instance of the Neura backend server

## Setup

1. Clone the repository or download the source code
2. Install dependencies:

```bash
npm install
```

3. Create a `.env.local` file in the root directory based on `.env.example`:

```bash
# Backend API URL
NEXT_PUBLIC_API_URL=http://localhost:3001

# Google OAuth Client ID (from Google Cloud Console)
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your_google_client_id_here

# Restriction (email that's allowed to access the application)
NEXT_PUBLIC_ALLOWED_EMAIL=your_email@gmail.com
```

## Getting Google OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to "APIs & Services" > "Credentials"
4. Click "Create Credentials" > "OAuth client ID"
5. Set up the OAuth consent screen
6. Create a Web application client ID
7. Add authorized JavaScript origins (e.g., `http://localhost:3000` for development)
8. Add authorized redirect URIs (e.g., `http://localhost:3000` for development)
9. Copy the Client ID and use it in your `.env.local` file

## Running the Application

### Development Mode

```bash
npm run dev
```

The application will be available at `http://localhost:3000`.

### Production Build

```bash
npm run build
npm start
```

## Authentication Flow

1. User visits the application
2. If not authenticated, they are redirected to the login page
3. User clicks "Sign in with Google" and authenticates
4. Backend verifies the Google ID token and creates a JWT
5. Frontend stores the JWT for subsequent API requests
6. Access is restricted to the email specified in ALLOWED_EMAIL

## Using the Chat Interface

- Type messages in the text area at the bottom of the screen
- Press Enter to send (Shift+Enter for a new line)
- AI responses will stream in real-time
- Click "Clear Chat" to start a new conversation

## Integration with Neura Backend

This frontend connects to the Neura backend in two ways:

1. **REST API**: For authentication and session management
2. **WebSockets**: For real-time chat with streaming responses

Make sure the backend server is running before using this application.

## Project Structure

- `/app`: Next.js app router pages and layouts
- `/components`: React components
- `/hooks`: Custom React hooks
- `/public`: Static assets

## Security Considerations

- The Google Client ID is public but restricted by domain
- JWT tokens are stored in localStorage (clear cache/storage to log out completely)
- The application restricts access to the email specified in ALLOWED_EMAIL

## License

MIT
