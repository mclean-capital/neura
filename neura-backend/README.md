# Neura Backend

A Node.js backend server for the Neura application, providing Gemini Live API integration with Google authentication.

## Features

- **Gemini Live API Integration**: Direct REST API integration with Google's Gemini Live API for AI-powered conversations
- **Streaming Responses**: WebSocket-based streaming of AI responses in real-time
- **Google Authentication**: Secure authentication using Google OAuth
- **Access Restriction**: Limit access to specific email addresses
- **Rate Limiting**: Prevent abuse with built-in rate limiting

## Prerequisites

- Node.js (v16+)
- npm or yarn
- Google Cloud account with API access
- Gemini API key
- Google OAuth credentials

## Setup

1. Clone the repository or download the source code
2. Install dependencies:

```bash
npm install
```

3. Create a `.env.local` file in the root directory based on `.env.example`:

```bash
# Server configuration
PORT=3001

# Google Gemini API
GEMINI_API_KEY=your_gemini_api_key_here

# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id_here
GOOGLE_CLIENT_SECRET=your_google_client_secret_here

# JWT Secret for session tokens
JWT_SECRET=your_strong_jwt_secret_key

# Allowed email (restrict access to only this email)
ALLOWED_EMAIL=your_email@gmail.com
```

## Getting API Keys

### Gemini API Key

1. Go to the [Google AI Studio](https://ai.google.dev/)
2. Sign in with your Google account
3. Navigate to the API keys section
4. Create a new API key and copy it

### Google OAuth Credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to "APIs & Services" > "Credentials"
4. Click "Create Credentials" > "OAuth client ID"
5. Set up the OAuth consent screen
6. Create a Web application client ID
7. Add authorized redirect URIs (e.g., `http://localhost:3000` for development)
8. Copy the Client ID and Client Secret

## Running the Server

### Development Mode

```bash
npm run dev
```

### Production Build

```bash
npm run build
npm start
```

## API Endpoints

| Endpoint           | Method | Description                       | Authentication Required |
| ------------------ | ------ | --------------------------------- | ----------------------- |
| `/api/auth/google` | POST   | Authenticate with Google ID token | No                      |
| `/api/auth/verify` | GET    | Verify authentication token       | Yes                     |
| `/health`          | GET    | Server health check               | No                      |

## WebSocket Connection

Connect to the WebSocket server at `ws://localhost:3001?token=YOUR_JWT_TOKEN`

### Message Format

**Request:**

```json
{
  "type": "prompt",
  "content": "Your message to Gemini here"
}
```

**Response:**

```json
{
  "type": "response",
  "content": "AI response text chunk",
  "done": false
}
```

**Final chunk:**

```json
{
  "type": "response",
  "content": "",
  "done": true
}
```

## Security Considerations

- Keep your API keys and secrets secure
- Use HTTPS in production
- The app restricts access to the email specified in ALLOWED_EMAIL
- JWT tokens expire after 7 days

## License

MIT
