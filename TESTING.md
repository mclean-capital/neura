# Testing Guide for Neura

This guide provides instructions for testing the Neura application's integration with Google's Gemini Live API.

## Prerequisites

Before testing, make sure you have:

1. Set up the project as described in the main [README.md](README.md)
2. Configured valid API keys and credentials
3. Created `.env.local` files for both backend and frontend
4. Started both backend and frontend servers

## Functional Testing Checklist

### 1. Authentication

- [ ] Visit `http://localhost:3000` and verify you're redirected to the login page
- [ ] Click "Sign in with Google" and authenticate with your Google account
- [ ] Verify that only the allowed email address can access the application
- [ ] Check that you stay logged in when refreshing the page
- [ ] Test the logout button and verify you're redirected to the login page

### 2. WebSocket Connection

- [ ] After logging in, verify the status indicator shows "Connected"
- [ ] If you stop the backend server, verify the status changes to "Disconnected"
- [ ] When restarting the backend, verify the connection is automatically restored

### 3. Chat Functionality

- [ ] Send a simple message like "Hello" and verify you get a response
- [ ] Verify the response is streamed in real-time, not delivered all at once
- [ ] Test the text area capabilities:
  - [ ] Enter key sends the message
  - [ ] Shift+Enter creates a new line
  - [ ] Text area expands to accommodate longer messages
- [ ] Verify the "Clear Chat" button works correctly

### 4. API Testing

#### Backend Endpoints

Test the following endpoints using a tool like curl, Postman, or Thunder Client:

**1. Health Check**

```bash
curl http://localhost:3001/health
```

Expected response: `{"status":"ok"}`

**2. Google Authentication (requires Google ID token)**

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"idToken":"your_google_id_token"}' \
  http://localhost:3001/api/auth/google
```

**3. Verify Auth Token**

```bash
curl -H "Authorization: Bearer your_jwt_token" \
  http://localhost:3001/api/auth/verify
```

#### WebSocket Testing

Using a WebSocket client like [websocat](https://github.com/vi/websocat):

```bash
websocat ws://localhost:3001?token=your_jwt_token
```

Then send a message:

```json
{ "type": "prompt", "content": "What is artificial intelligence?" }
```

## Performance Testing

- [ ] Send several messages in quick succession to test rate limiting
- [ ] Test with longer messages (multiple paragraphs)
- [ ] Test with complex questions requiring detailed responses
- [ ] Check memory usage of both frontend and backend during extended sessions

## Security Testing

- [ ] Try accessing the application with a non-allowed email address
- [ ] Try accessing API endpoints without authentication
- [ ] Try connecting to WebSocket without a valid token
- [ ] Check that the JWT token is securely stored and transmitted
- [ ] Verify that backend error messages don't expose sensitive information

## Browser Compatibility

Test the application in:

- [ ] Google Chrome
- [ ] Mozilla Firefox
- [ ] Microsoft Edge
- [ ] Safari
- [ ] Mobile browsers (Chrome for Android, Safari for iOS)

## Troubleshooting Common Issues

### Backend Issues

- **Cannot connect to Gemini API**: Check your `GEMINI_API_KEY` in the backend `.env.local` file
- **Authentication errors**: Verify Google OAuth credentials and redirect URIs
- **WebSocket connection failures**: Check for network issues or firewall blocks

### Frontend Issues

- **Google Sign-In not appearing**: Check the `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in frontend `.env.local`
- **WebSocket not connecting**: Verify the backend URL and ensure CORS is configured correctly
- **Token refresh issues**: Clear browser storage and try logging in again

## How to Report Issues

When reporting issues, please include:

1. The specific test case that failed
2. Browser and OS information
3. Console logs from browser and terminal
4. Steps to reproduce the issue
5. Expected vs. actual behavior

## Automated Testing

For future improvements, consider adding:

- Unit tests for backend services and API endpoints
- Integration tests for the WebSocket communication
- End-to-end tests for the complete user flow
