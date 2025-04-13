import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import config from "../config";
import { OAuth2Client } from "google-auth-library";

// Define a custom interface to extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: {
        email: string;
        name?: string;
        picture?: string;
      };
    }
  }
}

// Create Google OAuth client
const googleClient = new OAuth2Client(config.googleClientId);

/**
 * Verify Google ID token
 * @param token Google ID token
 * @returns User payload or null if invalid
 */
export async function verifyGoogleToken(token: string) {
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: config.googleClientId,
    });

    const payload = ticket.getPayload();
    if (!payload) {
      return null;
    }

    // Check if email is in the allowed list
    if (payload.email !== config.allowedEmail) {
      return null;
    }

    return {
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };
  } catch (error) {
    console.error("Error verifying Google token:", error);
    return null;
  }
}

/**
 * Generate JWT token for authenticated user
 * @param user User object
 * @returns JWT token
 */
export function generateToken(user: {
  email: string;
  name?: string;
  picture?: string;
}) {
  return jwt.sign(user, config.jwtSecret, {
    expiresIn: "7d", // Token expires in 7 days
  });
}

/**
 * Verify JWT token
 * @param token JWT token
 * @returns User payload or null if invalid
 */
export function verifyToken(token: string) {
  try {
    return jwt.verify(token, config.jwtSecret) as {
      email: string;
      name?: string;
      picture?: string;
    };
  } catch (error) {
    return null;
  }
}

/**
 * Express middleware to authenticate requests
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: "Invalid token" });
  }

  // Check if email is allowed
  if (payload.email !== config.allowedEmail) {
    return res.status(403).json({ error: "Access denied" });
  }

  // Attach user info to request
  req.user = payload;
  next();
}
